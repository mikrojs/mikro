import {err, ok} from 'mikro/result'
import {describe, expect, it} from 'vitest'

import {createServerFromNative, type NativeHttpServerModule, ServerError} from '../server-impl.js'

/* ── Fake native:mikro/http_server ───────────────────────────────────────── */

interface CapturedResponse {
  id: number
  status: number
  headers: [string, string][]
  body?: Uint8Array
  streamed?: boolean
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

interface InjectOptions {
  method?: string
  url: string
  body?: Uint8Array
  headers?: Record<string, string>
  bodyTooLarge?: boolean
  contentLength?: number
}

function createFakeNative(opts: {startError?: ServerError; disconnectAfter?: number} = {}) {
  const {startError, disconnectAfter} = opts
  let started = false
  let nextId = 1
  const queue: Array<{closed: true} | Record<string, unknown>> = []
  let nextWaiter: ((d: never) => void) | undefined
  const headers = new Map<number, Map<string, string>>()
  const responses: CapturedResponse[] = []
  const responseWaiters = new Map<number, (r: CapturedResponse) => void>()
  const streams = new Map<
    number,
    {status: number; headers: [string, string][]; parts: Uint8Array[]; count: number}
  >()

  const deliver = (d: object) => {
    if (nextWaiter) {
      const w = nextWaiter
      nextWaiter = undefined
      w(d as never)
    } else {
      queue.push(d as never)
    }
  }

  const native: NativeHttpServerModule = {
    start: () => {
      if (startError) return err(startError)
      if (started) return err(ServerError.AlreadyListening())
      started = true
      return ok()
    },
    stop: () => {
      started = false
      deliver({closed: true})
    },
    nextRequest: () => {
      const d = queue.shift()
      if (d) return Promise.resolve(d as never)
      return new Promise((resolve) => {
        nextWaiter = resolve
      })
    },
    respond: (id, status, hdrs, body) => {
      capture({id, status, headers: hdrs, body})
    },
    respondStart: (id, status, hdrs) => {
      streams.set(id, {status, headers: hdrs, parts: [], count: 0})
      return Promise.resolve()
    },
    respondChunk: (id, data) => {
      const s = streams.get(id)!
      s.parts.push(data)
      s.count += 1
      return Promise.resolve(disconnectAfter === undefined || s.count <= disconnectAfter)
    },
    respondEnd: (id) => {
      const s = streams.get(id)!
      streams.delete(id)
      capture({id, status: s.status, headers: s.headers, body: concat(s.parts), streamed: true})
    },
    getHeader: (id, name) => headers.get(id)?.get(name.toLowerCase()),
  }

  function capture(r: CapturedResponse) {
    responses.push(r)
    const w = responseWaiters.get(r.id)
    if (w) {
      responseWaiters.delete(r.id)
      w(r)
    }
  }

  // Inject a request and resolve once the server responds to it.
  function inject(opts: InjectOptions): Promise<CapturedResponse> {
    const id = nextId++
    if (opts.headers) {
      const m = new Map<string, string>()
      for (const [k, v] of Object.entries(opts.headers)) m.set(k.toLowerCase(), v)
      headers.set(id, m)
    }
    const body = opts.body ?? new Uint8Array(0)
    deliver({
      id,
      method: opts.method ?? 'GET',
      url: opts.url,
      body,
      bodyTooLarge: opts.bodyTooLarge ?? false,
      contentLength: opts.contentLength ?? body.length,
    })
    const existing = responses.find((r) => r.id === id)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => responseWaiters.set(id, resolve))
  }

  return {native, inject, responses}
}

const decode = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : '')

/* ── Tests ─────────────────────────────────────────────────────────── */

describe('createServerFromNative', () => {
  it('serves a simple GET with a string body', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({status: 200, body: 'hello'}))
    expect(server.listen({port: 80}).ok).toBe(true)

    const res = await fake.inject({url: '/'})
    expect(res.status).toBe(200)
    expect(decode(res.body)).toBe('hello')
  })

  it('sends a bodyless response (e.g. a redirect) with no body arg', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({status: 303, headers: {location: '/'}}))
    server.listen({port: 80})

    // The native respond() must tolerate an undefined body — this is the JS
    // half of the bodyless-respond regression; the native guard is covered on
    // device.
    const res = await fake.inject({url: '/old'})
    expect(res.status).toBe(303)
    expect(res.body).toBeUndefined()
    expect(res.headers).toEqual([['location', '/']])
  })

  it('drops header names/values containing CR, LF, or NUL', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({
      status: 302,
      headers: {
        // An app reflecting untrusted input into a redirect target must not be
        // able to smuggle a second header through a CRLF.
        location: '/next\r\nSet-Cookie: admin=1',
        'x-clean': 'ok',
      },
    }))
    server.listen({port: 80})

    const res = await fake.inject({url: '/go'})
    expect(res.status).toBe(302)
    expect(res.headers).toEqual([['x-clean', 'ok']])
  })

  it('delivers method and url so the handler can route', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer((req) => {
      const path = req.url.split('?')[0]
      if (req.method === 'GET' && path?.startsWith('/hello/')) {
        return {status: 200, body: `Hello ${path.slice('/hello/'.length)}`}
      }
      return {status: 404, body: 'not found'}
    })
    server.listen({port: 80})

    const hit = await fake.inject({url: '/hello/ada?x=1'})
    expect(hit.status).toBe(200)
    expect(decode(hit.body)).toBe('Hello ada')

    const miss = await fake.inject({url: '/nope'})
    expect(miss.status).toBe(404)
  })

  it('reads a POST JSON body in an async handler', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(async (req) => {
      const parsed = await req.json()
      if (!parsed.ok) return {status: 400, body: 'bad json'}
      const {name} = parsed.value as {name: string}
      return {status: 201, headers: {'content-type': 'application/json'}, body: `{"hi":"${name}"}`}
    })
    server.listen({port: 80})

    const res = await fake.inject({
      method: 'POST',
      url: '/users',
      body: new TextEncoder().encode('{"name":"ada"}'),
      headers: {'content-type': 'application/json'},
    })
    expect(res.status).toBe(201)
    expect(decode(res.body)).toBe('{"hi":"ada"}')
    expect(res.headers).toEqual([['content-type', 'application/json']])
  })

  it('exposes lazy headers.get / getAll', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    let auth: string | undefined
    let missing: string[] = []
    const server = createServer((req) => {
      auth = req.headers.get('Authorization')
      missing = req.headers.getAll('X-Absent')
      return {status: 200}
    })
    server.listen({port: 80})

    await fake.inject({url: '/', headers: {authorization: 'Bearer t0ken'}})
    expect(auth).toBe('Bearer t0ken')
    expect(missing).toEqual([])
  })

  it('streams an async-generator body chunk-by-chunk', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    async function* gen() {
      yield 'a'
      yield '' // empty chunk is skipped
      yield 'b'
      yield new Uint8Array([99]) // 'c'
    }
    const server = createServer(() => ({status: 200, body: gen()}))
    server.listen({port: 80})

    const res = await fake.inject({url: '/stream'})
    expect(res.streamed).toBe(true)
    expect(res.status).toBe(200)
    expect(decode(res.body)).toBe('abc')
  })

  it('stops pulling the generator when the client disconnects', async () => {
    const fake = createFakeNative({disconnectAfter: 2})
    const createServer = createServerFromNative(fake.native)
    let pulled = 0
    async function* gen() {
      for (let i = 0; i < 100; i++) {
        pulled++
        yield `chunk${i}`
      }
    }
    const server = createServer(() => ({status: 200, body: gen()}))
    server.listen({port: 80})

    await fake.inject({url: '/stream'})
    // The 3rd respondChunk returns false (client gone), so the loop breaks after
    // pulling that chunk — far short of the generator's 100 iterations.
    expect(pulled).toBe(3)
  })

  it('truncates cleanly when the generator throws mid-stream', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    async function* gen() {
      yield 'partial'
      throw new Error('mid-stream boom')
    }
    const server = createServer(() => ({status: 200, body: gen()}))
    server.listen({port: 80})

    const res = await fake.inject({url: '/stream'})
    expect(res.streamed).toBe(true)
    expect(decode(res.body)).toBe('partial')
  })

  it('normalizes Record response headers to tuples', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({
      status: 200,
      headers: {'x-a': '1', 'x-b': '2'},
      body: 'ok',
    }))
    server.listen({port: 80})

    const res = await fake.inject({url: '/'})
    expect(res.headers).toEqual([
      ['x-a', '1'],
      ['x-b', '2'],
    ])
  })

  it('returns BodyTooLarge when the body exceeded the cap', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    let bodyErr: {name: string} | undefined
    const server = createServer(
      async (req) => {
        const r = await req.bytes()
        if (!r.ok) bodyErr = r.error
        return {status: 200}
      },
      {maxBodySize: 8},
    )
    server.listen({port: 80})

    await fake.inject({url: '/upload', bodyTooLarge: true, contentLength: 1024})
    expect(bodyErr?.name).toBe('BodyTooLarge')
  })

  it('responds 500 when a handler throws', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => {
      throw new Error('boom')
    })
    server.listen({port: 80})

    const res = await fake.inject({url: '/'})
    expect(res.status).toBe(500)
    expect(decode(res.body)).toBe('Internal Server Error')
  })

  it('invokes onPanic with the error and request, sending its response', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    let seenError: unknown
    let seenUrl: string | undefined
    const server = createServer(
      () => {
        throw new Error('boom')
      },
      {
        onPanic: (error, req) => {
          seenError = error
          seenUrl = req.url
          return {status: 503, body: 'try later'}
        },
      },
    )
    server.listen({port: 80})

    const res = await fake.inject({url: '/widgets'})
    expect((seenError as Error).message).toBe('boom')
    expect(seenUrl).toBe('/widgets')
    expect(res.status).toBe(503)
    expect(decode(res.body)).toBe('try later')
  })

  it('falls back to 500 when onPanic returns nothing or itself throws', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(
      () => {
        throw new Error('boom')
      },
      {
        onPanic: () => {
          throw new Error('hook bug')
        },
      },
    )
    server.listen({port: 80})

    const res = await fake.inject({url: '/'})
    expect(res.status).toBe(500)
  })

  it('isolates a handler throw and keeps serving', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    let n = 0
    const server = createServer(() => {
      n++
      if (n === 1) throw new Error('boom')
      return {status: 200, body: 'recovered'}
    })
    server.listen({port: 80})

    const first = await fake.inject({url: '/'})
    expect(first.status).toBe(500)
    const second = await fake.inject({url: '/'})
    expect(decode(second.body)).toBe('recovered')
  })

  it('returns AlreadyListening on a second listen()', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({status: 200}))
    expect(server.listen({port: 80}).ok).toBe(true)
    const again = server.listen({port: 80})
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.name).toBe('AlreadyListening')
  })

  it('propagates a native start failure', async () => {
    const fake = createFakeNative({startError: ServerError.StartFailed('port in use')})
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({status: 200}))
    const r = server.listen({port: 80})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('StartFailed')
  })

  it('close() stops the serve loop without leaking respond calls', async () => {
    const fake = createFakeNative()
    const createServer = createServerFromNative(fake.native)
    const server = createServer(() => ({status: 200}))
    server.listen({port: 80})
    server.close()
    await Promise.resolve()
    expect(fake.responses.length).toBe(0)
  })
})

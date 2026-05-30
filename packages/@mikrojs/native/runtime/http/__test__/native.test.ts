import {err, ok} from 'mikro/result'
import {describe, expect, it} from 'vitest'

import {RequestError} from '../helpers.js'
import {createRequestFromNative, type NativeHttpModule} from '../native.js'

/* ── Fake native:http builder ──────────────────────────────────────── */

type Msg =
  | {kind: 'chunk'; data: Uint8Array}
  | {kind: 'end'}
  | {kind: 'error'; cancelled: boolean; message: string}

interface FakeScript {
  headers?: {status: number; headers: [string, string][]}
  headersError?: RequestError
  messages: Msg[]
  startError?: RequestError
  headersPendingUntilCancel?: boolean
}

type HeadersResult =
  | {ok: true; value: {status: number; headers: [string, string][]}}
  | {ok: false; error: RequestError}

function createFakeNative(script: FakeScript): NativeHttpModule & {cancelCalls: number[]} {
  let nextId = 1
  const cancelCalls: number[] = []
  const queues = new Map<number, Msg[]>()
  const pending = new Map<number, (m: Msg) => void>()
  const headersCancelResolvers = new Map<number, (v: HeadersResult) => void>()

  const deliver = (id: number, m: Msg) => {
    const waiter = pending.get(id)
    if (waiter) {
      pending.delete(id)
      waiter(m)
    } else {
      const q = queues.get(id) ?? []
      q.push(m)
      queues.set(id, q)
    }
  }

  return {
    cancelCalls,
    pendingCount: () => 0,
    request(_url, _opts) {
      if (script.startError)
        return err(script.startError) as ReturnType<NativeHttpModule['request']>
      const id = nextId++
      queues.set(id, [])
      void Promise.resolve().then(() => {
        for (const m of script.messages) deliver(id, m)
      })

      let headersPromise: Promise<HeadersResult>
      if (script.headersError) {
        headersPromise = Promise.resolve(err(script.headersError) as HeadersResult)
      } else if (script.headersPendingUntilCancel) {
        headersPromise = new Promise<HeadersResult>((resolve) => {
          headersCancelResolvers.set(id, resolve)
        })
      } else {
        const h = script.headers ?? {status: 200, headers: []}
        headersPromise = Promise.resolve(ok(h) as HeadersResult)
      }
      return {ok: true as const, id, headers: headersPromise} as ReturnType<
        NativeHttpModule['request']
      >
    },
    async nextMessage(id) {
      const q = queues.get(id) ?? []
      const next = q.shift()
      if (next !== undefined) return next
      return new Promise<Msg>((resolve) => {
        pending.set(id, resolve)
      })
    },
    cancel(id) {
      cancelCalls.push(id)
      const hr = headersCancelResolvers.get(id)
      if (hr) {
        headersCancelResolvers.delete(id)
        hr(err(RequestError.Aborted('cancelled')) as HeadersResult)
      }
      void Promise.resolve().then(() =>
        deliver(id, {kind: 'error', cancelled: true, message: 'cancelled'}),
      )
    },
  }
}

/* ── Tests ─────────────────────────────────────────────────────────── */

describe('createRequestFromNative', () => {
  it('resolves a buffered single-chunk response via text()', async () => {
    const native = createFakeNative({
      headers: {status: 200, headers: [['Content-Type', 'text/plain']]},
      messages: [{kind: 'chunk', data: new TextEncoder().encode('hello')}, {kind: 'end'}],
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe(200)
      const text = await result.value.text()
      expect(text.ok).toBe(true)
      if (text.ok) expect(text.value).toBe('hello')
    }
  })

  it('streams multiple chunks through the async iterable', async () => {
    const native = createFakeNative({
      messages: [
        {kind: 'chunk', data: new Uint8Array([1, 2])},
        {kind: 'chunk', data: new Uint8Array([3, 4])},
        {kind: 'chunk', data: new Uint8Array([5])},
        {kind: 'end'},
      ],
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const collected: number[] = []
      for await (const chunk of result.value.body) {
        expect(chunk.ok).toBe(true)
        if (chunk.ok) collected.push(...chunk.value)
      }
      expect(collected).toEqual([1, 2, 3, 4, 5])
    }
  })

  it('propagates cancel when iterator is broken via return()', async () => {
    const native = createFakeNative({
      messages: [
        {kind: 'chunk', data: new Uint8Array([1])},
        {kind: 'chunk', data: new Uint8Array([2])},
        {kind: 'end'},
      ],
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(true)
    if (result.ok) {
      for await (const chunk of result.value.body) {
        expect(chunk.ok).toBe(true)
        if (chunk.ok) expect(chunk.value[0]).toBe(1)
        break
      }
      expect(native.cancelCalls.length).toBe(1)
    }
  })

  it('yields a Network err item mid-stream when transport reports error', async () => {
    const native = createFakeNative({
      messages: [
        {kind: 'chunk', data: new Uint8Array([1, 2])},
        {kind: 'error', cancelled: false, message: 'connection reset by peer'},
      ],
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const pulled: number[] = []
      let finalErr: RequestError | undefined
      for await (const chunk of result.value.body) {
        if (chunk.ok) pulled.push(...chunk.value)
        else finalErr = chunk.error
      }
      expect(pulled).toEqual([1, 2])
      expect(finalErr).toMatchObject({name: 'Network', message: 'connection reset by peer'})
    }
  })

  it('returns TooManyPending when native layer rejects at start', async () => {
    const native = createFakeNative({
      messages: [],
      startError: RequestError.TooManyPending(),
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('TooManyPending')
  })

  it('surfaces ERROR-before-HEADERS as a Network failure at the request() level', async () => {
    const native = createFakeNative({
      messages: [],
      headersError: RequestError.Network('DNS resolution failed'),
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe('Network')
      if (result.error.name === 'Network') {
        expect(result.error.message).toBe('DNS resolution failed')
      }
    }
  })

  it('maps pre-headers cancelled error to Aborted', async () => {
    const native = createFakeNative({
      messages: [],
      headersError: RequestError.Aborted('cancelled'),
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('Aborted')
  })

  it('cancels via AbortSignal before request starts', async () => {
    const controller = new AbortController()
    const native = createFakeNative({messages: [{kind: 'end'}]})
    const request = createRequestFromNative(native)

    controller.abort()
    const result = await request('https://example.test/', {signal: controller.signal})

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('Aborted')
  })

  it('cancels via AbortSignal while awaiting headers', async () => {
    const controller = new AbortController()
    const native = createFakeNative({
      messages: [],
      headersPendingUntilCancel: true,
    })
    const request = createRequestFromNative(native)

    const promise = request('https://example.test/', {signal: controller.signal})
    await Promise.resolve()
    controller.abort()
    const result = await promise

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('Aborted')
    expect(native.cancelCalls.length).toBe(1)
  })

  it('cancels via AbortSignal during body iteration', async () => {
    const controller = new AbortController()
    const native = createFakeNative({
      messages: [{kind: 'chunk', data: new Uint8Array([1])}],
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/', {signal: controller.signal})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const pulled: number[] = []
      let finalErr: RequestError | undefined
      const promise = (async () => {
        for await (const c of result.value.body) {
          if (c.ok) pulled.push(...c.value)
          else finalErr = c.error
        }
      })()
      await Promise.resolve()
      await Promise.resolve()
      controller.abort()
      await promise
      expect(native.cancelCalls.length).toBeGreaterThan(0)
      expect(finalErr).toMatchObject({name: 'Aborted'})
    }
  })

  it('enforces timeoutMs during body iteration by firing cancel', async () => {
    const native = createFakeNative({messages: []})
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/', {timeoutMs: 10})
    expect(result.ok).toBe(true)
    if (result.ok) {
      let finalErr: RequestError | undefined
      for await (const c of result.value.body) {
        if (!c.ok) finalErr = c.error
      }
      expect(finalErr).toMatchObject({name: 'Aborted'})
      expect(native.cancelCalls.length).toBe(1)
    }
  })

  it('enforces timeoutMs before headers arrive', async () => {
    const native = createFakeNative({
      messages: [],
      headersPendingUntilCancel: true,
    })
    const request = createRequestFromNative(native)

    const result = await request('https://example.test/', {timeoutMs: 10})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('Aborted')
    expect(native.cancelCalls.length).toBe(1)
  })

  it('uppercases the method', async () => {
    const native = createFakeNative({messages: [{kind: 'end'}]})
    let capturedMethod: string | undefined
    const wrapped: NativeHttpModule = {
      ...native,
      request(url, opts) {
        capturedMethod = opts?.method
        return native.request(url, opts)
      },
    }
    const request = createRequestFromNative(wrapped)

    await request('https://example.test/', {method: 'post'})
    expect(capturedMethod).toBe('POST')
  })
})

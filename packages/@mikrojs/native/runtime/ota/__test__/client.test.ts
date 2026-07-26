import {
  makeResponse,
  type RequestError,
  type RequestOptions,
  type Response,
} from 'mikro/http/helpers'
import {err, ok} from 'mikro/result'
import {describe, expect, it, vi} from 'vitest'

import type {Result} from '../../result/types.js'
import type {DeviceName} from '../../sys/types.js'
import {
  type ClientIo,
  createOtaClient,
  isPrivateHttp,
  nameFrom,
  sameOrigin,
  type Teardown,
  type WatchOptions,
} from '../client-impl.js'
import {parseOffer} from '../policy.js'
import type {ApplyOutcome, InstallOptions, InstallOutcome, OtaError, Update} from '../types.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

const REGISTRY = 'https://reg.example'
const CHECKIN = `${REGISTRY}/api/v1/checkin`
const offerBody = {
  url: `${REGISTRY}/builds/app-2.tgz`,
  checksum: 'abc123def456xyz',
  size: 1024,
}

type Handler = (
  url: string,
  options: RequestOptions | undefined,
) => Promise<Result<Response, RequestError>> | Result<Response, RequestError>

/** A canned response with real bytes()/close() semantics via makeResponse. */
function response(opts: {
  status?: number
  body?: unknown
  chunks?: Uint8Array[]
  onRelease?: () => void
}): Result<Response, RequestError> {
  const chunks = opts.chunks ?? [enc.encode(JSON.stringify(opts.body ?? {}))]
  let i = 0
  const raw: AsyncIterable<Result<Uint8Array, RequestError>> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (i < chunks.length) return {done: false as const, value: ok(chunks[i++]!)}
        opts.onRelease?.()
        return {done: true as const, value: undefined}
      },
      return: async () => {
        opts.onRelease?.()
        return {done: true as const, value: undefined}
      },
    }),
  }
  return ok(
    makeResponse({
      status: opts.status ?? 200,
      statusText: '',
      url: 'https://reg.example/x',
      redirected: false,
      headers: [],
      body: raw,
    }),
  )
}

function deferred<T = void>(): {promise: Promise<T>; resolve: (value: T) => void} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return {promise, resolve}
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await flush()
  if (!cond()) throw new Error('condition not reached')
}

interface HarnessOptions {
  registry?: string | undefined
  bearer?: string | undefined
  running?: {checksum?: string; version?: string; trial: boolean}
  reconcile?: InstallOutcome
  storageFree?: number | undefined
  resumeOffset?: number
  handlers?: Handler[]
  apply?: (
    offer: unknown,
    download: (update: Update) => Promise<Result<void, {message: string}>>,
    options?: InstallOptions,
  ) => Promise<Result<ApplyOutcome, OtaError>>
  random?: () => number
}

function harness(opts: HarnessOptions = {}) {
  const events: string[] = []
  const logs: Array<[string, string, ...unknown[]]> = []
  const requests: Array<{url: string; options: RequestOptions | undefined}> = []
  const writes: Uint8Array[] = []
  const names: DeviceName[] = []
  const sleeps: Array<{ms: number; resolve: () => void}> = []
  const handlers = [...(opts.handlers ?? [])]
  let applyOptions: InstallOptions | undefined
  let reconcileCalls = 0
  let confirmCalls = 0

  const registry = 'registry' in opts ? opts.registry : REGISTRY
  const bearer = 'bearer' in opts ? opts.bearer : 'duk_secret'
  const running = opts.running ?? {checksum: 'oldsum', version: '1.0.0', trial: false}

  const defaultApply: NonNullable<HarnessOptions['apply']> = async (_offer, download, options) => {
    applyOptions = options
    const update: Update = {
      resumeOffset: opts.resumeOffset ?? 0,
      write: (bytes) => {
        writes.push(bytes)
        return ok()
      },
      finish: () => ok(),
      abort: () => undefined,
    }
    const downloaded = await download(update)
    if (!downloaded.ok) {
      return err({name: 'DownloadFailed' as const, message: downloaded.error.message})
    }
    return ok('staged' as const)
  }

  const io: ClientIo = {
    sleep: (ms) => new Promise((resolve) => sleeps.push({ms, resolve})),
    request: async (url, options) => {
      requests.push({url, options})
      events.push('request')
      const handler = handlers.shift()
      if (!handler) throw new Error(`unexpected request to ${url}`)
      return handler(url, options)
    },
    random: opts.random ?? (() => 0.5),
    log: (level, format, ...args) => logs.push([level, format, ...args]),
    encode: (value) => ok(enc.encode(JSON.stringify(value))),
    decode: (data) => {
      try {
        return ok(JSON.parse(dec.decode(data)) as unknown)
      } catch (e) {
        return err({name: 'DecodeFailed' as const, message: String(e)})
      }
    },
    ota: {
      reconcile: () => {
        reconcileCalls++
        return opts.reconcile ?? {reverted: false}
      },
      running: () => ({...running}),
      parseOffer,
      applyOffer: async (offer, download, options) => {
        events.push('apply')
        return (opts.apply ?? defaultApply)(offer, download, options)
      },
      confirm: () => {
        confirmCalls++
        events.push('confirm')
      },
      revert: () => ok(),
      bearer: () => bearer,
      registry: () => registry,
    },
    identity: () => ({deviceId: 'dev-1', firmware: '0.16.0', firmwareHash: 'fwhash', bytecode: 42}),
    storageFree: () => ('storageFree' in opts ? opts.storageFree : 900_000),
    deviceName: () => ({rev: 1, name: 'shed'}),
    setDeviceName: (name) => names.push(name),
    restart: vi.fn(() => {
      events.push('restart')
    }) as unknown as () => never,
  }

  const client = createOtaClient(io)
  const releaseSleep = async (): Promise<void> => {
    await until(() => sleeps.length > 0)
    sleeps.shift()!.resolve()
    await flush()
  }
  const sentBody = (index = 0): Record<string, unknown> =>
    JSON.parse(dec.decode(requests[index]!.options!.body as Uint8Array)) as Record<string, unknown>
  const headersOf = (index: number): Record<string, string> =>
    (requests[index]!.options?.headers ?? {}) as Record<string, string>

  return {
    client,
    io,
    events,
    logs,
    requests,
    writes,
    names,
    sleeps,
    releaseSleep,
    sentBody,
    headersOf,
    get applyOptions() {
      return applyOptions
    },
    get reconcileCalls() {
      return reconcileCalls
    },
    get confirmCalls() {
      return confirmCalls
    },
  }
}

describe('check', () => {
  it('posts the CBOR-encoded report and returns up-to-date on an empty answer', async () => {
    const h = harness({handlers: [() => response({body: {}})]})
    const result = await h.client.check()
    expect(result).toEqual({status: 'up-to-date'})
    expect(h.requests[0]!.url).toBe(CHECKIN)
    expect(h.requests[0]!.options?.method).toBe('POST')
    expect(h.headersOf(0)).toMatchObject({
      'content-type': 'application/cbor',
      accept: 'application/cbor',
      authorization: 'Bearer duk_secret',
    })
    expect(h.sentBody()).toMatchObject({
      deviceId: 'dev-1',
      firmware: '0.16.0',
      firmwareHash: 'fwhash',
      bytecode: 42,
      running: {checksum: 'oldsum', version: '1.0.0', trial: false},
      name: [1, 'shed'],
      free: 900_000,
    })
    expect(h.confirmCalls).toBe(1)
  })

  it('omits free from the report when the platform cannot say', async () => {
    const h = harness({storageFree: undefined, handlers: [() => response({body: {}})]})
    await h.client.check()
    expect('free' in h.sentBody()).toBe(false)
  })

  it('adopts a name the registry sends down', async () => {
    const h = harness({handlers: [() => response({body: {name: [2, 'kitchen']}})]})
    await h.client.check()
    expect(h.names).toEqual([{rev: 2, name: 'kitchen'}])
  })

  it('adopts a cleared name as [rev] only', async () => {
    const h = harness({handlers: [() => response({body: {name: [3]}})]})
    await h.client.check()
    expect(h.names).toEqual([{rev: 3}])
  })

  it('confirms a running trial before applying the offer', async () => {
    const h = harness({
      running: {checksum: 'oldsum', trial: true},
      handlers: [() => response({body: offerBody}), () => response({chunks: [new Uint8Array(8)]})],
    })
    const result = await h.client.check()
    expect(result.status).toBe('staged')
    expect(h.events.indexOf('confirm')).toBeLessThan(h.events.indexOf('apply'))
  })

  it('stages an offered build and returns the offer', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
    const h = harness({
      handlers: [() => response({body: offerBody}), () => response({chunks})],
    })
    const result = await h.client.check()
    expect(result).toEqual({status: 'staged', offer: offerBody})
    expect(h.writes).toEqual(chunks)
    // requireConfirm defaults on; trialBoots defaults to 1
    expect(h.applyOptions).toEqual({requireConfirm: true, trialBoots: 1})
  })

  it('reports a declined offer as not-staged with the policy reason', async () => {
    const h = harness({
      handlers: [() => response({body: offerBody})],
      apply: async () => ok('current' as const),
    })
    expect(await h.client.check()).toEqual({status: 'not-staged', reason: 'current'})
  })

  it('reports a failed download as not-staged with the error', async () => {
    const h = harness({
      handlers: [
        () => response({body: offerBody}),
        () => err({name: 'Network', message: 'link dropped'} as RequestError),
      ],
    })
    const result = await h.client.check()
    expect(result.status).toBe('not-staged')
    if (result.status === 'not-staged') {
      expect(result.reason).toBe('download-failed')
      expect(result.error).toMatchObject({name: 'DownloadFailed'})
    }
  })

  it('returns failed and does not confirm when the check-in never completes', async () => {
    const h = harness({
      running: {trial: true},
      handlers: [() => err({name: 'Timeout', message: 'deadline'} as RequestError)],
    })
    const result = await h.client.check()
    expect(result).toEqual({status: 'failed', error: {name: 'Timeout', message: 'deadline'}})
    expect(h.confirmCalls).toBe(0)
  })

  it('returns unauthorized on a 401 and releases the connection', async () => {
    const onRelease = vi.fn()
    const h = harness({
      running: {trial: true},
      handlers: [() => response({status: 401, onRelease})],
    })
    expect(await h.client.check()).toEqual({status: 'unauthorized'})
    expect(h.confirmCalls).toBe(0)
    expect(onRelease).toHaveBeenCalled()
  })

  it('fails loudly on a 415: the wire is CBOR-only', async () => {
    const h = harness({handlers: [() => response({status: 415})]})
    expect(await h.client.check()).toEqual({status: 'failed', error: {name: 'Status', status: 415}})
    expect(h.logs.some(([, format]) => format.includes('does not accept CBOR'))).toBe(true)
  })

  it('fails on any other non-2xx status', async () => {
    const h = harness({handlers: [() => response({status: 500})]})
    expect(await h.client.check()).toEqual({status: 'failed', error: {name: 'Status', status: 500}})
  })

  it('fails on an undecodable response body', async () => {
    const h = harness({handlers: [() => response({chunks: [enc.encode('not json')]})]})
    const result = await h.client.check()
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.error.name).toBe('DecodeFailed')
  })

  it('returns not-enrolled without touching the network', async () => {
    const h = harness({registry: undefined})
    expect(await h.client.check()).toEqual({status: 'not-enrolled'})
    expect(h.requests).toHaveLength(0)
  })

  it('reconciles once per boot and holds lastInstall until a check-in completes', async () => {
    const lastInstall = {reason: 'ota_install_failed', detail: 'corrupt'}
    const h = harness({
      reconcile: {reverted: false, lastInstall},
      handlers: [
        () => err({name: 'Network', message: 'down'} as RequestError),
        () => response({body: {}}),
        () => response({body: {}}),
      ],
    })
    await h.client.check() // failed: report must not be lost
    await h.client.check() // delivered here
    await h.client.check() // gone now
    expect(h.reconcileCalls).toBe(1)
    expect(h.sentBody(0).lastInstall).toEqual(lastInstall)
    expect(h.sentBody(1).lastInstall).toEqual(lastInstall)
    expect('lastInstall' in h.sentBody(2)).toBe(false)
  })

  it('serializes overlapping checks', async () => {
    const gate = deferred()
    let active = 0
    let maxActive = 0
    const track = async (): Promise<Result<Response, RequestError>> => {
      active++
      maxActive = Math.max(maxActive, active)
      await gate.promise
      active--
      return response({body: {}})
    }
    const h = harness({handlers: [track, track]})
    const first = h.client.check()
    const second = h.client.check()
    await until(() => h.requests.length === 1)
    gate.resolve()
    expect((await first).status).toBe('up-to-date')
    expect((await second).status).toBe('up-to-date')
    expect(maxActive).toBe(1)
  })

  it('warns once per boot when the registry is private http', async () => {
    const h = harness({
      registry: 'http://192.168.1.10:4873',
      handlers: [() => response({body: {}}), () => response({body: {}})],
    })
    await h.client.check()
    await h.client.check()
    const warns = h.logs.filter(([, format]) => format.includes('NOT authenticated'))
    expect(warns).toHaveLength(1)
  })

  it('accepts an http offer from a private-http registry', async () => {
    const httpOffer = {...offerBody, url: 'http://192.168.1.10:4873/builds/app-2.tgz'}
    const h = harness({
      registry: 'http://192.168.1.10:4873',
      handlers: [() => response({body: httpOffer}), () => response({chunks: [new Uint8Array(4)]})],
    })
    expect((await h.client.check()).status).toBe('staged')
  })
})

describe('check: download', () => {
  it('resumes with a Range request and writes only the new bytes on 206', async () => {
    const chunks = [new Uint8Array([9, 9])]
    const h = harness({
      resumeOffset: 512,
      handlers: [() => response({body: offerBody}), () => response({status: 206, chunks})],
    })
    expect((await h.client.check()).status).toBe('staged')
    expect(h.headersOf(1).range).toBe('bytes=512-')
    expect(h.writes).toEqual(chunks)
  })

  it('skips the already-staged prefix when a resume is answered with a 200', async () => {
    const full = new Uint8Array(1024).map((_, i) => i % 256)
    const h = harness({
      resumeOffset: 512,
      handlers: [
        () => response({body: offerBody}),
        // one chunk covering the whole build, plus a chunk boundary inside the prefix
        () => response({status: 200, chunks: [full.subarray(0, 100), full.subarray(100)]}),
      ],
    })
    expect((await h.client.check()).status).toBe('staged')
    const written = h.writes.reduce((n, w) => n + w.length, 0)
    expect(written).toBe(512)
    expect(h.writes[0]).toEqual(full.subarray(512))
  })

  it('re-verifies without a request when the staged bytes are already complete', async () => {
    const h = harness({
      resumeOffset: 1024,
      handlers: [() => response({body: offerBody})],
    })
    expect((await h.client.check()).status).toBe('staged')
    expect(h.requests).toHaveLength(1) // the check-in only
  })

  it('sends the update key only to the registry origin', async () => {
    const h = harness({
      handlers: [() => response({body: offerBody}), () => response({chunks: [new Uint8Array(1)]})],
    })
    await h.client.check()
    expect(h.headersOf(1).authorization).toBe('Bearer duk_secret')

    const cdnOffer = {...offerBody, url: 'https://cdn.example/builds/app-2.tgz'}
    const h2 = harness({
      handlers: [() => response({body: cdnOffer}), () => response({chunks: [new Uint8Array(1)]})],
    })
    await h2.client.check()
    expect(h2.headersOf(1).authorization).toBeUndefined()
  })
})

describe('watch', () => {
  const fast: WatchOptions = {initialDelayMs: 0}

  it('is inert on an un-enrolled device', async () => {
    const h = harness({registry: undefined})
    const watcher = h.client.watch()
    await flush()
    expect(h.sleeps).toHaveLength(0)
    expect(h.logs.some(([, format]) => format.includes('not enrolled'))).toBe(true)
    watcher.stop()
  })

  it('waits the full interval after a clean round', async () => {
    const h = harness({handlers: [() => response({body: {}})]})
    const watcher = h.client.watch()
    expect(h.sleeps[0]!.ms).toBe(5_000) // initial delay, jitter pinned to 1.0
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(h.sleeps[0]!.ms).toBe(30 * 60_000)
    watcher.stop()
  })

  it('retries sooner after a failed round', async () => {
    const h = harness({
      handlers: [() => err({name: 'Network', message: 'down'} as RequestError)],
    })
    const watcher = h.client.watch(fast)
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(h.sleeps[0]!.ms).toBe(60_000)
    watcher.stop()
  })

  it('backs off to the full interval on a dead update key', async () => {
    const h = harness({handlers: [() => response({status: 401})]})
    const watcher = h.client.watch(fast)
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(h.sleeps[0]!.ms).toBe(30 * 60_000)
    watcher.stop()
  })

  it('jitters every scheduled sleep by ±10%', async () => {
    const low = harness({random: () => 0})
    const lowWatcher = low.client.watch({initialDelayMs: 10_000})
    expect(low.sleeps[0]!.ms).toBe(9_000)
    lowWatcher.stop()

    const high = harness({random: () => 1})
    const highWatcher = high.client.watch({initialDelayMs: 10_000})
    expect(high.sleeps[0]!.ms).toBe(11_000)
    highWatcher.stop()
  })

  it('sleeps the exact interval with jitter: false', async () => {
    const h = harness({random: () => 1, handlers: [() => response({body: {}})]})
    const watcher = h.client.watch({initialDelayMs: 10_000, jitter: false})
    expect(h.sleeps[0]!.ms).toBe(10_000)
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(h.sleeps[0]!.ms).toBe(30 * 60_000)
    watcher.stop()
  })

  it('skips the round and retries sooner when beforeCheck fails', async () => {
    const h = harness()
    const watcher = h.client.watch({...fast, beforeCheck: async () => err('no wifi')})
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(h.requests).toHaveLength(0)
    expect(h.sleeps[0]!.ms).toBe(60_000)
    expect(h.logs.some(([, format]) => format.includes('beforeCheck failed'))).toBe(true)
    watcher.stop()
  })

  it('runs the teardown after the round, even when the check crashes', async () => {
    const order: string[] = []
    const h = harness({
      handlers: [
        () => {
          order.push('check')
          throw new Error('boom')
        },
      ],
    })
    const teardown: Teardown = () => {
      order.push('teardown')
    }
    const watcher = h.client.watch({
      ...fast,
      beforeCheck: async () => {
        order.push('before')
        return ok(teardown)
      },
    })
    await h.releaseSleep()
    await until(() => h.sleeps.length > 0)
    expect(order).toEqual(['before', 'check', 'teardown'])
    expect(h.logs.some(([, format]) => format.includes('check crashed'))).toBe(true)
    // the loop survived: the next round is scheduled at the retry interval
    expect(h.sleeps[0]!.ms).toBe(60_000)
    watcher.stop()
  })

  it('restarts after staging, with the teardown run first', async () => {
    const h = harness({
      handlers: [() => response({body: offerBody}), () => response({chunks: [new Uint8Array(2)]})],
    })
    const order: string[] = []
    const watcher = h.client.watch({
      ...fast,
      beforeCheck: async () => ok(() => void order.push('teardown')),
    })
    await h.releaseSleep()
    await until(() => h.events.includes('restart'))
    // teardown ran, and it ran before the restart fired
    expect(order).toEqual(['teardown'])
    watcher.stop()
  })

  it('defers the restart when stop() was called during the round', async () => {
    const gate = deferred()
    const h = harness({
      handlers: [
        async () => {
          await gate.promise
          return response({body: offerBody})
        },
        () => response({chunks: [new Uint8Array(2)]}),
      ],
    })
    const watcher = h.client.watch(fast)
    await h.releaseSleep()
    await until(() => h.requests.length === 1)
    watcher.stop()
    gate.resolve()
    await until(() => h.logs.some(([, format]) => format.includes('restart deferred')))
    expect(h.events).not.toContain('restart')
  })
})

describe('pure helpers', () => {
  it('nameFrom reads the pair, rejects junk, and treats absence as no change', () => {
    expect(nameFrom({name: [2, 'kitchen']})).toEqual({rev: 2, name: 'kitchen'})
    expect(nameFrom({name: [4]})).toEqual({rev: 4})
    expect(nameFrom({name: [4, '']})).toEqual({rev: 4})
    expect(nameFrom({})).toBeUndefined()
    expect(nameFrom({name: 'kitchen'})).toBeUndefined()
    expect(nameFrom({name: [-1, 'x']})).toBeUndefined()
    expect(nameFrom(null)).toBeUndefined()
  })

  it('sameOrigin compares scheme and authority literally', () => {
    expect(sameOrigin('https://reg.example/a.tgz', 'https://reg.example')).toBe(true)
    expect(sameOrigin('https://REG.example/a.tgz', 'https://reg.example')).toBe(true)
    expect(sameOrigin('https://reg.example:443/a.tgz', 'https://reg.example')).toBe(false)
    expect(sameOrigin('http://reg.example/a.tgz', 'https://reg.example')).toBe(false)
    expect(sameOrigin('not-a-url', 'https://reg.example')).toBe(false)
  })

  it('isPrivateHttp accepts only LAN/loopback/mDNS http', () => {
    expect(isPrivateHttp('http://192.168.1.10:4873')).toBe(true)
    expect(isPrivateHttp('http://10.0.0.1')).toBe(true)
    expect(isPrivateHttp('http://172.16.0.1')).toBe(true)
    expect(isPrivateHttp('http://localhost:3000')).toBe(true)
    expect(isPrivateHttp('http://registry.local')).toBe(true)
    expect(isPrivateHttp('http://8.8.8.8')).toBe(false)
    expect(isPrivateHttp('http://example.com')).toBe(false)
    expect(isPrivateHttp('https://192.168.1.10')).toBe(false)
  })
})

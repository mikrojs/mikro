import {of} from 'rxjs'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import type {ReadyEvent} from '../session.js'

const kvSet = vi.fn()
const remember = vi.fn()
const close = vi.fn()
let ready: ReadyEvent

vi.mock('../serial/openSession.js', () => ({
  openSession: () =>
    Promise.resolve({
      session: {awaitReady$: () => of(ready), kv: {set: kvSet}},
      close,
    }),
}))

vi.mock('../deviceCache.js', () => ({
  rememberDeviceForPort: (...args: unknown[]) => remember(...args),
  getCachedDeviceId: () => undefined,
  getCachedName: () => undefined,
  getCachedNameByDeviceId: () => undefined,
}))

const {runPostFlash} = await import('../postFlash.js')

function readyEvent(over: Partial<ReadyEvent> = {}): ReadyEvent {
  return {type: 'ready', chip: 'esp32c6', id: 'abc123', version: '1.0.0', ...over}
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runPostFlash name seeding', () => {
  it('seeds a name at revision 1 when the device has never been named', async () => {
    ready = readyEvent()
    const result = await runPostFlash('/dev/tty.usb')

    expect(result.seeded).toBe(true)
    expect(kvSet).toHaveBeenCalledTimes(1)
    const [key, encoded, ns] = kvSet.mock.calls[0] as [string, string, string]
    expect(key).toBe('name')
    expect(ns).toBe('sys')
    expect(JSON.parse(encoded)).toEqual([1, result.name])
    expect(result.name).toBeTypeOf('string')
  })

  it('leaves an already-named device alone', async () => {
    ready = readyEvent({name: 'swift-otter', nameRev: 4})
    const result = await runPostFlash('/dev/tty.usb')

    expect(result.seeded).toBe(false)
    expect(result.name).toBe('swift-otter')
    expect(kvSet).not.toHaveBeenCalled()
  })

  // Reflashing must not undo `mikro name unset`. A cleared name is rev > 0 with
  // no name; re-seeding would resurrect it *and* outrank the registry's
  // revision, pushing the dead name back over the fleet on the next check-in.
  it('does not resurrect a name the user explicitly cleared', async () => {
    ready = readyEvent({name: undefined, nameRev: 7})
    const result = await runPostFlash('/dev/tty.usb')

    expect(result.seeded).toBe(false)
    expect(result.name).toBeUndefined()
    expect(kvSet).not.toHaveBeenCalled()
    expect(remember).toHaveBeenCalledWith('/dev/tty.usb', {
      chip: 'esp32c6',
      deviceId: 'abc123',
      // null, not undefined: the handshake reported no name, and that has to
      // clear a stale cache entry rather than leave it standing.
      name: null,
    })
  })

  it('treats firmware that reports no revision as never named', async () => {
    ready = readyEvent({name: undefined, nameRev: undefined})
    const result = await runPostFlash('/dev/tty.usb')

    expect(result.seeded).toBe(true)
    expect(kvSet).toHaveBeenCalledTimes(1)
  })

  // An unreadable name pair reports the same rev 0 / no name as never-named,
  // so without the corrupt flag this seeds over a name that is actually set —
  // at revision 1, which then loses to a registry holding the real revision.
  it('does not seed over a stored name it could not read', async () => {
    ready = readyEvent({name: undefined, nameRev: 0, nameCorrupt: true})
    const result = await runPostFlash('/dev/tty.usb')

    expect(result.seeded).toBe(false)
    expect(result.nameUnreadable).toBe(true)
    expect(kvSet).not.toHaveBeenCalled()
  })

  it('closes the session even when the handshake throws', async () => {
    ready = readyEvent()
    kvSet.mockRejectedValueOnce(new Error('device went away'))

    await expect(runPostFlash('/dev/tty.usb')).rejects.toThrow('device went away')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

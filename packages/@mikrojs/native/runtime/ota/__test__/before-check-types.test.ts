import {err, ok} from 'mikro/result'
import {describe, expect, it} from 'vitest'

import type {Result} from '../../result/types.js'
import type {BeforeCheckResult, WatchOptions} from '../types.js'

// The hook's shapes are the whole point of this file: it is a type test with a
// token assertion, because every form below is one an app should be able to
// write without ceremony, and a narrowed return type would break them silently.

declare const wifi: {
  connect(options: {ssid: string}): Promise<Result<void, {name: string}>>
  disconnect(): Result<void, {name: string}>
}

describe('beforeCheck accepts what an app naturally writes', () => {
  it('takes a bare teardown, a returned err, and everything between', () => {
    // The common shape: hand the failure straight back, or the teardown
    // straight back. No ok() around the happy path, no void around a teardown
    // that returns something.
    const natural: WatchOptions = {
      beforeCheck: async () => {
        const connected = await wifi.connect({ssid: 'net'})
        if (!connected.ok) return connected
        return () => wifi.disconnect()
      },
    }

    const shapes: WatchOptions[] = [
      natural,
      // Wrapping in a Result still works, for code that prefers it.
      {beforeCheck: async () => ok(() => wifi.disconnect())},
      {beforeCheck: async () => ok(undefined)},
      // Skipping the round.
      {beforeCheck: async () => err('no wifi')},
      // Nothing to tear down.
      {beforeCheck: async () => undefined},
      // Synchronous hooks need no promise.
      {beforeCheck: () => () => wifi.disconnect()},
      // A teardown that returns nothing, which is what void-ing one produces.
      {beforeCheck: () => () => void wifi.disconnect()},
    ]
    expect(shapes).toHaveLength(7)
  })

  it('names every accepted shape in one type', () => {
    const results: BeforeCheckResult[] = [
      () => wifi.disconnect(),
      () => undefined,
      undefined,
      ok(undefined),
      ok(() => wifi.disconnect()),
      err('no wifi'),
    ]
    expect(results).toHaveLength(6)
  })
})

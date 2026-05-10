import {Observable} from 'native:observable'

import type {Subscriber} from './types.js'

/* Lazy-attach Observable: native.on is only called once a JS subscriber
 * appears, and native.off runs when the last one unsubscribes. Code paths
 * that import the host module (wifi/ble/...) but don't subscribe take the
 * exact same internal-RAM path as before observables existed — important
 * because mbedTLS handshake needs ~16 KB contiguous internal SRAM and each
 * eager closure pinned at module load chips into that headroom. */

interface NativeEventSource {
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
}

export function lazyEvent<T>(source: NativeEventSource, eventName: string): Observable<T> {
  const subscribers: Subscriber<T>[] = []
  function handler(value: unknown): void {
    /* Snapshot so unsubscribes during dispatch don't shift indices. */
    const snapshot = subscribers.slice()
    for (const s of snapshot) {
      if (!s.closed) s.next(value as T)
    }
  }
  return new Observable<T>((sub) => {
    subscribers.push(sub)
    if (subscribers.length === 1) {
      source.on(eventName, handler)
    }
    sub.addTeardown(() => {
      const i = subscribers.indexOf(sub)
      if (i >= 0) subscribers.splice(i, 1)
      if (subscribers.length === 0) {
        source.off(eventName, handler)
      }
    })
  })
}

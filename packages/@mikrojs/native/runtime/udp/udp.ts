import {ok} from 'mikro/result'
import {Observable} from 'native:mikro/observable'
import {bind as nativeBind, type NativeUdpSocket} from 'native:mikro/udp'

import type {Subscriber} from '../observable/types.js'
import type {Result} from '../result/types.js'
import type {BindOptions, MulticastGroup, UdpError, UdpMessage, UdpSocket} from './types.js'

const utf8 = new TextEncoder()

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8.encode(data) : data
}

function makeSocket(handle: NativeUdpSocket): UdpSocket {
  /* Lazy native attach: keep handle.setOnMessage in sync with whether any
   * JS subscriber is listening. With zero subscribers, the native side
   * skips JS dispatch and increments the dropped counter for inbound
   * packets — preserving the pre-Observable behavior of unset onMessage
   * silently discarding traffic. */
  const subscribers: Subscriber<UdpMessage>[] = []
  let closed = false

  const onMessage = new Observable<UdpMessage>((sub) => {
    if (closed) {
      sub.complete()
      return
    }
    subscribers.push(sub)
    if (subscribers.length === 1) {
      handle.setOnMessage((msg, from) => {
        /* Snapshot so unsubscribes during dispatch don't shift indices. */
        const snapshot = subscribers.slice()
        for (const s of snapshot) {
          if (!s.closed) s.next({msg, from})
        }
      })
    }
    sub.addTeardown(() => {
      const i = subscribers.indexOf(sub)
      if (i >= 0) subscribers.splice(i, 1)
      if (subscribers.length === 0 && !closed) {
        handle.setOnMessage(null)
      }
    })
  })

  const sock: UdpSocket = {
    get port() {
      return handle.port
    },
    get family() {
      return handle.family
    },
    get dropped() {
      return handle.dropped
    },
    set dropped(value: number) {
      handle.dropped = value
    },
    onMessage,
    send(data, to) {
      return handle.send(toBytes(data), to)
    },
    joinMulticastGroup(group: MulticastGroup) {
      return handle.joinMulticastGroup(group.address)
    },
    leaveMulticastGroup(group: MulticastGroup) {
      return handle.leaveMulticastGroup(group.address)
    },
    close() {
      if (closed) return
      closed = true
      handle.setOnMessage(null)
      /* Complete any active subscriptions. Walk a snapshot in case a
       * complete handler unsubscribes a sibling. */
      const snapshot = subscribers.slice()
      subscribers.length = 0
      for (const s of snapshot) {
        if (!s.closed) s.complete()
      }
      handle.close()
    },
  }

  return sock
}

export async function bind(opts: BindOptions): Promise<Result<UdpSocket, UdpError>> {
  const result = await nativeBind(opts)
  if (!result.ok) return result
  return ok(makeSocket(result.value))
}

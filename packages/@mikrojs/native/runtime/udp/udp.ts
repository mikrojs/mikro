import {ok} from 'mikrojs/result'
import {bind as nativeBind, type NativeUdpSocket} from 'native:udp'

import type {Result} from '../result/types.js'
import type {BindOptions, MulticastGroup, PeerAddress, UdpError, UdpSocket} from './types.js'

const utf8 = new TextEncoder()

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8.encode(data) : data
}

function makeSocket(handle: NativeUdpSocket): UdpSocket {
  let onMessage: ((msg: Uint8Array, from: PeerAddress) => void) | null = null

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
    get onMessage() {
      return onMessage
    },
    set onMessage(fn) {
      onMessage = fn
      handle.setOnMessage(fn)
    },
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

import type {Result} from '../result/types.js'

export type UdpFamily = 'ipv4' | 'ipv6'

export interface BindOptions {
  port: number
  address?: string
  family?: UdpFamily
  recvQueue?: number
}

export interface PeerAddress {
  address: string
  port: number
  family: UdpFamily
}

export interface MulticastGroup {
  address: string
}

export type UdpError =
  | {name: 'BindFailed'; message: string}
  | {name: 'AddressInUse'}
  | {name: 'SendFailed'; message: string}
  | {name: 'MessageTooLarge'}
  | {name: 'NotReachable'}
  | {name: 'OutOfMemory'}
  | {name: 'JoinGroupFailed'; message: string}
  | {name: 'LeaveGroupFailed'; message: string}
  | {name: 'Closed'}
  | {name: 'NotBound'}

export interface UdpSocket {
  readonly port: number
  readonly family: UdpFamily | 'dual'
  /**
   * Counter incremented each time an inbound datagram is dropped:
   * - the per-socket queue is full,
   * - no `onMessage` handler is set when a packet arrives,
   * - or the datagram is larger than the 1500-byte receive buffer
   *   (typical Ethernet MTU; covers CoAP / mDNS / SNTP / DNS).
   */
  dropped: number

  onMessage: ((msg: Uint8Array, from: PeerAddress) => void) | null

  send(data: Uint8Array | string, to: PeerAddress): Promise<Result<void, UdpError>>
  joinMulticastGroup(group: MulticastGroup): Result<void, UdpError>
  leaveMulticastGroup(group: MulticastGroup): Result<void, UdpError>
  close(): void
}

export declare function bind(opts: BindOptions): Promise<Result<UdpSocket, UdpError>>

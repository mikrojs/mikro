import type {Result} from '../result/types.js'

/** Advertising interval range in milliseconds. */
export interface AdvertiseInterval {
  /** Minimum interval. Non-connectable: ≥ 20ms. Connectable: ≥ 100ms. */
  min: number
  /** Maximum interval. ≤ 10240ms. Must be ≥ min. */
  max: number
}

/**
 * A property that a GATT characteristic exposes. The set of declared properties
 * determines which operations centrals can perform.
 */
export type CharacteristicProperty =
  | 'read'
  | 'write'
  | 'writeWithoutResponse'
  | 'notify'
  | 'indicate'

/**
 * A GATT characteristic declaration. The `uuid` is either a 16-bit shorthand
 * (`"180f"`) or a full 128-bit form (`"6e400001-b5a3-f393-e0a9-e50e24dcca9e"`).
 */
export interface Characteristic {
  uuid: string
  properties: readonly CharacteristicProperty[]
  /**
   * Initial value for the characteristic. Updated via `handle.setValue()` at
   * runtime. When a central performs a GATT read, it sees the current value.
   */
  value?: Uint8Array
  /**
   * Called after a central writes to this characteristic. Runs asynchronously
   * on the JS loop thread after the write has already been acknowledged at
   * the GATT layer — it is advisory only and cannot reject the write. The
   * only accepted `writeMode` is `'advisory'`, which is also the default.
   */
  onWrite?: (value: Uint8Array) => void
  /**
   * Only `'advisory'` is accepted. Advisory writes are acknowledged at the
   * GATT layer before `onWrite` runs, so the handler cannot reject the write.
   */
  writeMode?: 'advisory'
  /**
   * Only `'open'` is accepted. Characteristics are accessible without
   * authentication or encryption.
   */
  security?: 'open'
}

/** A GATT service declaration containing one or more characteristics. */
export interface Service {
  uuid: string
  characteristics: Characteristic[]
}

export interface AdvertiseOptions {
  /** Device name included in the advertising packet. Defaults to `ble.name`. */
  name?: string
  /**
   * Whether centrals can connect to the advertising device. Defaults to
   * `false` (broadcaster mode). Set to `true` together with `services` to
   * run a connectable GATT peripheral.
   */
  connectable?: boolean
  /**
   * GATT services to register on the peripheral. Services are declared
   * upfront and frozen for the lifetime of the BLE stack — to change them,
   * call `ble.stop()` and `advertise()` again.
   */
  services?: Service[]
  /** Advertising interval range. Defaults to NimBLE's defaults (~100–150ms). */
  interval?: AdvertiseInterval
  /**
   * Include the current TX power as a 3-byte field in the advertising payload.
   * Useful for RSSI-based distance estimation.
   */
  includeTxPower?: boolean
  /**
   * Manufacturer-specific data bytes. The first two bytes must be the company ID
   * (little-endian) per the BLE spec.
   */
  manufacturerData?: Uint8Array
}

export interface AdvertiseHandle {
  /** Stops this advertising session. Does not tear down the BLE stack. */
  stop(): Result<void, BleError>
  /**
   * Updates the cached value of a characteristic. Subsequent GATT reads by
   * connected centrals will return the new bytes. Does not push updates to
   * subscribers. Use `notify()` to both update and push in one call, or
   * call `setValue()` followed by `notify()` if you want explicit control.
   *
   * Returns `err(NoSuchCharacteristic)` if either UUID is unknown.
   */
  setValue(
    serviceUuid: string,
    characteristicUuid: string,
    value: Uint8Array,
  ): Result<void, BleError>
  /**
   * Sends a notification with the given bytes to every currently-subscribed
   * central. The characteristic must declare `'notify'` in its properties,
   * and centrals must have enabled notifications via the CCCD descriptor.
   *
   * If no central is subscribed, this is a silent no-op and returns ok.
   * If the payload exceeds the minimum MTU across active subscribers minus
   * the 3-byte ATT header, returns `err(ValueTooLarge)` without sending.
   * Per-subscriber send failures (backpressure, dropped connection) are
   * logged at warn level and do not cause this call to return an error;
   * notify is explicitly best-effort.
   *
   * This also updates the characteristic's cached value so subsequent
   * reads return the notified bytes.
   */
  notify(serviceUuid: string, characteristicUuid: string, value: Uint8Array): Result<void, BleError>
}

export type BleError =
  | {name: 'StackInitFailed'; message: string}
  | {name: 'ControllerInitFailed'; message: string}
  | {name: 'AlreadyAdvertising'}
  | {name: 'NotInitialized'}
  | {name: 'AdvertiseStartFailed'; message: string}
  | {name: 'AdvertiseStopFailed'; message: string}
  | {name: 'AdvertisingPayloadTooLarge'; bytes: number; max: number}
  | {name: 'InvalidInterval'; min: number; max: number}
  | {name: 'InvalidUuid'; value: string}
  | {name: 'DuplicateCharacteristic'; uuid: string}
  | {name: 'InvalidProperties'; uuid: string; reason: string}
  | {name: 'GattRegistrationFailed'; message: string}
  | {name: 'GattAlreadyRegistered'}
  | {name: 'NoSuchCharacteristic'; uuid: string}
  | {name: 'NotConnected'}
  | {name: 'ValueTooLarge'; uuid: string; bytes: number; max: number}
  | {name: 'NotifyFailed'; message: string}
  | {name: 'StackShutdown'}
  | {name: 'SetFailed'; message: string}
  | {name: 'GetFailed'; message: string}

export interface Ble {
  /** Device name used in advertising. Defaults to `"mikrojs-xxxxxx"` (last 3 bytes of MAC). */
  name: string
  /** Global radio TX power in dBm. Valid range depends on the chip. */
  txPower: number
  /** BLE MAC address as `"aa:bb:cc:dd:ee:ff"`. */
  readonly address: string
  /**
   * Tears down the BLE stack entirely, reclaiming all RAM.
   * The next BLE call re-initializes from scratch.
   */
  stop(): Result<void, BleError>
}

/** Information about a connected central. */
export interface ConnectionInfo {
  /** Opaque stable identifier for this connection (NimBLE conn_handle). */
  id: number
  /** The peer's BLE address in canonical `"aa:bb:cc:dd:ee:ff"` form. */
  address: string
  /** Current negotiated ATT MTU in bytes. */
  mtu: number
}

/** Information about a mid-session MTU change. */
export interface MtuInfo {
  id: number
  mtu: number
}

export interface PeripheralEventMap {
  connect: (info: ConnectionInfo) => void
  disconnect: (info: ConnectionInfo) => void
  mtu: (info: MtuInfo) => void
}

export interface Peripheral {
  /** Start advertising. Returns a handle whose `stop()` ends this session. */
  advertise(options?: AdvertiseOptions): Promise<Result<AdvertiseHandle, BleError>>
  /**
   * Register a listener for a peripheral lifecycle event. Listeners are
   * called on the JS loop thread in registration order. Safe to register
   * before calling `advertise()`.
   */
  on<K extends keyof PeripheralEventMap>(event: K, listener: PeripheralEventMap[K]): void
  /** Remove a previously-registered listener. */
  off<K extends keyof PeripheralEventMap>(event: K, listener: PeripheralEventMap[K]): void
}

export declare const ble: Ble
export declare const peripheral: Peripheral

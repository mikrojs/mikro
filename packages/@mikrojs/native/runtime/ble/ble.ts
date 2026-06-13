import {lazyEvent} from 'mikro/observable/lazy'
import {err, ok} from 'mikro/result'
import {Ble as NativeBle} from 'native:mikro/ble'

import type {Result} from '../result/types.js'
import type {
  AdvertiseHandle,
  AdvertiseOptions,
  Ble,
  BleError,
  Characteristic,
  CharacteristicProperty,
  ConnectionInfo,
  MtuInfo,
  Peripheral,
  Service,
} from './types.js'
import {parseUuid} from './uuid.js'
import {ADV_PAYLOAD_MAX, computeAdvertisingPayloadSize, validateInterval} from './validators.js'

// Inline constructors for the JS-side validated variants (native:mikro/ble doesn't
// emit these — they come from validateInterval, validateServices, and the
// advertise payload-size check). Kept as `const` factories so validators.ts
// can stay decoupled from the BleError shape for unit testing.
const invalidIntervalFactory = {
  InvalidInterval: (min: number, max: number) => ({name: 'InvalidInterval' as const, min, max}),
  AdvertisingPayloadTooLarge: (bytes: number, max: number) => ({
    name: 'AdvertisingPayloadTooLarge' as const,
    bytes,
    max,
  }),
}

// ── Characteristic property bitmask (must match native side) ────────
// Native code reads these as BLE_GATT_CHR_F_* flags via a lookup table.
const PROP_READ = 0x01
const PROP_WRITE = 0x02
const PROP_WRITE_WITHOUT_RESPONSE = 0x04
const PROP_NOTIFY = 0x08
const PROP_INDICATE = 0x10

const PROP_BY_NAME: Record<CharacteristicProperty, number> = {
  read: PROP_READ,
  write: PROP_WRITE,
  writeWithoutResponse: PROP_WRITE_WITHOUT_RESPONSE,
  notify: PROP_NOTIFY,
  indicate: PROP_INDICATE,
}

function propertiesToBitmask(props: readonly CharacteristicProperty[]): number {
  let mask = 0
  for (const p of props) mask |= PROP_BY_NAME[p] ?? 0
  return mask
}

// ── Service/characteristic validation ───────────────────────────────

function invalidProps(uuid: string, reason: string): BleError {
  return {name: 'InvalidProperties', uuid, reason}
}

function validateCharacteristic(char: Characteristic): BleError | undefined {
  if (parseUuid(char.uuid) === null) return {name: 'InvalidUuid', value: char.uuid}

  if (!Array.isArray(char.properties) || char.properties.length === 0) {
    return invalidProps(char.uuid, 'at least one property required')
  }
  // Array.isArray widens readonly arrays to any[]; cast back for the lookup.
  const props = char.properties as readonly CharacteristicProperty[]
  for (const p of props) {
    if (PROP_BY_NAME[p] === undefined) {
      return invalidProps(char.uuid, `unknown property: ${String(p)}`)
    }
  }

  if (char.writeMode !== undefined && char.writeMode !== 'advisory') {
    return invalidProps(
      char.uuid,
      `writeMode '${String(char.writeMode)}' is not supported in this release`,
    )
  }
  if (char.security !== undefined && char.security !== 'open') {
    return invalidProps(
      char.uuid,
      `security '${String(char.security)}' is not supported in this release`,
    )
  }

  return undefined
}

function validateService(service: Service): BleError | undefined {
  if (parseUuid(service.uuid) === null) return {name: 'InvalidUuid', value: service.uuid}

  if (!Array.isArray(service.characteristics) || service.characteristics.length === 0) {
    return invalidProps(service.uuid, 'service must declare at least one characteristic')
  }

  const seen = new Set<string>()
  for (const char of service.characteristics) {
    const charErr = validateCharacteristic(char)
    if (charErr) return charErr
    const normalized = parseUuid(char.uuid)!.normalized
    if (seen.has(normalized)) return {name: 'DuplicateCharacteristic', uuid: normalized}
    seen.add(normalized)
  }

  return undefined
}

function validateServices(services: Service[]): BleError | undefined {
  const seen = new Set<string>()
  for (const service of services) {
    const svcErr = validateService(service)
    if (svcErr) return svcErr
    const normalized = parseUuid(service.uuid)!.normalized
    if (seen.has(normalized)) return invalidProps(service.uuid, 'duplicate service uuid')
    seen.add(normalized)
  }
  return undefined
}

/**
 * Converts the user-facing `Service[]` shape into the normalized form the
 * native module expects: property arrays become bitmasks, UUIDs are
 * normalized to their canonical lowercase form so that subsequent
 * setValue / notify calls can use the same UUID strings in any case and
 * still match what's registered. The `onWrite` callback is passed through
 * as-is; the native side dup-refs it during GATT registration.
 */
function normalizeServices(services: Service[]) {
  return services.map((s) => ({
    uuid: parseUuid(s.uuid)!.normalized,
    characteristics: s.characteristics.map((c) => ({
      uuid: parseUuid(c.uuid)!.normalized,
      properties: propertiesToBitmask(c.properties),
      value: c.value,
      onWrite: c.onWrite,
    })),
  }))
}

const native = new NativeBle()

const ble: Ble = {
  get name(): string {
    return native.getName()
  },
  set name(value: string) {
    native.setName(value)
  },

  get address(): string {
    const result = native.getAddress()
    return result.ok ? result.value : ''
  },

  get txPower(): number {
    const result = native.getTxPower()
    return result.ok ? result.value : 0
  },
  set txPower(dbm: number) {
    native.setTxPower(dbm)
  },

  stop(): Result<void, BleError> {
    return native.stop()
  },
}

const peripheral: Peripheral = {
  async advertise(options: AdvertiseOptions = {}): Promise<Result<AdvertiseHandle, BleError>> {
    const intervalError = validateInterval(options.interval, invalidIntervalFactory)
    if (intervalError) return err(intervalError)

    if (options.services !== undefined) {
      const svcErr = validateServices(options.services)
      if (svcErr) return err(svcErr)
    }

    const payloadSize = computeAdvertisingPayloadSize(options, native.getName().length)
    if (payloadSize > ADV_PAYLOAD_MAX) {
      return err(invalidIntervalFactory.AdvertisingPayloadTooLarge(payloadSize, ADV_PAYLOAD_MAX))
    }

    const nativeOptions = {
      ...options,
      services: options.services ? normalizeServices(options.services) : undefined,
    }

    const result = native.advertise(nativeOptions as Parameters<typeof native.advertise>[0])
    if (!result.ok) return result

    const handle: AdvertiseHandle = {
      stop(): Result<void, BleError> {
        return native.stopAdvertising()
      },
      setValue(
        serviceUuid: string,
        characteristicUuid: string,
        value: Uint8Array,
      ): Result<void, BleError> {
        const svc = parseUuid(serviceUuid)
        if (!svc) return err({name: 'InvalidUuid' as const, value: serviceUuid})
        const chr = parseUuid(characteristicUuid)
        if (!chr) return err({name: 'InvalidUuid' as const, value: characteristicUuid})
        return native.setValue(svc.normalized, chr.normalized, value)
      },
      notify(
        serviceUuid: string,
        characteristicUuid: string,
        value: Uint8Array,
      ): Result<void, BleError> {
        const svc = parseUuid(serviceUuid)
        if (!svc) return err({name: 'InvalidUuid' as const, value: serviceUuid})
        const chr = parseUuid(characteristicUuid)
        if (!chr) return err({name: 'InvalidUuid' as const, value: characteristicUuid})
        return native.notify(svc.normalized, chr.normalized, value)
      },
    }
    return ok(handle)
  },

  onConnect: lazyEvent<ConnectionInfo>(native, 'connect'),
  onDisconnect: lazyEvent<ConnectionInfo>(native, 'disconnect'),
  onMtu: lazyEvent<MtuInfo>(native, 'mtu'),
}

export {ble, peripheral}

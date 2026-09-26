// Bosch BME280 temperature, humidity and pressure sensor over I2C: a pure JS
// driver on mikro/i2c. The compensation follows the floating-point formulas
// in section 8.1 of the BME280 datasheet.
import {I2c, type I2cError} from 'mikro/i2c'
import {err, ok, type Result} from 'mikro/result'

export interface Bme280Options {
  /** I2C controller. */
  bus: number
  sda: number
  scl: number
  /** 0x76 (SDO to GND, the default) or 0x77 (SDO to VDDIO). */
  address?: number
}

export interface Reading {
  /** Degrees Celsius. */
  temperature: number
  /** Relative humidity in percent. */
  humidity: number
  /** Pascal. */
  pressure: number
}

export type Bme280Error = I2cError | {name: 'Bme280Error'; message: string}

export interface Bme280 {
  read(): Result<Reading, Bme280Error>
  end(): void
}

const CHIP_ID = 0x60
const REG_CHIP_ID = 0xd0
const REG_CALIB_TP = 0x88
const REG_CALIB_H1 = 0xa1
const REG_CALIB_H = 0xe1
const REG_CTRL_HUM = 0xf2
const REG_CTRL_MEAS = 0xf4
const REG_CONFIG = 0xf5
const REG_DATA = 0xf7

interface Calibration {
  t: [number, number, number]
  p: [number, number, number, number, number, number, number, number, number]
  h: [number, number, number, number, number, number]
}

function readRegisters(
  i2c: I2c,
  address: number,
  register: number,
  bytes: number,
): Result<DataView, I2cError> {
  const written = i2c.write(address, Uint8Array.of(register), false)
  if (!written.ok) return written
  const read = i2c.read(address, bytes)
  if (!read.ok) return read
  return ok(new DataView(read.value.buffer, read.value.byteOffset, read.value.byteLength))
}

function writeRegister(
  i2c: I2c,
  address: number,
  register: number,
  value: number,
): Result<void, I2cError> {
  return i2c.write(address, Uint8Array.of(register, value))
}

function readCalibration(i2c: I2c, address: number): Result<Calibration, I2cError> {
  const tp = readRegisters(i2c, address, REG_CALIB_TP, 24)
  if (!tp.ok) return tp
  const h1 = readRegisters(i2c, address, REG_CALIB_H1, 1)
  if (!h1.ok) return h1
  const h = readRegisters(i2c, address, REG_CALIB_H, 7)
  if (!h.ok) return h
  const v = tp.value
  const e5 = h.value.getUint8(4)
  return ok({
    t: [v.getUint16(0, true), v.getInt16(2, true), v.getInt16(4, true)],
    p: [
      v.getUint16(6, true),
      v.getInt16(8, true),
      v.getInt16(10, true),
      v.getInt16(12, true),
      v.getInt16(14, true),
      v.getInt16(16, true),
      v.getInt16(18, true),
      v.getInt16(20, true),
      v.getInt16(22, true),
    ],
    h: [
      h1.value.getUint8(0),
      h.value.getInt16(0, true),
      h.value.getUint8(2),
      // H4 and H5 are 12-bit values that share the byte at 0xE5.
      (h.value.getInt8(3) << 4) | (e5 & 0x0f),
      (h.value.getInt8(5) << 4) | (e5 >> 4),
      h.value.getInt8(6),
    ],
  })
}

// Not exported: apps create a Bme280 with the factory below. The factory's
// return type makes sure that the class matches the Bme280 interface.
class Bme280Sensor {
  #i2c: I2c
  #address: number
  #calibration: Calibration

  constructor(i2c: I2c, address: number, calibration: Calibration) {
    this.#i2c = i2c
    this.#address = address
    this.#calibration = calibration
  }

  read(): Result<Reading, Bme280Error> {
    const data = readRegisters(this.#i2c, this.#address, REG_DATA, 8)
    if (!data.ok) return data
    const d = data.value
    const adcP = (d.getUint8(0) << 12) | (d.getUint8(1) << 4) | (d.getUint8(2) >> 4)
    const adcT = (d.getUint8(3) << 12) | (d.getUint8(4) << 4) | (d.getUint8(5) >> 4)
    const adcH = (d.getUint8(6) << 8) | d.getUint8(7)
    const {t, p, h} = this.#calibration

    const t1 = (adcT / 16384 - t[0] / 1024) * t[1]
    const t2 = (adcT / 131072 - t[0] / 8192) ** 2 * t[2]
    const tFine = t1 + t2

    let p1 = tFine / 2 - 64000
    let p2 = (p1 * p1 * p[5]) / 32768 + p1 * p[4] * 2
    p2 = p2 / 4 + p[3] * 65536
    p1 = ((p[2] * p1 * p1) / 524288 + p[1] * p1) / 524288
    p1 = (1 + p1 / 32768) * p[0]
    let pressure = 0
    if (p1 !== 0) {
      pressure = ((1048576 - adcP - p2 / 4096) * 6250) / p1
      pressure +=
        ((p[8] * pressure * pressure) / 2147483648 + (pressure * p[7]) / 32768 + p[6]) / 16
    }

    let humidity = tFine - 76800
    humidity =
      (adcH - (h[3] * 64 + (h[4] / 16384) * humidity)) *
      ((h[1] / 65536) * (1 + (h[5] / 67108864) * humidity * (1 + (h[2] / 67108864) * humidity)))
    humidity *= 1 - (h[0] * humidity) / 524288

    return ok({
      temperature: tFine / 5120,
      humidity: Math.min(100, Math.max(0, humidity)),
      pressure,
    })
  }

  end(): void {
    this.#i2c.end()
  }
}

/** Starts the I2C bus, checks that a BME280 answers, and starts measuring once a second. */
export function Bme280(options: Bme280Options): Result<Bme280, Bme280Error> {
  const address = options.address ?? 0x76
  const bus = I2c(options.bus, {sda: options.sda, scl: options.scl})
  if (!bus.ok) return bus
  const i2c = bus.value

  const id = readRegisters(i2c, address, REG_CHIP_ID, 1)
  if (!id.ok) {
    i2c.end()
    return id
  }
  if (id.value.getUint8(0) !== CHIP_ID) {
    i2c.end()
    const found = id.value.getUint8(0).toString(16)
    return err({
      name: 'Bme280Error' as const,
      message: `no BME280 at 0x${address.toString(16)} (chip ID 0x${found})`,
    })
  }

  const calibration = readCalibration(i2c, address)
  if (!calibration.ok) {
    i2c.end()
    return calibration
  }
  // Humidity oversampling x1 (applied when ctrl_meas is written), standby
  // 1000 ms, then temperature and pressure oversampling x1 in normal mode.
  const setup = [
    [REG_CTRL_HUM, 0x01],
    [REG_CONFIG, 0xa0],
    [REG_CTRL_MEAS, 0x27],
  ] as const
  for (const [register, value] of setup) {
    const written = writeRegister(i2c, address, register, value)
    if (!written.ok) {
      i2c.end()
      return written
    }
  }
  return ok(new Bme280Sensor(i2c, address, calibration.value))
}

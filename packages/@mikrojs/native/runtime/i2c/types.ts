/* mikro/i2c, declared here and implemented in C (mik_i2c.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

/**
 * @public
 */
export interface I2cOptions {
  sda: number
  scl: number
  /** Clock frequency in Hz. Defaults to 100000. */
  freq?: number
  /** Timeout per operation in ms. Defaults to 100. */
  timeout?: number
}

export type I2cError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'BusInitFailed'; message: string}
  | {name: 'AddDeviceFailed'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'WriteTooLarge'}
  | {name: 'ReadFailed'; message: string}

/**
 * @public
 */
export interface I2c {
  /** Reads `bytes` bytes from the device at `address`. */
  read(address: number, bytes: number): Result<Uint8Array, I2cError>
  /** Writes `data` to the device at `address`. Pass `stop: false` to follow with a read that
   *  uses a repeated start. */
  write(address: number, data: Uint8Array, stop?: boolean): Result<void, I2cError>
  /** Addresses that answered a probe. */
  scan(): Result<Uint8Array, I2cError>
  /** Deletes the bus and releases its GPIO pins. Calling it again does nothing. Afterwards
   *  `write()` does nothing and reads return an empty array; the first such call prints a
   *  warning. */
  end(): void
}

/**
 * Claims the pins and starts an I2C bus on a controller.
 * @public
 */
export declare function I2c(bus: number, options: I2cOptions): Result<I2c, I2cError>

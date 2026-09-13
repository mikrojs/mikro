/* mikro/spi, declared here and implemented in C (mik_spi.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

/**
 * @public
 */
export interface SpiOptions {
  clk: number
  mosi: number
  miso?: number
  cs?: number
  freq?: number
  mode?: 0 | 1 | 2 | 3
}

export type SpiError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'BusInitFailed'; message: string}
  | {name: 'AddDeviceFailed'; message: string}
  | {name: 'TransferFailed'; message: string}
  | {name: 'WriteFailed'; message: string}

/**
 * @public
 */
export interface Spi {
  /** Full-duplex transfer: sends `data` and returns the bytes received at the same time. */
  transfer(data: Uint8Array): Result<Uint8Array, SpiError>
  /** Write-only transfer. */
  write(data: Uint8Array): Result<void, SpiError>
  /** Frees the bus and releases its GPIO pins. Calling it again does nothing. Afterwards `write()`
   *  does nothing and `transfer()` returns an empty array; the first such call prints a warning. */
  end(): void
}

/**
 * Claims the pins and starts an SPI bus on a host controller.
 * @public
 */
export declare function Spi(host: number, options: SpiOptions): Result<Spi, SpiError>

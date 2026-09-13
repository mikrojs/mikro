/* mikro/uart, declared here and implemented in C (mik_uart.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

/**
 * @public
 */
export interface UartBaseOptions {
  baudRate: number
}

/**
 * @public
 */
export interface UartTxRxOptions extends UartBaseOptions {
  tx: number
  rx: number
}

/**
 * @public
 */
export interface UartTxOnlyOptions extends UartBaseOptions {
  tx: number
  rx?: undefined
}

/**
 * @public
 */
export interface UartRxOnlyOptions extends UartBaseOptions {
  tx?: undefined
  rx: number
}

export type UartError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'DriverInstallFailed'; message: string}
  | {name: 'SetPinFailed'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'ReadFailed'; message: string}
  | {name: 'AlreadyReading'}
  | {name: 'NoRxPin'}
  | {name: 'NoTxPin'}

/**
 * @public
 */
export interface UartTx {
  write(data: Uint8Array): Result<void, UartError>
}

/**
 * @public
 */
export interface UartRx {
  /**
   * Open a Result-yielding async iterable of received chunks. The iterable
   * completes when `end()` is called.
   */
  read(): Result<AsyncIterable<Result<Uint8Array, UartError>>, UartError>
}

/**
 * @public
 */
export interface Uart {
  /** Uninstalls the driver and releases the GPIO pins. Calling it again does nothing. An active
   *  `read()` iterable completes. Afterwards `write()` does nothing and `read()` returns an
   *  iterable that completes at once; the first such call prints a warning. */
  end(): void
}

/**
 * Claims the pins and installs the UART driver on a port. The methods available depend on which
 * of `tx` and `rx` are given.
 * @public
 */
export declare function Uart(
  port: number,
  options: UartTxRxOptions,
): Result<Uart & UartTx & UartRx, UartError>
export declare function Uart(
  port: number,
  options: UartTxOnlyOptions,
): Result<Uart & UartTx, UartError>
export declare function Uart(
  port: number,
  options: UartRxOnlyOptions,
): Result<Uart & UartRx, UartError>

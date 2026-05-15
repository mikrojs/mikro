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
  | {name: 'DriverInstallFailed'; message: string}
  | {name: 'SetPinFailed'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'ReadFailed'; message: string}
  | {name: 'NotStarted'}
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
   * Open a Result-yielding async iterable of received chunks. Mid-stream
   * failures (driver fault, port closed mid-iteration) arrive as a single
   * terminal `err(UartError)` item rather than throwing — composes with
   * stream/* combinators and other Result-based APIs.
   */
  read(): Result<AsyncIterable<Result<Uint8Array, UartError>>, UartError>
}

/**
 * @public
 */
export interface UartBase {
  begin(): Result<void, UartError>
  end(): Result<void, UartError>
}

/**
 * @public
 */
export declare const Uart: {
  prototype: UartBase
  new (port: number, options: UartTxRxOptions): UartBase & UartTx & UartRx
  new (port: number, options: UartTxOnlyOptions): UartBase & UartTx
  new (port: number, options: UartRxOnlyOptions): UartBase & UartRx
}

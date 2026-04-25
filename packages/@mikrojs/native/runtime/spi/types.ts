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
  | {name: 'BusInitFailed'; message: string}
  | {name: 'AddDeviceFailed'; message: string}
  | {name: 'NotStarted'}
  | {name: 'MissingPins'}
  | {name: 'TransferFailed'; message: string}
  | {name: 'WriteFailed'; message: string}

/**
 * @public
 */
export declare const Spi: {
  prototype: Spi
  new (hostNo: 1 | 2, options: SpiOptions): Spi
}

/**
 * @public
 */
export interface Spi {
  begin(): Result<void, SpiError>

  end(): Result<void, SpiError>

  transfer(data: Uint8Array): Result<Uint8Array, SpiError>

  write(data: Uint8Array): Result<void, SpiError>
}

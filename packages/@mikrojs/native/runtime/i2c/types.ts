import type {Result} from '../result/types.js'

/**
 * @public
 */
export interface I2cBaseOptions {
  freq?: number
  timeout?: number
}

/**
 * @public
 */
export interface I2cOptionsWithPins extends I2cBaseOptions {
  sda: number
  scl: number
}

/**
 * @public
 */
export type I2cOptions = I2cBaseOptions | I2cOptionsWithPins

export type I2cError =
  | {name: 'BusInitFailed'; message: string}
  | {name: 'BusDeinitFailed'; message: string}
  | {name: 'NotStarted'}
  | {name: 'MissingPins'}
  | {name: 'AddDeviceFailed'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'WriteTooLarge'}
  | {name: 'ReadFailed'; message: string}

/**
 * @public
 */
export declare const I2c: {
  prototype: I2c
  new (busNo: 0 | 1, options?: I2cOptions): I2c
}

/**
 * @public
 */
export interface I2c {
  begin(): Result<void, I2cError>

  end(): Result<void, I2cError>

  read(address: number, bytes: number): Result<Uint8Array, I2cError>

  write(address: number, data: Uint8Array, stop?: boolean): Result<void, I2cError>

  scan(): Result<Uint8Array, I2cError>
}

import * as native from 'native:mikro/i2s'

import type {Result} from '../result/types.js'
import type {
  I2sBase,
  I2sError,
  I2sPdmRxOptions,
  I2sSamples,
  I2sStdRxOptions,
  I2sStdTxOptions,
  I2sStdTxRxOptions,
} from './types.js'

/**
 * @public
 */
export class I2s implements I2sBase {
  #native: native.I2s

  constructor(port: number, options: I2sStdTxRxOptions)
  constructor(port: number, options: I2sStdTxOptions)
  constructor(port: number, options: I2sStdRxOptions)
  constructor(port: number, options: I2sPdmRxOptions)
  constructor(
    port: number,
    options: I2sStdTxRxOptions | I2sStdTxOptions | I2sStdRxOptions | I2sPdmRxOptions,
  ) {
    this.#native = new native.I2s(port, options)
  }

  begin(): Result<void, I2sError> {
    return this.#native.begin()
  }

  end(): Result<void, I2sError> {
    return this.#native.end()
  }

  write(data: I2sSamples | Uint8Array): Promise<Result<void, I2sError>> {
    return this.#native.write(data)
  }

  capture(frames: number, options?: {gainBits?: number}): Result<Int16Array, I2sError> {
    return this.#native.capture(frames, options)
  }
}

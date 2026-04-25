import * as native from 'native:i2c'

import type {Result} from '../result/types.js'
import type {I2c as PlatformI2c, I2cError, I2cOptions} from './types.js'

/**
 * @public
 */
export class I2c implements PlatformI2c {
  #native: native.I2c

  constructor(busNo: 0 | 1, options?: I2cOptions) {
    this.#native = new native.I2c(busNo, options)
  }

  begin(): Result<void, I2cError> {
    return this.#native.begin()
  }

  end(): Result<void, I2cError> {
    return this.#native.end()
  }

  scan(): Result<Uint8Array, I2cError> {
    return this.#native.scan()
  }

  write(address: number, data: Uint8Array, stop?: boolean): Result<void, I2cError> {
    return this.#native.write(address, data, stop)
  }

  read(address: number, bytes: number): Result<Uint8Array, I2cError> {
    return this.#native.read(address, bytes)
  }
}

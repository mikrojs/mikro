import * as native from 'native:mikro/spi'

import type {Result} from '../result/types.js'
import type {Spi as PlatformSpi, SpiError, SpiOptions} from './types.js'

/**
 * @public
 */
export class Spi implements PlatformSpi {
  #native: native.Spi

  constructor(hostNo: 1 | 2, options: SpiOptions) {
    this.#native = new native.Spi(hostNo, options)
  }

  begin(): Result<void, SpiError> {
    return this.#native.begin()
  }

  end(): Result<void, SpiError> {
    return this.#native.end()
  }

  transfer(data: Uint8Array): Result<Uint8Array, SpiError> {
    return this.#native.transfer(data)
  }

  write(data: Uint8Array): Result<void, SpiError> {
    return this.#native.write(data)
  }
}

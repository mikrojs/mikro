import {ok} from 'mikrojs/result'
import * as native from 'native:uart'

import type {Result} from '../result/types.js'
import type {
  UartBase,
  UartBaseOptions,
  UartError,
  UartRxOnlyOptions,
  UartTxOnlyOptions,
  UartTxRxOptions,
} from './types.js'

/**
 * @public
 */
export class Uart implements UartBase {
  #native: native.Uart

  constructor(port: number, options: UartTxRxOptions)
  constructor(port: number, options: UartTxOnlyOptions)
  constructor(port: number, options: UartRxOnlyOptions)
  constructor(port: number, options: UartBaseOptions & {tx?: number; rx?: number}) {
    this.#native = new native.Uart(port, options)
  }

  begin(): Result<void, UartError> {
    return this.#native.begin()
  }

  end(): Result<void, UartError> {
    return this.#native.end()
  }

  write(data: Uint8Array): Result<void, UartError> {
    return this.#native.write(data)
  }

  read(): Result<AsyncIterable<Uint8Array>, UartError> {
    const result = this.#native.read()
    if (!result.ok) return result
    const nativeIter = result.value
    // Wrap the native iterator object (which has next/return) into a proper AsyncIterable
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return nativeIter as AsyncIterator<Uint8Array>
      },
    }
    return ok(iterable)
  }
}

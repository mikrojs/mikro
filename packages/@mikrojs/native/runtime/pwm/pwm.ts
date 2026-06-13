import {ok} from 'mikro/result'
import {Pwm as NativePwm} from 'native:mikro/pwm'

import type {Result} from '../result/types.js'
import type {PwmError, PwmOptions} from './types.js'

export class Pwm {
  #native: InstanceType<typeof NativePwm>

  constructor(pin: number, options: PwmOptions) {
    this.#native = new NativePwm(pin, options.freq, options.duty ?? 0)
  }

  duty(value?: number): Result<number, PwmError> {
    return this.#native.duty(value)
  }

  freq(value?: number): Result<number, PwmError> {
    return this.#native.freq(value)
  }

  async fade(targetDuty: number, durationMs: number): Promise<Result<void, PwmError>> {
    const result = this.#native.fade(targetDuty, durationMs)
    if (!result.ok) return result
    await result.value
    return ok(undefined)
  }

  end(): Result<void, PwmError> {
    return this.#native.end()
  }
}

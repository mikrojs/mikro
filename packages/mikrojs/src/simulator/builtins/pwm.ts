import type {BuiltinDefinition} from './types.js'

// pwm uses a raw source module instead of RPC because fade() returns
// {ok, value: Promise<void>} which can't survive JSON serialization.
export const pwmBuiltin: BuiltinDefinition = {
  source: `
import {ok} from 'mikrojs/result'

export class Pwm {
  #freq
  #duty
  constructor(_pin, freq, duty) {
    this.#freq = freq
    this.#duty = duty
  }
  duty(value) {
    if (value !== undefined) this.#duty = value
    return ok(this.#duty)
  }
  freq(value) {
    if (value !== undefined) this.#freq = value
    return ok(this.#freq)
  }
  fade(_target, _durationMs) {
    return ok(Promise.resolve())
  }
  end() {
    return ok()
  }
}
`,
}

import type {BuiltinDefinition} from './types.js'

export const pwmBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for pwm
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {err, ok} from 'mikro/result'
import type {Pwm as PwmHandle} from 'mikro/pwm'
import type {SimPwm} from 'mikro/sim'

function outOfRange(name: string, value: number) {
  return err({name: 'InvalidParam' as const, message: name + ' is out of range, got ' + value})
}

export const Pwm: SimPwm['Pwm'] = (gpio, options) => {
  let freq = options.freq
  let duty = options.duty ?? 0
  if (!(freq >= 1 && freq <= 40000000)) return outOfRange('freq', freq)
  if (!(duty >= 0 && duty <= 1)) return outOfRange('duty', duty)
  let released = false
  let warned = false
  // Reports use of a handle after end() once, as the device does.
  function ended(call: string) {
    if (!released) return false
    if (!warned) {
      warned = true
      console.error('Pwm ' + gpio + ': ' + call + ' after end(); the handle no longer owns the pin')
    }
    return true
  }
  // Overloads (get and set) are not expressible on an object literal, hence the cast below.
  const handle = {
    duty(value?: number) {
      if (ended('duty()') || value === undefined) return value === undefined ? ok(duty) : ok()
      if (!(value >= 0 && value <= 1)) return outOfRange('duty', value)
      duty = value
      return ok()
    },
    freq(value?: number) {
      if (ended('freq()') || value === undefined) return value === undefined ? ok(freq) : ok()
      if (!(value >= 1 && value <= 40000000)) return outOfRange('freq', value)
      freq = value
      return ok()
    },
    async fade(targetDuty: number, durationMs: number) {
      if (ended('fade()')) return ok()
      if (!(targetDuty >= 0 && targetDuty <= 1)) return outOfRange('targetDuty', targetDuty)
      await new Promise((resolve) => setTimeout(resolve, durationMs))
      duty = targetDuty
      return ok()
    },
    end() {
      released = true
    },
  }
  return ok(handle as unknown as PwmHandle)
}
`,
}

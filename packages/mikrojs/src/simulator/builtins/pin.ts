import type {BuiltinDefinition} from './types.js'

export const pinBuiltin: BuiltinDefinition = {
  source: `// Simulator stub for pin
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikrojs/result'
import type {SimPin} from 'mikrojs/sim'

const state: Record<number, {mode?: number; value?: number}> = {}

export const pinMode: SimPin['pinMode'] = (pin, mode) => {
  state[pin] = {...state[pin], mode}
  return ok()
}

export const digitalWrite: SimPin['digitalWrite'] = (pin, value) => {
  state[pin] = {...state[pin], value}
  return ok()
}

export const digitalRead: SimPin['digitalRead'] = (pin) => {
  return state[pin]?.value ?? 0
}

export const analogRead: SimPin['analogRead'] = (_pin, _attenuation) => {
  return ok(Math.floor(Math.random() * 4096))
}

export const analogReadMillivolts: SimPin['analogReadMillivolts'] = (_pin, _attenuation) => {
  return ok(Math.floor(Math.random() * 2500))
}
`,
}

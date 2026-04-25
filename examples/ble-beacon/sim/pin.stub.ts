// Simulator stub for pin
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import type {SimPin} from 'mikrojs/sim'

const state: Record<number, {mode?: number; value?: number}> = {}

export const pinMode: SimPin['pinMode'] = (pin, mode) => {
  state[pin] = {...state[pin], mode}
  return {ok: true as const}
}

export const digitalWrite: SimPin['digitalWrite'] = (pin, value) => {
  state[pin] = {...state[pin], value}
  return {ok: true as const}
}

export const digitalRead: SimPin['digitalRead'] = (pin) => {
  return state[pin]?.value ?? 0
}

export const analogRead: SimPin['analogRead'] = (_pin, _attenuation) => {
  return {ok: true as const, value: Math.floor(Math.random() * 4096)}
}

export const analogReadMillivolts: SimPin['analogReadMillivolts'] = (_pin, _attenuation) => {
  return {ok: true as const, value: Math.floor(Math.random() * 2500)}
}

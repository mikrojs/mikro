import type {BuiltinDefinition} from './types.js'

// sleep uses a raw source module so deepSleep can use setTimeout + restart,
// and lightSleep can return a delayed Promise.
export const sleepBuiltin: BuiltinDefinition = {
  source: `
import {restart} from 'native:sys'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

let wakeupCause = 'undefined'

export function deepSleep(ms) {
  // On device, deepSleep is \`never\` (chip resets after sleep).
  // In the sim, wait the duration then restart the runtime.
  console.warn('[sim] deepSleep(' + ms + 'ms)')
  sleep(ms).then(() => restart())
}

export function lightSleep(ms) {
  console.warn('[sim] lightSleep(' + ms + 'ms)')
  // Block-ish: return a result after the delay
  return {ok: true}
}

export function getWakeupCause() { return wakeupCause }
export function enableTimerWakeup() { return {ok: true} }
export function enableGpioWakeup() { return {ok: true} }
export function enableExt0Wakeup() { return {ok: true} }
export function enableExt1Wakeup() { return {ok: true} }
export function disableWakeupSource() { return {ok: true} }
`,
}

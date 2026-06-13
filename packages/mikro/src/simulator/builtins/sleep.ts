import type {BuiltinDefinition} from './types.js'

// sleep uses a raw source module so deepSleep can use setTimeout + restart.
export const sleepBuiltin: BuiltinDefinition = {
  source: `
import {restart} from 'native:mikro/sys'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

let wakeupCause = 'undefined'

export function deepSleep(sources) {
  console.warn('[sim] deepSleep ' + JSON.stringify(sources))
  // On device, deepSleep is \`never\` (chip resets after sleep).
  // In the sim, wait the timer duration (if any) then restart the runtime.
  sleep(sources?.timer ?? 0).then(() => restart())
}

export function lightSleep(sources) {
  console.warn('[sim] lightSleep ' + JSON.stringify(sources))
}

export function getWakeupCause() { return wakeupCause }
export function canWakeFromExt0() { return false }
export function canWakeFromExt1() { return true }
`,
}

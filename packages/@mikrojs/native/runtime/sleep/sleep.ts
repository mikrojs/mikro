import {deepSleep as nativeDeepSleep, lightSleep as nativeLightSleep} from 'native:mikro/sleep'

import type {DeepWakeupSources, LightWakeupSources} from './types.js'

export type {DeepWakeupSources, LightWakeupSources, RtcGpio, WakeupLevel} from './types.js'
export {canWakeFromExt0, canWakeFromExt1} from 'native:mikro/sleep'

export function deepSleep(sources: DeepWakeupSources | number): never {
  return nativeDeepSleep(typeof sources === 'number' ? {timer: sources} : sources)
}

export function lightSleep(sources: LightWakeupSources | number): void {
  nativeLightSleep(typeof sources === 'number' ? {timer: sources} : sources)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

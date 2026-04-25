import * as native from 'native:pin'

import type {Result} from '../result/types.js'
import type {AnalogReadOptions, Attenuation, PinError, PinMode} from './types.js'

// Public mode lookup. Kept as a runtime value (rather than inlined) because
// user code occasionally reads it to build a mode-picker UI on host-side
// tooling; the native:pin layer uses the numeric constants directly.
const PIN_MODE_INPUT = 0x01
const PIN_MODE_OUTPUT = 0x03
const PIN_MODE_INPUT_PULLUP = 0x05

export const NativePinModes = {
  INPUT: PIN_MODE_INPUT,
  OUTPUT: PIN_MODE_OUTPUT,
  INPUT_PULLUP: PIN_MODE_INPUT_PULLUP,
} as const

const NativeAttenuation: Record<Attenuation, number> = {
  '0db': 0,
  '2.5db': 1,
  '6db': 2,
  '11db': 3,
} as const

// Wrappers translate the string/enum JS-idiom args to the numeric codes the
// native layer expects. Errors flow through unchanged: native:pin returns
// {ok, error:{name,message}} directly (see mik_pin.cpp), so no remapping.

export function pinMode(pin: number, mode: PinMode): Result<void, PinError> {
  return native.pinMode(pin, NativePinModes[mode])
}

export function digitalWrite(pin: number, value: 0 | 1): Result<void, PinError> {
  return native.digitalWrite(pin, value)
}

export function digitalRead(pin: number): 0 | 1 {
  return native.digitalRead(pin) as 0 | 1
}

export function analogRead(pin: number, options?: AnalogReadOptions): Result<number, PinError> {
  return native.analogRead(pin, NativeAttenuation[options?.attenuation ?? '11db'])
}

export function analogReadMillivolts(
  pin: number,
  options?: AnalogReadOptions,
): Result<number, PinError> {
  return native.analogReadMillivolts(pin, NativeAttenuation[options?.attenuation ?? '11db'])
}

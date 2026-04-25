import type {Result} from '../result/types.js'

export type PinMode = 'INPUT' | 'OUTPUT' | 'INPUT_PULLUP'

/**
 * ADC attenuation setting, controls the measurable voltage range.
 * - `'0db'` — 0–750 mV
 * - `'2.5db'` — 0–1050 mV
 * - `'6db'` — 0–1300 mV
 * - `'11db'` — 0–2500 mV (default)
 */
export type Attenuation = '0db' | '2.5db' | '6db' | '11db'

export interface AnalogReadOptions {
  /** ADC attenuation. Defaults to `'11db'` (0–2500 mV range). */
  attenuation?: Attenuation
}

export type PinError =
  | {name: 'InvalidPin'; message: string}
  | {name: 'SetModeFailed'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'AdcInitFailed'; message: string}
  | {name: 'AdcReadFailed'; message: string}
  | {name: 'InvalidAdcPin'}

export declare function pinMode(pin: number, mode: PinMode): Result<void, PinError>

export declare function digitalWrite(pin: number, value: 0 | 1): Result<void, PinError>

export declare function digitalRead(pin: number): 0 | 1

/**
 * Read the raw ADC value from a pin.
 * @returns A Result containing a 12-bit integer (0–4095) proportional to the input voltage, or a PinError.
 */
export declare function analogRead(
  pin: number,
  options?: AnalogReadOptions,
): Result<number, PinError>

/**
 * Read a calibrated voltage from a pin.
 * @returns A Result containing the input voltage in millivolts, or a PinError.
 */
export declare function analogReadMillivolts(
  pin: number,
  options?: AnalogReadOptions,
): Result<number, PinError>

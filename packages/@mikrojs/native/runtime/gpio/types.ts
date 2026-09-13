/* mikro/gpio, declared here and implemented in C (mik_gpio.cpp). Each handle
 * type has a factory of the same name that claims the GPIO pin, configures it
 * and returns a Result. A GPIO pin has one owner at a time across every module. */

import type {Observable} from '../observable/types.js'
import type {Result} from '../result/types.js'

/**
 * ADC attenuation setting, controls the measurable voltage range.
 * - `'0db'`: 0 to 750 mV
 * - `'2.5db'`: 0 to 1050 mV
 * - `'6db'`: 0 to 1300 mV
 * - `'11db'`: 0 to 2500 mV (default)
 */
export type Attenuation = '0db' | '2.5db' | '6db' | '11db'

/** The electrical level of a pin: 0 is low, 1 is high. */
export type Level = 0 | 1

export interface DigitalOutOptions {
  /** Level applied before the pin becomes an output. Defaults to `0`. */
  initial?: Level
}

export interface DigitalInOptions {
  /** Internal pull resistor. Defaults to `'none'`. Input-only GPIOs (ESP32 GPIO 34 to 39)
   *  have none, so `'up'` or `'down'` there returns `InvalidGpio`. */
  pull?: 'up' | 'down' | 'none'
}

export interface AnalogInOptions {
  /** ADC attenuation. Defaults to `'11db'`. */
  attenuation?: Attenuation
}

/** The GPIO pin is held by another handle, peripheral or the console. */
export type GpioInUse = {name: 'GpioInUse'; owner: string; message: string}

export type GpioError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'ConfigFailed'; message: string}
  | {name: 'ReadFailed'; message: string}
  | {name: 'CalibrationUnavailable'}

/**
 * @public
 */
export interface GpioPin {
  /** The GPIO number. */
  readonly gpio: number
  /** Releases the GPIO pin. Calling it again does nothing. Afterwards writes do nothing and reads
   *  still read the pin; the first such call prints a warning. */
  end(): void
}

/**
 * @public
 */
export interface DigitalOut extends GpioPin {
  /** Drives the pin low (0) or high (1). Does nothing after `end()`. */
  write(level: Level): void
}

/**
 * @public
 */
export interface DigitalIn extends GpioPin {
  /** The pin's current level. Still reads the pin after `end()`. */
  read(): Level
  /**
   * Level changes. Edges within one event loop pass are combined, so
   * each value differs from the previous one. Filter bounces with
   * `debounceTime` followed by `distinctUntilChanged()`, since a short bounce
   * can return to the level it started from. Reading this keeps the handle
   * alive until `end()`, which completes the stream.
   */
  readonly onChange: Observable<Level>
}

/**
 * @public
 */
export interface AnalogIn extends GpioPin {
  /** Raw 12-bit reading, 0 to 4095. Still reads the pin after `end()`. */
  read(): Result<number, GpioError>
  /** Calibrated reading in millivolts. */
  readMillivolts(): Result<number, GpioError>
}

/**
 * Claims a GPIO pin as a digital output.
 * @public
 */
export declare function DigitalOut(
  gpio: number,
  options?: DigitalOutOptions,
): Result<DigitalOut, GpioError>

/**
 * Claims a GPIO pin as a digital input.
 * @public
 */
export declare function DigitalIn(
  gpio: number,
  options?: DigitalInOptions,
): Result<DigitalIn, GpioError>

/**
 * Claims a GPIO pin as an analog input on ADC1.
 * @public
 */
export declare function AnalogIn(
  gpio: number,
  options?: AnalogInOptions,
): Result<AnalogIn, GpioError>

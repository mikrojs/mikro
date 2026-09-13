/* mikro/pwm, declared here and implemented in C (mik_pwm.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

export interface PwmOptions {
  /** Frequency in Hz, 1 to 40000000 */
  freq: number
  /** Initial duty cycle, 0.0–1.0. Defaults to 0. */
  duty?: number
}

export type PwmError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'NoChannel'; message: string}
  | {name: 'NoTimer'; message: string}
  | {name: 'ConfigFailed'; message: string}
  | {name: 'DutyFailed'; message: string}
  | {name: 'FreqFailed'; message: string}
  | {name: 'FadeFailed'; message: string}

/**
 * @public
 */
export interface Pwm {
  /** The current duty cycle (0.0–1.0) */
  duty(): Result<number, PwmError>
  /** Set the duty cycle (0.0–1.0) */
  duty(value: number): Result<void, PwmError>
  /** The current frequency in Hz */
  freq(): Result<number, PwmError>
  /** Set the frequency in Hz */
  freq(value: number): Result<void, PwmError>
  /** Hardware fade to a target duty over a duration. Resolves when the fade completes, or with
   *  `ok()` when `end()` stops it. */
  fade(targetDuty: number, durationMs: number): Promise<Result<void, PwmError>>
  /** Stops the output and releases the GPIO pin. Calling it again does nothing. Afterwards setters
   *  and `fade()` do nothing and getters return the last value; the first such call prints a
   *  warning. */
  end(): void
}

/**
 * Claims a GPIO pin as a PWM output.
 * @public
 */
export declare function Pwm(gpio: number, options: PwmOptions): Result<Pwm, PwmError>

import type {Result} from '../result/types.js'

export interface PwmOptions {
  /** Frequency in Hz */
  freq: number
  /** Initial duty cycle, 0.0–1.0. Defaults to 0. */
  duty?: number
}

export type PwmError =
  | {name: 'NoChannel'; message: string}
  | {name: 'NoTimer'; message: string}
  | {name: 'ConfigFailed'; message: string}
  | {name: 'NotActive'}
  | {name: 'DutyFailed'; message: string}
  | {name: 'FreqFailed'; message: string}
  | {name: 'FadeFailed'; message: string}

export declare class Pwm {
  constructor(pin: number, options: PwmOptions)
  /** Get or set duty cycle (0.0–1.0) */
  duty(value?: number): Result<number, PwmError>
  /** Get or set frequency in Hz */
  freq(value?: number): Result<number, PwmError>
  /** Hardware fade to target duty over duration. Returns promise with result. */
  fade(targetDuty: number, durationMs: number): Promise<Result<void, PwmError>>
  /** Stop PWM and release the channel */
  end(): Result<void, PwmError>
}

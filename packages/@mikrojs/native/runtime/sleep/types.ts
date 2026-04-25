import type {Result} from '../result/types.js'

export type SleepError =
  | {name: 'WakeupConfigFailed'; message: string}
  | {name: 'LightSleepFailed'; message: string}
  | {name: 'DisableWakeupFailed'; message: string}

export declare function deepSleep(time: number): never

export declare function lightSleep(time: number): Result<void, SleepError>

export declare function getWakeupCause(): string

/** Configure timer wakeup source (microseconds). */
export declare function enableTimerWakeup(us: number): Result<void, SleepError>

/**
 * Configure GPIO wakeup for light sleep.
 * @param pin GPIO pin number
 * @param level GPIO interrupt type (e.g. 4 = low, 5 = high)
 */
export declare function enableGpioWakeup(pin: number, level: number): Result<void, SleepError>

/**
 * Configure ext0 wakeup for deep sleep (ESP32, ESP32-S2, ESP32-S3 only).
 * @param pin RTC GPIO pin number
 * @param level 0 = low, 1 = high
 */
export declare function enableExt0Wakeup(pin: number, level: number): Result<void, SleepError>

/**
 * Configure ext1 wakeup for deep sleep.
 * @param pinMask Bitmask of RTC GPIO pins
 * @param mode 0 = ESP_EXT1_WAKEUP_ALL_LOW, 1 = ESP_EXT1_WAKEUP_ANY_HIGH
 */
export declare function enableExt1Wakeup(pinMask: number, mode: number): Result<void, SleepError>

/**
 * Disable a wakeup source. If no source is specified, all sources are disabled.
 * @param source Optional: "timer", "ext0", "ext1", "gpio", "touchpad", "ulp"
 */
export declare function disableWakeupSource(source?: string): Result<void, SleepError>

export declare function sleep(ms: number): Promise<void>

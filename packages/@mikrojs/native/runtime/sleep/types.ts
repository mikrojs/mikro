export type WakeupLevel = 'high' | 'low'

/** A GPIO pin number that must be RTC-capable for deep-sleep wake.
 *  Set varies per chip:
 *  - ESP32-C6 / H2: 0–7 (LP_GPIO0–LP_GPIO7)
 *  - ESP32-C3: 0–5
 *  - ESP32-S2 / S3: 0–21 (LP_IO0–LP_IO21)
 *  - ESP32: subset of 0–39 (see datasheet for RTC_GPIO mapping)
 *
 *  Not statically validated — passing a non-RTC pin throws at runtime.
 */
export type RtcGpio = number

/** Sources that can wake the chip from light sleep. */
export type LightWakeupSources = {
  /** Wake after this many milliseconds. Fractional values are allowed
   *  (e.g. `0.01` = 10 µs). */
  timer?: number
  /** Wake when `pin` reaches `level`. Any GPIO works — no RTC-capable
   *  constraint. */
  gpio?: {pin: number; level: WakeupLevel}
}

/** Sources that can wake the chip from deep sleep. */
export type DeepWakeupSources = {
  /** Wake after this many milliseconds. Fractional values are allowed. */
  timer?: number
  /** Wake on a single RTC GPIO. ESP32 / S2 / S3 only — throws on
   *  C3 / C6 / H2 (use `ext1` instead). */
  ext0?: {pin: RtcGpio; level: WakeupLevel}
  /** Wake when any of `pins` matches `mode`. Pins must be RTC-capable.
   *
   *  Caveat — original ESP32 chip only: the EXT1 hardware on the
   *  original ESP32 cannot honor "any-low" with more than one pin (the
   *  silicon always requires *every* selected pin to be low, not any).
   *  Multi-pin `{mode: 'any-low'}` throws on ESP32; single-pin works,
   *  and `'any-high'` works for any pin count. Every newer chip
   *  (C3, C5, C6, S2, S3, …) supports multi-pin `'any-low'` natively. */
  ext1?: {pins: RtcGpio[]; mode: 'any-low' | 'any-high'}
}

/**
 * Enter deep sleep. Pass a `DeepWakeupSources` object, or a number as
 * shorthand for `{timer: ms}`. The chip resets on wake.
 */
export declare function deepSleep(ms: number): never
export declare function deepSleep(sources: DeepWakeupSources): never

/**
 * Enter light sleep. Pass a `LightWakeupSources` object, or a number as
 * shorthand for `{timer: ms}`. Execution resumes from the call site
 * after waking.
 */
export declare function lightSleep(ms: number): void
export declare function lightSleep(sources: LightWakeupSources): void

/** Returns `true` if the current chip supports EXT0 wakeup
 *  (ESP32, ESP32-S2, ESP32-S3). Use to gate `deepSleep({ext0: …})`
 *  calls when targeting boards across the ESP32 family. */
export declare function canWakeFromExt0(): boolean

/** Returns `true` if the current chip supports EXT1 wakeup. Every
 *  chip mikrojs targets except ESP32-C3. Use to gate
 *  `deepSleep({ext1: …})` calls. */
export declare function canWakeFromExt1(): boolean

export declare function sleep(ms: number): Promise<void>

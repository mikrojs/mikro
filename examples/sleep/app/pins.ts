// Per-board pin map for Seeed XIAO ESP32 boards. Picks the right
// chip pin for each "role" the examples need (built-in LED, a free
// GPIO behind the D7 header pad for the light-sleep button example,
// etc.) based on `board.chip`.

import {board} from 'mikrojs/sys'

export interface XiaoPinMap {
  /** Built-in user LED (active-low on every XIAO ESP32 board). */
  led: number
  /** Chip pin behind the **D7** header pad. Used by the light-sleep
   *  GPIO-wake example as a known-free, breadboard-accessible pin
   *  that supports INPUT_PULLUP. */
  buttonPin: number
}

/** Add an entry here for any XIAO board not already listed. */
const PINS_BY_CHIP: Record<string, XiaoPinMap> = {
  esp32c5: {led: 27, buttonPin: 12},
  esp32c6: {led: 15, buttonPin: 17},
  esp32s3: {led: 21, buttonPin: 8},
}

const FALLBACK_CHIP = 'esp32c6'

export const pins: XiaoPinMap = PINS_BY_CHIP[board.chip] ?? PINS_BY_CHIP[FALLBACK_CHIP]!

if (!(board.chip in PINS_BY_CHIP)) {
  console.warn(
    `No XIAO pin map known for ${board.chip}; falling back to ${FALLBACK_CHIP} defaults. ` +
      `Edit app/pins.ts to add a mapping for your board.`,
  )
}

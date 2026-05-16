# Sleep

One entry per `<sleep-type>` × `<wake-source>` combination. Designed to work out of the box on any **Seeed XIAO ESP32** board (C6, S3, and friends) — `app/led.ts` picks the right built-in LED pin by `board.chip`, and the wake pins are chosen to be valid across XIAO chips.

## Entries

| File                 | Sleep | Wake source(s)                       | Notes                     |
| -------------------- | ----- | ------------------------------------ | ------------------------- |
| `app/light-timer.ts` | light | timer                                | Default entry.            |
| `app/light-gpio.ts`  | light | timer + GPIO 17 pulled LOW           | Any GPIO works.           |
| `app/deep-timer.ts`  | deep  | timer                                | Chip resets on wake.      |
| `app/deep-ext0.ts`   | deep  | timer + single RTC GPIO 0 pulled LOW | **ESP32 / S2 / S3 only.** |
| `app/deep-ext1.ts`   | deep  | timer + multi RTC GPIO 0 pulled LOW  | Skipped on C3 (no EXT1).  |

The `ext0` and `ext1` examples gate on `canWakeFromExt0()` / `canWakeFromExt1()` from `mikrojs/sleep`, so they print a "try the other entry" hint instead of crashing on chips that don't support that wake path.

## Run

```sh
pnpm mikro dev                       # default: light-timer.ts
pnpm mikro dev app/light-timer.ts
pnpm mikro dev app/light-gpio.ts
pnpm mikro dev app/deep-timer.ts
pnpm mikro dev app/deep-ext0.ts      # ESP32 / S2 / S3 only
pnpm mikro dev app/deep-ext1.ts
```

## Wiring

- `light-gpio.ts`: button or jumper between **GPIO 17** and **GND**. Labelled **D7** on the XIAO ESP32-C6 header, **D6** on the XIAO ESP32-S3. The internal pull-up keeps the pin HIGH when idle; grounding it triggers wake. Light-sleep wake works on any GPIO.
- `deep-ext0.ts`: button or jumper between **GPIO 0** and **GND**. **ESP32 / S2 / S3 only** — throws "EXT0 wakeup is not supported on this chip" on C6/C3/H2. mikrojs configures the internal RTC pull-up automatically.
- `deep-ext1.ts`: button or jumper between **GPIO 0** and **GND**. Labelled **D0** on the XIAO ESP32-C6, **D1** on the XIAO ESP32-S3. mikrojs configures the chip's internal RTC pull (up for `any-low`, down for `any-high`) automatically.

## Porting to a non-XIAO board

`app/led.ts` knows the built-in LED pin for the chips listed in `LED_PIN_BY_CHIP`. On any other chip it falls back to GPIO 15 with a runtime warning. If your board's LED is on a different pin, add an entry to that map (or just edit the fallback).

---
title: pwm
description: Pulse-width modulation for LED dimming, motor control, and more
---

# pwm

```ts twoslash
import {Pwm} from 'mikrojs/pwm'
```

Control PWM output for LED dimming, motor speed control, servo positioning, and other analog-like outputs.

## Usage

```ts twoslash
import {Pwm} from 'mikrojs/pwm'

const led = new Pwm(20, {freq: 5000, duty: 0.5})

// Fade from current duty to 100% over 2 seconds
await led.fade(1.0, 2000)

led.end()
```

## Constructor

### new Pwm(pin, options)

```ts
new Pwm(pin: number, options: PwmOptions)
```

Creates a PWM output on the given GPIO pin.

**Parameters:**

- `pin`: GPIO pin number
- `options`: see [PwmOptions](#pwmoptions)

## Methods

### pwm.duty(value?)

```ts
duty(value?: number): Result<number, PwmError>
```

Get or set the duty cycle (0.0–1.0). Called without arguments, returns the current duty. Called with a value, sets it and returns the new value.

```ts twoslash
import {Pwm} from 'mikrojs/pwm'
const led = new Pwm(20, {freq: 5000})
// ---cut---
led.duty(0.75) // set to 75%
const current = led.duty().orPanic('Failed to read duty')
```

### pwm.freq(value?)

```ts
freq(value?: number): Result<number, PwmError>
```

Get or set the frequency in Hz. Same get/set pattern as `duty()`.

### pwm.fade(targetDuty, durationMs)

```ts
fade(targetDuty: number, durationMs: number): Promise<Result<void, PwmError>>
```

Hardware-accelerated fade to the target duty cycle over the given duration. This uses the ESP32's LEDC hardware fading, so the fade runs without CPU involvement.

```ts twoslash
import {Pwm} from 'mikrojs/pwm'
const led = new Pwm(20, {freq: 5000})
// ---cut---
await led.fade(0, 1000) // fade to off over 1 second
```

### pwm.end()

```ts
end(): Result<void, PwmError>
```

Stops the PWM output and releases the hardware channel.

## Types

### PwmOptions

```ts
interface PwmOptions {
  freq: number // frequency in Hz
  duty?: number // initial duty cycle, 0.0–1.0 (default: 0)
}
```

## Errors

### PwmError

| Variant      | Fields    | Description              |
| ------------ | --------- | ------------------------ |
| `NotActive`  | —         | PWM has been ended       |
| `DutyFailed` | `message` | Failed to set duty cycle |
| `FreqFailed` | `message` | Failed to set frequency  |
| `FadeFailed` | `message` | Hardware fade failed     |

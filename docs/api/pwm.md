---
title: pwm
description: Pulse-width modulation for LED dimming, motor control, and more
---

# pwm

```ts twoslash
import {Pwm} from 'mikro/pwm'
```

Control PWM output for LED dimming, motor speed control, servo positioning, and other analog-like outputs.

## Usage

```ts twoslash
import {Pwm} from 'mikro/pwm'

const led = Pwm(20, {freq: 5000, duty: 0.5}).orPanic('Failed to set up the LED')

// Fade from current duty to 100% over 2 seconds
await led.fade(1.0, 2000)

led.end()
```

## Functions

### Pwm(gpio, options)

```ts
function Pwm(gpio: number, options: PwmOptions): Result<Pwm, PwmError>
```

Claims the GPIO pin, creates a PWM output on it and returns a [`Result`](/api/result) with the handle. The pin must be able to drive a signal, or you get `InvalidGpio`. If another handle, a peripheral or the console holds it, you get `GpioInUse`.

**Parameters:**

- `gpio`: GPIO number
- `options`: see [PwmOptions](#pwmoptions)

## Methods

### pwm.duty(value?)

```ts
duty(): Result<number, PwmError>
duty(value: number): Result<void, PwmError>
```

Get or set the duty cycle (0.0–1.0). Called without arguments, returns the current duty. Called with a value, sets it. A value outside 0 to 1 returns `InvalidParam`.

```ts twoslash
import {Pwm} from 'mikro/pwm'
const led = Pwm(20, {freq: 5000}).orPanic('Failed to set up the LED')
// ---cut---
led.duty(0.75).orPanic('Failed to set duty') // set to 75%
const current = led.duty().orPanic('Failed to read duty')
```

### pwm.freq(value?)

```ts
freq(): Result<number, PwmError>
freq(value: number): Result<void, PwmError>
```

Get or set the frequency in Hz. Same get/set pattern as `duty()`.

### pwm.fade(targetDuty, durationMs)

```ts
fade(targetDuty: number, durationMs: number): Promise<Result<void, PwmError>>
```

Hardware-accelerated fade to the target duty cycle over the given duration. This uses the ESP32's LEDC hardware fading, so the fade runs without CPU involvement. The promise resolves when the fade completes. If a fade is already running on the same output, `fade()` waits for it to finish before starting, and the event loop is blocked while it waits. Errors found before the fade starts, such as a target outside 0 to 1, come back in the resolved `Result`.

```ts twoslash
import {Pwm} from 'mikro/pwm'
const led = Pwm(20, {freq: 5000}).orPanic('Failed to set up the LED')
// ---cut---
await led.fade(0, 1000) // fade to off over 1 second
```

### pwm.end()

```ts
end(): void
```

Stops the PWM output and releases the hardware channel and the GPIO pin. Calling it again does nothing. A fade in progress resolves with `ok()`. After `end()`, setters and `fade()` do nothing, getters return the last value, and the first such call prints a warning.

## Types

### PwmOptions

```ts
interface PwmOptions {
  freq: number // frequency in Hz, 1 to 40000000
  duty?: number // initial duty cycle, 0.0–1.0 (default: 0)
}
```

## Errors

### PwmError

| Variant        | Fields             | Description                                                                 |
| -------------- | ------------------ | --------------------------------------------------------------------------- |
| `GpioInUse`    | `owner`, `message` | Another handle, peripheral or the console holds the pin                     |
| `InvalidGpio`  | `message`          | The chip has no such GPIO, or the GPIO cannot drive a signal                |
| `InvalidParam` | `message`          | A frequency, duty cycle or fade duration is out of range                    |
| `NoChannel`    | `message`          | All LEDC channels are in use                                                |
| `NoTimer`      | `message`          | All LEDC timers are in use by other frequencies                             |
| `ConfigFailed` | `message`          | ESP-IDF rejected the LEDC configuration; `message` names the call and error |
| `DutyFailed`   | `message`          | Failed to set duty cycle                                                    |
| `FreqFailed`   | `message`          | Failed to set frequency                                                     |
| `FadeFailed`   | `message`          | Hardware fade failed                                                        |

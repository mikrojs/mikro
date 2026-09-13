---
title: gpio
description: GPIO digital and analog I/O
---

# gpio

```ts twoslash
import {DigitalOut, DigitalIn, AnalogIn} from 'mikro/gpio'
```

Control GPIO pins for digital and analog I/O.

You use a GPIO pin through a handle, and you pick the pin by its GPIO number: the number in the chip's datasheet and pinout diagram, never a board label such as `D7`. `DigitalOut`, `DigitalIn` and `AnalogIn` claim the pin, configure it and return a [`Result`](/api/result) with the handle. A GPIO pin has one owner at a time: if another handle, a peripheral such as `Pwm` or `Spi`, or the console already holds it, you get a `GpioInUse` error that names the owner. Call `end()` to release the pin.

## Usage

```ts twoslash
import {debounceTime, distinctUntilChanged} from 'mikro/observable/operators'
import {DigitalIn, DigitalOut} from 'mikro/gpio'

// An active-low LED and a button that pulls the pin to 0 while pressed.
const led = DigitalOut(15, {initial: 1}).orPanic('Failed to configure LED pin')
const button = DigitalIn(9, {pull: 'up'}).orPanic('Failed to configure button')

button.onChange.pipe(debounceTime(20), distinctUntilChanged()).subscribe((level) => {
  led.write(level)
})
```

## Functions

### DigitalOut(gpio, options?)

```ts
function DigitalOut(gpio: number, options?: DigitalOutOptions): Result<DigitalOut, GpioError>
```

Claims a pin as a digital output. The `initial` level is applied before the pin becomes an output, so the pin does not pulse on creation.

To stop driving a pin and let it float, call `end()` on the output, then claim the same GPIO with `DigitalIn(gpio)`.

```ts twoslash
import {DigitalOut} from 'mikro/gpio'
// ---cut---
const led = DigitalOut(20).orPanic('Failed to configure LED pin')
led.write(1)
```

### DigitalIn(gpio, options?)

```ts
function DigitalIn(gpio: number, options?: DigitalInOptions): Result<DigitalIn, GpioError>
```

Claims a pin as a digital input.

```ts twoslash
import {DigitalIn} from 'mikro/gpio'
// ---cut---
const button = DigitalIn(9, {pull: 'up'}).orPanic('Failed to configure button')
const pressed = button.read() === 0
```

### AnalogIn(gpio, options?)

```ts
function AnalogIn(gpio: number, options?: AnalogInOptions): Result<AnalogIn, GpioError>
```

Claims a pin as an analog input. The GPIO must be an input of ADC1, the first of the chip's analog-to-digital converters; check the chip's pinout for ADC1 channels. Any other GPIO returns `InvalidGpio`.

```ts twoslash
import {AnalogIn} from 'mikro/gpio'
// ---cut---
const pot = AnalogIn(2).orPanic('Failed to configure ADC pin')
const result = pot.readMillivolts()
if (result.ok) {
  console.log('Voltage: %d mV', result.value)
}
```

## Handles

All handles have these members:

- `gpio: number`: the GPIO number.
- `end(): void`: releases the pin. Calling it again does nothing. After `end()`, `write` does nothing, reads still read the pin, and a new `onChange` subscriber completes at once. The first `write` or read after `end()` prints a warning, since it usually means the code kept a handle it no longer owns.

### DigitalOut

#### output.write(level)

```ts
write(level: 0 | 1): void
```

Drives the pin low (`0`) or high (`1`). A GPIO write cannot fail on a live handle, so it returns nothing.

### DigitalIn

#### input.read()

```ts
read(): 0 | 1
```

Returns the pin's level: `0` for low, `1` for high.

#### input.onChange

```ts
readonly onChange: Observable<0 | 1>
```

Emits the pin's level each time it changes. Edges that arrive within one pass of the event loop are combined, so each value differs from the one before it. Buttons and switches bounce for a few milliseconds; use `debounceTime` from `mikro/observable/operators` to wait for the level to settle. After `debounceTime`, two values in a row can be equal, because a short bounce can return to the level it started from. Add `distinctUntilChanged()` to drop the repeat.

Reading `onChange` keeps the handle alive until you call `end()`, even if your code drops its own reference. `end()` completes the stream.

### AnalogIn

#### input.read()

```ts
read(): Result<number, GpioError>
```

Returns a 12-bit integer (0 to 4095) proportional to the input voltage.

#### input.readMillivolts()

```ts
readMillivolts(): Result<number, GpioError>
```

Returns the calibrated input voltage in millivolts.

## Types

### DigitalOutOptions

```ts
interface DigitalOutOptions {
  initial?: 0 | 1 // default: 0
}
```

### DigitalInOptions

```ts
interface DigitalInOptions {
  pull?: 'up' | 'down' | 'none' // default: 'none'
}
```

Input-only GPIOs (ESP32 GPIO 34 to 39) have no internal pull resistors, so `pull: 'up'` or `'down'` on them returns `InvalidGpio`. Use an external resistor instead.

### AnalogInOptions

```ts
interface AnalogInOptions {
  attenuation?: Attenuation // default: '11db'
}
```

### Attenuation

ADC attenuation setting, controls the measurable voltage range.

```ts
type Attenuation = '0db' | '2.5db' | '6db' | '11db'
```

| Value     | Voltage range          |
| --------- | ---------------------- |
| `'0db'`   | 0 to 750 mV            |
| `'2.5db'` | 0 to 1050 mV           |
| `'6db'`   | 0 to 1300 mV           |
| `'11db'`  | 0 to 2500 mV (default) |

## Errors

### GpioError

| Variant                  | Fields                             | Description                                                                            |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `GpioInUse`              | `owner: string`, `message: string` | Another handle, peripheral or the console holds the pin                                |
| `InvalidGpio`            | `message: string`                  | The pin cannot be used this way, such as an input-only pin as an output or with a pull |
| `ConfigFailed`           | `message: string`                  | ESP-IDF rejected the configuration; `message` names the call and the error code        |
| `ReadFailed`             | `message: string`                  | An analog read failed                                                                  |
| `CalibrationUnavailable` |                                    | The chip has no ADC calibration data for `readMillivolts()`                            |

`Pwm` and `NeoPixel` also return `GpioInUse`, and `Spi`, `I2c`, `Uart` and `I2s` return it from `begin()`.

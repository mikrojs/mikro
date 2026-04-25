---
title: pin
description: GPIO digital and analog I/O
---

# pin

```ts twoslash
import {pinMode, digitalWrite, digitalRead, analogRead, analogReadMillivolts} from 'mikrojs/pin'
```

Control GPIO pins for digital and analog I/O.

## Functions

### pinMode(pin, mode)

Configure a pin's direction.

```ts
function pinMode(pin: number, mode: PinMode): Result<void, PinError>
```

**Parameters:**

- `pin`: GPIO pin number
- `mode`: `'INPUT'`, `'OUTPUT'`, or `'INPUT_PULLUP'`

```ts twoslash
import {pinMode} from 'mikrojs/pin'
// ---cut---
pinMode(20, 'OUTPUT').orPanic('Failed to configure pin')
```

### digitalWrite(pin, value)

Set a pin HIGH (1) or LOW (0).

```ts
function digitalWrite(pin: number, value: 0 | 1): Result<void, PinError>
```

```ts twoslash
import {digitalWrite} from 'mikrojs/pin'
// ---cut---
digitalWrite(20, 1) // pin HIGH
digitalWrite(20, 0) // pin LOW
```

### digitalRead(pin)

Read the current state of a pin.

```ts
function digitalRead(pin: number): 0 | 1
```

```ts twoslash
import {digitalRead} from 'mikrojs/pin'
// ---cut---
const state = digitalRead(5)
console.log(state ? 'HIGH' : 'LOW')
```

### analogRead(pin, options?)

Read the raw ADC value from a pin.

```ts
function analogRead(pin: number, options?: AnalogReadOptions): Result<number, PinError>
```

Returns a 12-bit integer (0–4095) proportional to the input voltage.

```ts twoslash
import {analogRead} from 'mikrojs/pin'
// ---cut---
const result = analogRead(2)
if (result.ok) {
  console.log('ADC value: %d', result.value)
}
```

### analogReadMillivolts(pin, options?)

Read a calibrated voltage from a pin.

```ts
function analogReadMillivolts(pin: number, options?: AnalogReadOptions): Result<number, PinError>
```

Returns the input voltage in millivolts.

```ts twoslash
import {analogReadMillivolts} from 'mikrojs/pin'
// ---cut---
const result = analogReadMillivolts(2)
if (result.ok) {
  console.log('Voltage: %d mV', result.value)
}
```

## Types

### PinMode

```ts
type PinMode = 'INPUT' | 'OUTPUT' | 'INPUT_PULLUP'
```

### Attenuation

ADC attenuation setting, controls the measurable voltage range.

```ts
type Attenuation = '0db' | '2.5db' | '6db' | '11db'
```

| Value     | Voltage range       |
| --------- | ------------------- |
| `'0db'`   | 0–750 mV            |
| `'2.5db'` | 0–1050 mV           |
| `'6db'`   | 0–1300 mV           |
| `'11db'`  | 0–2500 mV (default) |

### AnalogReadOptions

```ts
interface AnalogReadOptions {
  attenuation?: Attenuation // default: '11db'
}
```

## Errors

### PinError

| Variant         | Fields            | Description                       |
| --------------- | ----------------- | --------------------------------- |
| `SetModeFailed` | `message: string` | Failed to configure pin mode      |
| `WriteFailed`   | `message: string` | Failed to write to pin            |
| `AdcInitFailed` | `message: string` | Failed to initialize ADC          |
| `InvalidAdcPin` | —                 | Pin does not support analog reads |

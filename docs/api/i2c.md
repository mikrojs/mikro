---
title: i2c
description: I2C bus communication for sensors and peripherals
---

# i2c

```ts twoslash
import {I2c} from 'mikro/i2c'
```

Communicate with I2C devices such as temperature sensors, displays, and EEPROMs.

## Usage

```ts twoslash
import {I2c} from 'mikro/i2c'

const bus = I2c(0, {sda: 6, scl: 7, freq: 400000}).orPanic('I2C init failed')

// Scan for devices
const devices = bus.scan().orPanic('scan failed')
console.log('Found devices at: %o', Array.from(devices))

// Read 2 bytes from device at address 0x44
const data = bus.read(0x44, 2).orPanic('read failed')

bus.end()
```

## Functions

### I2c(bus, options)

```ts
function I2c(bus: number, options: I2cOptions): Result<I2c, I2cError>
```

Claims the `sda` and `scl` pins, starts the bus and returns a [`Result`](/api/result) with the handle. Both pins must be able to drive a signal, or you get `InvalidGpio`. If another handle, a peripheral or the console holds one of them, you get `GpioInUse`.

**Parameters:**

- `bus`: I2C controller. The ESP32 and ESP32-S3 have buses 0 and 1; the ESP32-C3 and ESP32-C6 have bus 0 only. Any other number returns `InvalidParam`.
- `options`: see [I2cOptions](#i2coptions)

## Methods

### bus.end()

```ts
end(): void
```

Deletes the bus and releases its GPIO pins. Calling it again does nothing. After `end()`, `write()` does nothing, `read()` and `scan()` return an empty array, and the first such call prints a warning. The handle keeps the hardware and its GPIO pins until you call `end()`, even when your code no longer refers to the handle.

### bus.read(address, bytes)

```ts
read(address: number, bytes: number): Result<Uint8Array, I2cError>
```

Read `bytes` bytes from the device at `address`. An address outside 0 to 0x7f, or a byte count that is not a whole number from 1 to 65535, returns `InvalidParam`.

### bus.write(address, data, stop?)

```ts
write(address: number, data: Uint8Array, stop?: boolean): Result<void, I2cError>
```

Write `data` to the device at `address`. Set `stop` to `false` to send without a stop condition (for repeated start).

### bus.scan()

```ts
scan(): Result<Uint8Array, I2cError>
```

Scan the bus and return an array of addresses that responded.

## Types

### I2cOptions

```ts
interface I2cOptions {
  sda: number // SDA pin
  scl: number // SCL pin
  freq?: number // clock frequency in Hz (default: 100000)
  timeout?: number // timeout per operation in ms (default: 100)
}
```

## Errors

### I2cError

| Variant           | Fields             | Description                                                     |
| ----------------- | ------------------ | --------------------------------------------------------------- |
| `GpioInUse`       | `owner`, `message` | A pin is held by another handle, peripheral or the console      |
| `InvalidGpio`     | `message`          | The chip has no such GPIO, or the GPIO cannot drive a signal    |
| `InvalidParam`    | `message`          | The bus, an option, an address or a read length is out of range |
| `BusInitFailed`   | `message`          | Failed to initialize the bus                                    |
| `AddDeviceFailed` | `message`          | Failed to add device to bus                                     |
| `WriteFailed`     | `message`          | Write operation failed                                          |
| `WriteTooLarge`   | —                  | Write data exceeds buffer size                                  |
| `ReadFailed`      | `message`          | Read operation failed                                           |

---
title: i2c
description: I2C bus communication for sensors and peripherals
---

# i2c

```ts twoslash
import {I2c} from 'mikrojs/i2c'
```

Communicate with I2C devices such as temperature sensors, displays, and EEPROMs.

## Usage

```ts twoslash
import {I2c} from 'mikrojs/i2c'

const bus = new I2c(0, {sda: 6, scl: 7, freq: 400000})
bus.begin().orPanic('I2C init failed')

// Scan for devices
const devices = bus.scan().orPanic('scan failed')
console.log('Found devices at: %o', Array.from(devices))

// Read 2 bytes from device at address 0x44
const data = bus.read(0x44, 2).orPanic('read failed')

bus.end()
```

## Constructor

### new I2c(busNo, options?)

```ts
new I2c(busNo: 0 | 1, options?: I2cOptions)
```

**Parameters:**

- `busNo`: I2C bus number (0 or 1)
- `options`: see [I2cOptions](#i2coptions)

## Methods

### bus.begin()

```ts
begin(): Result<void, I2cError>
```

Initialize the I2C bus. Must be called before any read/write/scan operations.

### bus.end()

```ts
end(): Result<void, I2cError>
```

Deinitialize the bus and release resources.

### bus.read(address, bytes)

```ts
read(address: number, bytes: number): Result<Uint8Array, I2cError>
```

Read `bytes` bytes from the device at `address`.

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
interface I2cBaseOptions {
  freq?: number // clock frequency in Hz (default: 100000)
  timeout?: number // timeout in ms
}

interface I2cOptionsWithPins extends I2cBaseOptions {
  sda: number // SDA pin
  scl: number // SCL pin
}

type I2cOptions = I2cBaseOptions | I2cOptionsWithPins
```

If `sda` and `scl` are omitted, the bus uses the board's default I2C pins.

## Errors

### I2cError

| Variant           | Fields    | Description                    |
| ----------------- | --------- | ------------------------------ |
| `BusInitFailed`   | `message` | Failed to initialize the bus   |
| `BusDeinitFailed` | `message` | Failed to deinitialize         |
| `NotStarted`      | —         | `begin()` was not called       |
| `MissingPins`     | —         | Pins required but not provided |
| `AddDeviceFailed` | `message` | Failed to add device to bus    |
| `WriteFailed`     | `message` | Write operation failed         |
| `WriteTooLarge`   | —         | Write data exceeds buffer size |
| `ReadFailed`      | `message` | Read operation failed          |

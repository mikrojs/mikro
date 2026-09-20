---
title: spi
description: SPI bus communication
---

# spi

```ts twoslash
import {Spi} from 'mikro/spi'
```

Communicate with SPI devices such as displays, SD cards, and radio modules.

## Usage

```ts twoslash
import {Spi} from 'mikro/spi'

const spi = Spi(1, {clk: 4, mosi: 5, miso: 6, cs: 7, freq: 1000000}).orPanic('SPI init failed')

// Write data
spi.write(new Uint8Array([0x01, 0x02])).orPanic('write failed')

// Transfer (write and read simultaneously)
const response = spi.transfer(new Uint8Array([0x00, 0x00])).orPanic('transfer failed')

spi.end()
```

## Functions

### Spi(host, options)

```ts
function Spi(host: number, options: SpiOptions): Result<Spi, SpiError>
```

Claims the pins, starts the bus and returns a [`Result`](/api/result) with the handle. `clk`, `mosi` and `cs` must be able to drive a signal, or you get `InvalidGpio`. If another handle, a peripheral or the console holds one of the pins, you get `GpioInUse`.

**Parameters:**

- `host`: SPI host controller. Host 1 is SPI2 and host 2 is SPI3; SPI0 and SPI1 drive the flash. The ESP32, ESP32-S2 and ESP32-S3 have hosts 1 and 2, and chips with one general-purpose SPI controller, such as the ESP32-C3 and ESP32-C6, have host 1 only. Any other number returns `InvalidParam`.
- `options`: see [SpiOptions](#spioptions)

## Methods

### spi.end()

```ts
end(): void
```

Frees the bus and releases its GPIO pins. Calling it again does nothing. After `end()`, `write()` does nothing, `transfer()` returns an empty array, and the first such call prints a warning. The handle keeps the hardware and its GPIO pins until you call `end()`, even when your code no longer refers to the handle.

### spi.transfer(data)

```ts
transfer(data: Uint8Array): Result<Uint8Array, SpiError>
```

Full-duplex transfer: sends `data` and returns the bytes received simultaneously.

### spi.write(data)

```ts
write(data: Uint8Array): Result<void, SpiError>
```

Write-only transfer. Discards received data.

## Types

### SpiOptions

```ts
interface SpiOptions {
  clk: number // clock pin
  mosi: number // MOSI (Master Out Slave In) pin
  miso?: number // MISO pin (optional for write-only)
  cs?: number // chip select pin (optional, manage manually if omitted)
  freq?: number // clock frequency in Hz (default: 1000000)
  mode?: 0 | 1 | 2 | 3 // SPI mode (default: 0)
}
```

## Errors

### SpiError

| Variant           | Fields             | Description                                                  |
| ----------------- | ------------------ | ------------------------------------------------------------ |
| `GpioInUse`       | `owner`, `message` | A pin is held by another handle, peripheral or the console   |
| `InvalidGpio`     | `message`          | The chip has no such GPIO, or the GPIO cannot drive a signal |
| `InvalidParam`    | `message`          | The host or frequency is out of range                        |
| `BusInitFailed`   | `message`          | Failed to initialize the bus                                 |
| `AddDeviceFailed` | `message`          | Failed to add device to bus                                  |
| `TransferFailed`  | `message`          | Full-duplex transfer failed                                  |
| `WriteFailed`     | `message`          | Write operation failed                                       |

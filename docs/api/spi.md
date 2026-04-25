---
title: spi
description: SPI bus communication
---

# spi

```ts twoslash
import {Spi} from 'mikrojs/spi'
```

Communicate with SPI devices such as displays, SD cards, and radio modules.

## Usage

```ts twoslash
import {Spi} from 'mikrojs/spi'

const spi = new Spi(1, {clk: 4, mosi: 5, miso: 6, cs: 7, freq: 1000000})
spi.begin().orPanic('SPI init failed')

// Write data
spi.write(new Uint8Array([0x01, 0x02])).orPanic('write failed')

// Transfer (write and read simultaneously)
const response = spi.transfer(new Uint8Array([0x00, 0x00])).orPanic('transfer failed')

spi.end()
```

## Constructor

### new Spi(hostNo, options)

```ts
new Spi(hostNo: 1 | 2, options: SpiOptions)
```

**Parameters:**

- `hostNo`: SPI host number (1 or 2)
- `options`: see [SpiOptions](#spioptions)

## Methods

### spi.begin()

```ts
begin(): Result<void, SpiError>
```

Initialize the SPI bus. Must be called before any transfer/write operations.

### spi.end()

```ts
end(): Result<void, SpiError>
```

Deinitialize the bus and release resources.

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

| Variant           | Fields    | Description                  |
| ----------------- | --------- | ---------------------------- |
| `BusInitFailed`   | `message` | Failed to initialize the bus |
| `AddDeviceFailed` | `message` | Failed to add device to bus  |
| `NotStarted`      | —         | `begin()` was not called     |
| `MissingPins`     | —         | Required pins not provided   |
| `TransferFailed`  | `message` | Full-duplex transfer failed  |
| `WriteFailed`     | `message` | Write operation failed       |

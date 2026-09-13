---
title: uart
description: UART serial communication
---

# uart

```ts twoslash
import {Uart} from 'mikro/uart'
```

Communicate with serial peripherals such as cellular modems, GPS modules, sensors, and other microcontrollers over UART.

## Usage

```ts twoslash
import {Uart} from 'mikro/uart'

const uart = Uart(1, {tx: 17, rx: 16, baudRate: 9600}).orPanic('UART init failed')

// Write data
uart.write(new Uint8Array([0x41, 0x54, 0x0d, 0x0a])).orPanic('write failed')

// Read data (async iterator of Result<Uint8Array, UartError>)
const reader = uart.read().orPanic('read failed')
for await (const chunk of reader) {
  if (!chunk.ok) {
    console.error('uart read failed:', chunk.error)
    break
  }
  console.log('received: %s', new TextDecoder().decode(chunk.value))
  break
}

uart.end()
```

## Functions

### Uart(port, options)

```ts
function Uart(
  port: number,
  options: {tx: number; rx: number; baudRate: number},
): Result<Uart & UartTx & UartRx, UartError>
function Uart(
  port: number,
  options: {tx: number; baudRate: number},
): Result<Uart & UartTx, UartError>
function Uart(
  port: number,
  options: {rx: number; baudRate: number},
): Result<Uart & UartRx, UartError>
```

Claims the pins, installs the UART driver and returns a [`Result`](/api/result) with the handle. The driver is hardcoded to 8N1 (8 data bits, no parity, 1 stop bit) with a 2048-byte receive buffer. `tx` must be able to drive a signal, or you get `InvalidGpio`. If another handle, a peripheral or the console holds a pin, you get `GpioInUse`.

Provide at least one of `tx` or `rx`. The available methods depend on which pins are provided:

- **Both TX and RX**: `write()` and `read()` available
- **TX only**: `write()` available, `read()` is a compile-time error
- **RX only**: `read()` available, `write()` is a compile-time error

**Parameters:**

- `port`: UART port number (0, 1, or 2 depending on chip). A port the chip lacks returns `InvalidParam`.
- `options`: see below

| Option     | Type     | Required | Description                            |
| ---------- | -------- | -------- | -------------------------------------- |
| `tx`       | `number` | no\*     | TX GPIO pin                            |
| `rx`       | `number` | no\*     | RX GPIO pin                            |
| `baudRate` | `number` | yes      | Baud rate (for example 9600 or 115200) |

\* At least one of `tx` or `rx` must be provided.

::: warning UART0
The firmware claims the pins of every console it installs. On chips with USB Serial/JTAG (ESP32-C6, ESP32-S3, and similar), the default firmware installs only the USB console, so the UART0 pins are free. If you pass a console pin to `Uart()`, it returns a `GpioInUse` error with `owner: 'console'`. If you open UART0 on other pins while the console uses UART0, `Uart()` returns `DriverInstallFailed`.
:::

## Methods

### uart.end()

```ts
end(): void
```

Uninstall the UART driver and release the GPIO pins. An active `read()` iterator completes. Calling `end()` again does nothing. After `end()`, `write()` does nothing, `read()` returns an iterable that completes at once, and the first such call prints a warning.

### uart.write(data)

```ts
write(data: Uint8Array): Result<void, UartError>
```

Write bytes to the TX pin. Blocks until all bytes are written to the FIFO. Only available when `tx` was passed to `Uart()`.

### uart.read()

```ts
read(): Result<AsyncIterable<Result<Uint8Array, UartError>>, UartError>
```

Start reading from the RX pin. The outer Result wraps the initial open. The iterable yields `Result<Uint8Array, UartError>` chunks and completes when `end()` is called. Only available when `rx` was passed to `Uart()`.

Each yielded chunk contains whatever bytes have accumulated in the receive buffer since the last read. Chunk boundaries do not correspond to message boundaries; higher-level framing (line splitting, packet parsing) is the caller's responsibility.

Only one reader can be active at a time. Calling `read()` while another reader is active returns an `AlreadyReading` error. Breaking out of the `for await` loop cleanly closes the reader, and `read()` can be called again.

```ts twoslash
import {Uart} from 'mikro/uart'
const uart = Uart(1, {tx: 17, rx: 16, baudRate: 115200}).orPanic('UART init failed')
// ---cut---
const reader = uart.read().orPanic('read failed')

for await (const chunk of reader) {
  if (!chunk.ok) {
    console.error('uart read failed:', chunk.error)
    break
  }
  const text = new TextDecoder().decode(chunk.value)
  console.log(text)
  if (text.includes('OK')) break // break is safe, read() can be called again
}
```

## Types

### UartTx

```ts
interface UartTx {
  write(data: Uint8Array): Result<void, UartError>
}
```

### UartRx

```ts
interface UartRx {
  read(): Result<AsyncIterable<Result<Uint8Array, UartError>>, UartError>
}
```

## Errors

### UartError

| Variant               | Fields             | Description                                                |
| --------------------- | ------------------ | ---------------------------------------------------------- |
| `GpioInUse`           | `owner`, `message` | A pin is held by another handle, peripheral or the console |
| `InvalidGpio`         | `message`          | The chip has no such GPIO, or `tx` cannot drive a signal   |
| `InvalidParam`        | `message`          | The port or baud rate is out of range                      |
| `DriverInstallFailed` | `message`          | UART driver installation failed                            |
| `SetPinFailed`        | `message`          | GPIO pin configuration failed                              |
| `WriteFailed`         | `message`          | Write operation failed                                     |
| `ReadFailed`          | `message`          | Read operation failed                                      |
| `AlreadyReading`      | --                 | Another `read()` iterator is still active                  |
| `NoRxPin`             | --                 | `read()` called but no RX pin configured                   |
| `NoTxPin`             | --                 | `write()` called but no TX pin configured                  |

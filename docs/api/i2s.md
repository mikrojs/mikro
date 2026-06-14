---
title: i2s
description: I2S audio input and output
---

# i2s

```ts twoslash
import {I2s} from 'mikro/i2s'
```

Stream audio over I2S: drive an amp/DAC (MAX98357A, UDA1334, PCM5102) or read an I2S/PDM microphone (SPH0645, ICS-43434, INMP441). Samples cross the boundary as typed arrays; output is an async queued `write()`, input is a blocking bulk `capture()` tuned for streaming.

## Usage

Capture ~100 ms from a mic and print a level reading:

```ts twoslash
import {I2s} from 'mikro/i2s'

const mic = new I2s(0, {
  bclk: 4,
  ws: 5,
  din: 6,
  sampleRate: 16000,
  bitsPerSample: 32,
  channels: 'mono',
})
mic.begin().orPanic('I2S init failed')

const frame = mic.capture(1600).orPanic('capture failed')
let peak = 0
for (const sample of frame) {
  const mag = Math.abs(sample)
  if (mag > peak) peak = mag
}
console.log('peak: %d', peak)

mic.end()
```

## Constructor

### new I2s(port, options)

```ts
new I2s(port: number, options: I2sStdTxRxOptions): I2sBase & I2sTx & I2sRx
new I2s(port: number, options: I2sStdTxOptions): I2sBase & I2sTx
new I2s(port: number, options: I2sStdRxOptions): I2sBase & I2sRx
new I2s(port: number, options: I2sPdmRxOptions): I2sBase & I2sRx
```

Direction is inferred from the pins you provide. The available methods depend on direction:

- **`dout` provided**: `write()` available (transmit).
- **`din` provided**: `capture()` available (receive).
- **both**: full-duplex (`write()` and `capture()`). TX and RX share one BCLK/WS clock.

**Parameters:**

- `port`: I2S controller number (0 on most chips; 0 or 1 on the S3 and classic ESP32).
- `options`: see below.

### Standard mode (`mode: 'std'`, default)

| Option          | Type                 | Required | Description                                         |
| --------------- | -------------------- | -------- | --------------------------------------------------- |
| `sampleRate`    | `number`             | yes      | Sample rate in Hz (e.g. 16000, 44100)               |
| `bitsPerSample` | `16 \| 32`           | no       | Bits per sample (default 16)                        |
| `channels`      | `'mono' \| 'stereo'` | no       | Slot mode (default `'stereo'`)                      |
| `bclk`          | `number`             | yes      | Bit clock (SCK) pin                                 |
| `ws`            | `number`             | yes      | Word select / LR clock pin                          |
| `dout`          | `number`             | no\*     | Data-out pin (to an amp/DAC); enables `write()`     |
| `din`           | `number`             | no\*     | Data-in pin (from a mic/codec); enables `capture()` |
| `dmaFrames`     | `number`             | no       | Frames per DMA buffer (audio-tuned default)         |
| `dmaBuffers`    | `number`             | no       | Number of DMA buffers (audio-tuned default)         |

\* At least one of `dout` or `din` must be provided.

### PDM mode (`mode: 'pdm'`)

PDM is receive-only, for digital MEMS mics (some INMP441 boards, SPM1423).

| Option          | Type                 | Required | Description                  |
| --------------- | -------------------- | -------- | ---------------------------- |
| `sampleRate`    | `number`             | yes      | Sample rate in Hz            |
| `bitsPerSample` | `16 \| 32`           | no       | Bits per sample (default 16) |
| `channels`      | `'mono' \| 'stereo'` | no       | Slot mode (default `'mono'`) |
| `clk`           | `number`             | yes      | PDM clock pin                |
| `din`           | `number`             | yes      | PDM data-in pin              |
| `dmaFrames`     | `number`             | no       | Frames per DMA buffer        |
| `dmaBuffers`    | `number`             | no       | Number of DMA buffers        |

::: warning PDM support is chip-dependent
PDM RX is available on the classic ESP32 and ESP32-S3, but not on every C/H-series target. On a chip without PDM RX, `begin()` returns a `ChannelInitFailed` error.
:::

## Samples

`write()` accepts typed sample arrays keyed to `bitsPerSample`:

- `bitsPerSample: 16` → `Int16Array`
- `bitsPerSample: 32` → `Int32Array`

Stereo data is interleaved `L,R,L,R…`; deinterleave it yourself. `capture()` always returns a packed `Int16Array` (it reads a 32-bit mono channel and converts in C).

::: tip Quiet 24-bit mics
Common I2S mics (INMP441, ICS-43434) are 24-bit samples left-justified in 32-bit slots and read quiet. Configure `bitsPerSample: 32, channels: 'mono'` and `capture()` packs them to usable 16-bit `Int16Array` values from the high bits; pass `gainBits` to boost the quiet signal.
:::

## Methods

### i2s.begin()

```ts
begin(): Result<void, I2sError>
```

Allocate the I2S channels, configure pins, and start the DMA. Must be called before `write()` or `capture()`. Calling `begin()` on an already-started instance is a no-op.

### i2s.end()

```ts
end(): Result<void, I2sError>
```

Stop the DMA and release the channels, and settle any pending `write()` calls. Calling `end()` on an already-stopped instance is a no-op.

### i2s.write(data)

```ts
write(data: I2sSamples | Uint8Array): Promise<Result<void, I2sError>>
```

Queue samples for transmission. Resolves once the chunk has been handed to DMA. Only available when `dout` was provided.

A small bounded queue double-buffers writes so back-to-back `await`ed chunks play gapless. If you produce faster than realtime the queue fills and `write()` resolves `err(QueueFull)`; pace your writes (await the previous one, or drive from a timer). Element width must match `bitsPerSample` (`Int16Array` for 16-bit, `Int32Array` for 32-bit); a mismatch resolves `err(InvalidParam)`. A `Uint8Array` is sent as raw bytes.

For mono output, samples drive the left slot (relevant for mono amps like the MAX98357A).

### i2s.capture(frames, options?)

```ts
capture(frames: number, options?: {gainBits?: number}): Result<Int16Array, I2sError>
```

Blocking bulk read: returns exactly `frames` mono samples, already converted to 16-bit PCM in C, as one packed `Int16Array`. Requires a 32-bit mono channel (`bitsPerSample: 32, channels: 'mono'`) and a `din` pin, after `begin()`.

It does the DMA read, the 24-in-32 → 16-bit conversion, the optional gain, and the packing in a single native call, with no per-chunk allocation or async machinery, so it can sustain high sample rates (e.g. streaming 48 kHz over HTTP).

The cost is that it **blocks the event loop** for roughly `frames / sampleRate` seconds while it drains the DMA, so timers and other async work stall during that window. Size `frames` to trade throughput against responsiveness: smaller frames block for less time and let the loop run more often between captures. Use it in a dedicated capture or streaming loop, not where the rest of the app must stay responsive.

`options.gainBits` left-shifts each sample (clamped to int16) to boost the typically-quiet mic signal; default `0` (faithful 16-bit levels).

For mono input, samples come from the left slot. INMP441-class mics select their slot via the SEL pin; if you capture silence, the mic is likely on the other slot, so wire SEL accordingly.

```ts twoslash
import {I2s} from 'mikro/i2s'
const mic = new I2s(0, {
  bclk: 4,
  ws: 5,
  din: 6,
  sampleRate: 48000,
  bitsPerSample: 32,
  channels: 'mono',
})
mic.begin().orPanic('I2S init failed')
// ---cut---
// One 100 ms frame of 16-bit PCM, ready to send or write to a file.
const frame = mic.capture(4800).orPanic('capture failed')
console.log('captured %d samples', frame.length)
```

## Types

### I2sSamples

```ts
type I2sSamples = Int16Array | Int32Array
```

### I2sTx

```ts
interface I2sTx {
  write(data: I2sSamples | Uint8Array): Promise<Result<void, I2sError>>
}
```

### I2sRx

```ts
interface I2sRx {
  capture(frames: number, options?: {gainBits?: number}): Result<Int16Array, I2sError>
}
```

## Errors

### I2sError

| Variant             | Fields    | Description                                       |
| ------------------- | --------- | ------------------------------------------------- |
| `ChannelInitFailed` | `message` | Channel allocation or mode init failed            |
| `InvalidParam`      | `message` | Invalid parameters (e.g. sample width mismatch)   |
| `WriteFailed`       | `message` | Transmit failed                                   |
| `ReadFailed`        | `message` | Receive failed                                    |
| `NotStarted`        | --        | `begin()` was not called                          |
| `QueueFull`         | --        | TX queue is full (producing faster than realtime) |
| `NoRxPin`           | --        | `capture()` called but no `din` configured        |
| `NoTxPin`           | --        | `write()` called but no `dout` configured         |

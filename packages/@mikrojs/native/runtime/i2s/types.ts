/* mikro/i2s, declared here and implemented in C (mik_i2s.cpp). */

import type {GpioInUse} from '../gpio/types.js'
import type {Result} from '../result/types.js'

/**
 * Samples crossing the I2S boundary. `Int16Array` when configured 16-bit,
 * `Int32Array` when 32-bit. Stereo data is interleaved `L,R,L,R…`.
 *
 * @public
 */
export type I2sSamples = Int16Array | Int32Array

/**
 * @public
 */
export interface I2sStdBaseOptions {
  mode?: 'std'
  /** Sample rate in Hz (e.g. 16000, 44100). */
  sampleRate: number
  /** Bits per sample. Default 16. */
  bitsPerSample?: 16 | 32
  /** Slot mode. Default 'stereo'. */
  channels?: 'mono' | 'stereo'
  /** Bit clock (SCK) pin. */
  bclk: number
  /** Word select / LR clock pin. */
  ws: number
  /** Frames per DMA buffer. Audio-tuned default; raise for fewer wakeups, lower for less latency. */
  dmaFrames?: number
  /** Number of DMA buffers. Audio-tuned default. */
  dmaBuffers?: number
}

/**
 * @public
 */
export interface I2sStdTxOptions extends I2sStdBaseOptions {
  /** Data-out pin (to an amp/DAC). */
  dout: number
  din?: undefined
}

/**
 * @public
 */
export interface I2sStdRxOptions extends I2sStdBaseOptions {
  /** Data-in pin (from a mic/codec). */
  din: number
  dout?: undefined
}

/**
 * @public
 */
export interface I2sStdTxRxOptions extends I2sStdBaseOptions {
  dout: number
  din: number
}

/**
 * PDM is receive-only and chip-dependent (classic ESP32 and S3 support it; some
 * C/H-series targets do not). On unsupported chips `I2s()` returns
 * `ChannelInitFailed`.
 *
 * @public
 */
export interface I2sPdmRxOptions {
  mode: 'pdm'
  sampleRate: number
  bitsPerSample?: 16 | 32
  /** Default 'mono'. */
  channels?: 'mono' | 'stereo'
  /** PDM clock pin. */
  clk: number
  /** PDM data-in pin. */
  din: number
  dmaFrames?: number
  dmaBuffers?: number
}

/**
 * @public
 */
export type I2sError =
  | GpioInUse
  | {name: 'InvalidGpio'; message: string}
  | {name: 'ChannelInitFailed'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'ReadFailed'; message: string}
  | {name: 'QueueFull'}
  | {name: 'NoRxPin'}
  | {name: 'NoTxPin'}

/**
 * @public
 */
export interface I2sTx {
  /**
   * Queue samples for transmission. Resolves once the chunk has been handed to
   * DMA. A small bounded queue double-buffers for gapless playback; producing
   * faster than realtime resolves `err(QueueFull)`. Element width must match
   * `bitsPerSample` (or be a raw `Uint8Array`); a mismatch is `err(InvalidParam)`.
   */
  write(data: I2sSamples | Uint8Array): Promise<Result<void, I2sError>>
}

/**
 * @public
 */
export interface I2sRx {
  /**
   * Blocking bulk capture: read exactly `frames` mono samples (from a 32-bit
   * mono channel), converted to 16-bit PCM in C and returned as one packed
   * `Int16Array`. `gainBits` left-shifts each sample by that many bits (clamped)
   * for a louder result. No per-chunk allocation or async machinery, so it can
   * sustain high sample rates. It BLOCKS the event loop for ~`frames`/sample-rate
   * while it drains the DMA; size `frames` to trade throughput against how often
   * the loop runs between captures, and use it only in a dedicated capture/stream
   * loop, not where timers and other async must stay responsive.
   */
  capture(frames: number, options?: {gainBits?: number}): Result<Int16Array, I2sError>
}

/**
 * @public
 */
export interface I2s {
  /**
   * Stops the DMA, deletes the channels and releases the GPIO pins. Queued
   * writes resolve with `ok()`. Calling it again does nothing. Afterwards
   * `write()` resolves `ok()` and `capture()` returns an empty array; the first
   * such call prints a warning.
   */
  end(): void
}

/**
 * Claims the pins and starts I2S channels on a controller. Direction follows
 * the pins: `dout` enables `write()`, `din` enables `capture()`.
 * @public
 */
export declare function I2s(
  port: number,
  options: I2sStdTxRxOptions,
): Result<I2s & I2sTx & I2sRx, I2sError>
export declare function I2s(port: number, options: I2sStdTxOptions): Result<I2s & I2sTx, I2sError>
export declare function I2s(port: number, options: I2sStdRxOptions): Result<I2s & I2sRx, I2sError>
export declare function I2s(port: number, options: I2sPdmRxOptions): Result<I2s & I2sRx, I2sError>

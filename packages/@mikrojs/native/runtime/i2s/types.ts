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
 * C/H-series targets do not). On unsupported chips `begin()` returns
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
  | {name: 'ChannelInitFailed'; message: string}
  | {name: 'InvalidParam'; message: string}
  | {name: 'WriteFailed'; message: string}
  | {name: 'ReadFailed'; message: string}
  | {name: 'NotStarted'}
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
export interface I2sBase {
  begin(): Result<void, I2sError>
  end(): Result<void, I2sError>
}

/**
 * @public
 */
export declare const I2s: {
  prototype: I2sBase
  new (port: number, options: I2sStdTxRxOptions): I2sBase & I2sTx & I2sRx
  new (port: number, options: I2sStdTxOptions): I2sBase & I2sTx
  new (port: number, options: I2sStdRxOptions): I2sBase & I2sRx
  new (port: number, options: I2sPdmRxOptions): I2sBase & I2sRx
}

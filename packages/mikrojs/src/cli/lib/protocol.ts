/**
 * Unified MIK Protocol — TLV-framed messaging between CLI and device.
 *
 * Frame format: [type: u8][length: u32le][payload: bytes]  (5-byte header)
 *
 * Replaces the previous separate REPL, deploy, and config protocols with
 * a single framing scheme. On connect the CLI sends CMD_HELLO; the device
 * replies with MSG_READY containing its identity. The device never sends
 * MSG_READY unprompted, which keeps the wire silent for passive viewers
 * (e.g. idf.py monitor).
 */

import {decode as decodeCbor} from 'cbor2'

// ── Escape hatch ───────────────────────────────────────────────────
// Raw CTRL_R byte triggers hard restart regardless of protocol state.
export const CTRL_R = 0x12

// ── Device → CLI message types ─────────────────────────────────────

export const MSG_READY = 0x01
export const MSG_LOG = 0x02
export const MSG_WARN = 0x03
export const MSG_ERROR = 0x04
export const MSG_RESULT = 0x05
export const MSG_INFO = 0x06
export const MSG_COMPLETIONS = 0x07
export const MSG_EVAL_ERROR = 0x08
export const MSG_PROMPT = 0x09
export const MSG_TEST = 0x0b
export const MSG_DEBUG = 0x0c
/** Emitted once after the last test file's run_done when the device drove
 *  a supervisor-mode manifest. Signals "no more tests coming" to the CLI. */
export const MSG_MANIFEST_DONE = 0x0d

export const MSG_OK = 0x80
export const MSG_ERR = 0x81
export const MSG_CHECKSUM_RESULT = 0x82
export const MSG_CONFIG_ENTRIES = 0x83
/** Chunk of file bytes streamed in response to CMD_FS_GET. Repeated
 *  zero-or-more times before a terminal MSG_OK. */
export const MSG_FS_CHUNK = 0x84

// ── CLI → Device command types ─────────────────────────────────────

export const CMD_EVAL = 0x10
export const CMD_COMPLETE = 0x11
export const CMD_DIRECTIVE = 0x13
export const CMD_EXIT = 0x14
export const CMD_HELLO = 0x15

/** Begins a streaming file PUT. Payload: u16le name_len | name | u32le total_size.
 *  Device opens the staged file and replies OK; body arrives in one or more
 *  CMD_DEPLOY_PUT_CHUNK frames so no single TLV frame ever exceeds the USJ
 *  RX ring. */
export const CMD_DEPLOY_PUT = 0x20
export const CMD_DEPLOY_DONE = 0x21
export const CMD_DEPLOY_ABORT = 0x22
export const CMD_DEPLOY_ERASE = 0x23
/** Appends body bytes to the file opened by the preceding CMD_DEPLOY_PUT.
 *  Payload is raw file data; device fwrites + replies OK per chunk and
 *  closes the file when total_remaining reaches zero. */
export const CMD_DEPLOY_PUT_CHUNK = 0x24
// 0x25 retired: deploy env mutation now flows through CMD_CONFIG_SET/DELETE.
export const CMD_DEPLOY_KEEP = 0x26
export const CMD_DEPLOY_CHECKSUM = 0x27
export const CMD_RESTART = 0x28
export const CMD_RUNTIME_PAUSE = 0x29
export const CMD_RUNTIME_RESUME = 0x2a
/** Pull a file off the device. Payload: u16le path_len | path.
 *  Device streams MSG_FS_CHUNK frames followed by a terminating MSG_OK,
 *  or MSG_ERR on failure. */
export const CMD_FS_GET = 0x2b

export const CMD_CONFIG_LIST = 0x40
export const CMD_CONFIG_SET = 0x41
export const CMD_CONFIG_DELETE = 0x42

/** Env entry flags */
export const ENV_FLAG_SECRET = 0x01

// ── Frame format ───────────────────────────────────────────────────

/** Header size: 1 byte type + 4 bytes u32le length */
export const HEADER_SIZE = 5

/** Sane ceiling on frame payload size. The wire format allows up to 4 GB, but
 * any MIK frame the CLI receives in practice is at most a few KB. This guards
 * against false-positive frame starts when the byte stream contains raw
 * boot-log text that happens to coincide with a valid message-type byte —
 * e.g. the banner's trailing `\r\n` is `0d 0a`, and `0x0d` (MSG_MANIFEST_DONE)
 * would otherwise have the parser read `0a 31 38 36` ("\n186") as a
 * ~907 MB length and stall forever waiting for the payload. */
export const MAX_FRAME_PAYLOAD = 256 * 1024

export interface Frame {
  type: number
  payload: Buffer
}

/** Build a TLV frame: [type: u8][length: u32le][payload] */
export function buildFrame(type: number, payload: string | Buffer = Buffer.alloc(0)): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload
  const frame = Buffer.alloc(HEADER_SIZE + data.length)
  frame[0] = type
  frame.writeUInt32LE(data.length, 1)
  data.copy(frame, HEADER_SIZE)
  return frame
}

/** Parse a single TLV frame from a buffer at the given offset.
 *  Returns null if the buffer doesn't contain a complete frame. */
export function parseFrame(buf: Buffer, offset = 0): {frame: Frame; bytesConsumed: number} | null {
  if (offset + HEADER_SIZE > buf.length) return null

  const type = buf[offset]!
  const length = buf.readUInt32LE(offset + 1)

  if (offset + HEADER_SIZE + length > buf.length) return null

  const payload = Buffer.from(buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length))
  return {frame: {type, payload}, bytesConsumed: HEADER_SIZE + length}
}

// ── CLI → Device command builders ──────────────────────────────────

export function buildEvalCommand(code: string): Buffer {
  return buildFrame(CMD_EVAL, code)
}

export function buildCompleteCommand(partial: string): Buffer {
  return buildFrame(CMD_COMPLETE, partial)
}

export function buildDirectiveCommand(directive: string): Buffer {
  return buildFrame(CMD_DIRECTIVE, directive)
}

export function buildExitCommand(): Buffer {
  return buildFrame(CMD_EXIT)
}

export function buildHelloCommand(): Buffer {
  return buildFrame(CMD_HELLO)
}

export function buildRestartCommand(): Buffer {
  return buildFrame(CMD_RESTART)
}

export function buildRuntimePauseCommand(): Buffer {
  return buildFrame(CMD_RUNTIME_PAUSE)
}

export function buildRuntimeResumeCommand(): Buffer {
  return buildFrame(CMD_RUNTIME_RESUME)
}

/** Build CMD_FS_GET payload: u16le path_len | path */
export function buildFsGetCommand(path: string): Buffer {
  const pathBytes = Buffer.from(path, 'utf-8')
  const payload = Buffer.alloc(2 + pathBytes.length)
  payload.writeUInt16LE(pathBytes.length, 0)
  pathBytes.copy(payload, 2)
  return buildFrame(CMD_FS_GET, payload)
}

// ── Deploy command builders ────────────────────────────────────────

/** Build a DEPLOY_PUT (begin) payload: u16le name_len | name | u32le total_size.
 *  The file body itself is NOT included — it follows in CMD_DEPLOY_PUT_CHUNK
 *  frames built via {@link buildDeployPutChunkCommand}. Splitting the body
 *  across multiple commands keeps any single TLV frame well under the
 *  device's USJ RX ring, regardless of file size. */
export function buildDeployPutCommand(filename: string, totalSize: number): Buffer {
  const nameBytes = Buffer.from(filename, 'utf-8')
  const payload = Buffer.alloc(2 + nameBytes.length + 4)
  let offset = 0
  payload.writeUInt16LE(nameBytes.length, offset)
  offset += 2
  nameBytes.copy(payload, offset)
  offset += nameBytes.length
  payload.writeUInt32LE(totalSize, offset)
  return buildFrame(CMD_DEPLOY_PUT, payload)
}

/** Build a DEPLOY_PUT_CHUNK frame: payload is raw body bytes (slice of file
 *  data). The host sends one CHUNK per ~2 KB of body and awaits MSG_OK
 *  between frames so the device's RX ring can never overrun. */
export function buildDeployPutChunkCommand(data: Buffer): Buffer {
  return buildFrame(CMD_DEPLOY_PUT_CHUNK, data)
}

export function buildDeployDoneCommand(): Buffer {
  return buildFrame(CMD_DEPLOY_DONE)
}

export function buildDeployAbortCommand(): Buffer {
  return buildFrame(CMD_DEPLOY_ABORT)
}

export function buildDeployEraseCommand(): Buffer {
  return buildFrame(CMD_DEPLOY_ERASE)
}

/** Build DEPLOY_KEEP payload: u16le name_len | name */
export function buildDeployKeepCommand(filename: string): Buffer {
  const nameBytes = Buffer.from(filename, 'utf-8')
  const payload = Buffer.alloc(2 + nameBytes.length)
  payload.writeUInt16LE(nameBytes.length, 0)
  nameBytes.copy(payload, 2)
  return buildFrame(CMD_DEPLOY_KEEP, payload)
}

/** Build DEPLOY_CHECKSUM payload: u16le name_len | name | sha256[32] */
export function buildDeployChecksumCommand(filename: string, hash: Buffer): Buffer {
  const nameBytes = Buffer.from(filename, 'utf-8')
  const payload = Buffer.alloc(2 + nameBytes.length + 32)
  let offset = 0
  payload.writeUInt16LE(nameBytes.length, offset)
  offset += 2
  nameBytes.copy(payload, offset)
  offset += nameBytes.length
  hash.copy(payload, offset, 0, 32)
  return buildFrame(CMD_DEPLOY_CHECKSUM, payload)
}

// ── Config command builders ────────────────────────────────────────

export function buildConfigListCommand(): Buffer {
  return buildFrame(CMD_CONFIG_LIST)
}

/** Build CONFIG_SET payload: u8 flags | u16le key_len | key | u16le val_len | value */
export function buildConfigSetCommand(key: string, value: string, secret: boolean): Buffer {
  const keyBytes = Buffer.from(key, 'utf-8')
  const valBytes = Buffer.from(value, 'utf-8')
  const payload = Buffer.alloc(1 + 2 + keyBytes.length + 2 + valBytes.length)
  let offset = 0
  payload[offset++] = secret ? ENV_FLAG_SECRET : 0x00
  payload.writeUInt16LE(keyBytes.length, offset)
  offset += 2
  keyBytes.copy(payload, offset)
  offset += keyBytes.length
  payload.writeUInt16LE(valBytes.length, offset)
  offset += 2
  valBytes.copy(payload, offset)
  return buildFrame(CMD_CONFIG_SET, payload)
}

/** Build CONFIG_DELETE payload: u16le key_len | key */
export function buildConfigDeleteCommand(key: string): Buffer {
  const keyBytes = Buffer.from(key, 'utf-8')
  const payload = Buffer.alloc(2 + keyBytes.length)
  payload.writeUInt16LE(keyBytes.length, 0)
  keyBytes.copy(payload, 2)
  return buildFrame(CMD_CONFIG_DELETE, payload)
}

// ── Message parsing ────────────────────────────────────────────────

export type MessageType =
  | 'ready'
  | 'log'
  | 'warn'
  | 'error'
  | 'result'
  | 'info'
  | 'debug'
  | 'completions'
  | 'eval_error'
  | 'prompt'
  | 'ok'
  | 'err'
  | 'checksum_result'
  | 'config_entries'
  | 'fs_chunk'
  | 'test'
  | 'manifest_done'

const MSG_TYPE_MAP: Record<number, MessageType> = {
  [MSG_READY]: 'ready',
  [MSG_LOG]: 'log',
  [MSG_WARN]: 'warn',
  [MSG_ERROR]: 'error',
  [MSG_RESULT]: 'result',
  [MSG_INFO]: 'info',
  [MSG_DEBUG]: 'debug',
  [MSG_COMPLETIONS]: 'completions',
  [MSG_EVAL_ERROR]: 'eval_error',
  [MSG_PROMPT]: 'prompt',
  [MSG_OK]: 'ok',
  [MSG_ERR]: 'err',
  [MSG_CHECKSUM_RESULT]: 'checksum_result',
  [MSG_CONFIG_ENTRIES]: 'config_entries',
  [MSG_FS_CHUNK]: 'fs_chunk',
  [MSG_TEST]: 'test',
  [MSG_MANIFEST_DONE]: 'manifest_done',
}

export interface Message {
  type: MessageType
  payload: Buffer
}

/** Parse a frame into a typed message. Returns null for unknown types. */
export function frameToMessage(frame: Frame): Message | null {
  const type = MSG_TYPE_MAP[frame.type]
  if (!type) return null
  return {type, payload: frame.payload}
}

export interface CompletionResult {
  prefix: string
  items: string[]
}

/** Parse a CBOR-encoded completions message payload */
export function parseCompletions(data: Uint8Array): CompletionResult | null {
  try {
    const parsed = decodeCbor(data) as CompletionResult
    if (typeof parsed.prefix === 'string' && Array.isArray(parsed.items)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

// ── Valid device→CLI message type set ──────────────────────────────

/** All known device→CLI message type bytes */
const VALID_MSG_TYPES = new Set(Object.keys(MSG_TYPE_MAP).map(Number))

// ── Frame parser ───────────────────────────────────────────────────

/** Result of feeding data to the FrameParser: complete frames + any raw bytes */
export interface ParseResult {
  frames: Frame[]
  /** Raw bytes skipped before valid frames (boot logs, stray bytes) */
  raw: Buffer | null
}

/** Accumulates incoming data and yields complete frames.
 *  Bytes with unknown type values are collected as raw output. */
export class FrameParser {
  private buf = Buffer.alloc(0)
  private rawAccum = Buffer.alloc(0)

  /** Feed data and return complete frames + any raw bytes that were skipped */
  feed(data: Buffer | Uint8Array): ParseResult {
    const incoming = Buffer.from(data)
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, incoming]) : incoming
    const frames: Frame[] = []

    let offset = 0
    for (;;) {
      if (offset + HEADER_SIZE > this.buf.length) break

      const type = this.buf[offset]!
      if (!VALID_MSG_TYPES.has(type)) {
        // Not a known message type: accumulate as raw bytes (boot logs, stray bytes)
        this.rawAccum = Buffer.concat([this.rawAccum, this.buf.subarray(offset, offset + 1)])
        offset++
        continue
      }

      const length = this.buf.readUInt32LE(offset + 1)
      if (length > MAX_FRAME_PAYLOAD) {
        // Corrupted frame: skip byte and resync
        this.rawAccum = Buffer.concat([this.rawAccum, this.buf.subarray(offset, offset + 1)])
        offset++
        continue
      }

      const result = parseFrame(this.buf, offset)
      if (!result) break
      frames.push(result.frame)
      offset += result.bytesConsumed
    }

    // Keep unconsumed bytes
    if (offset > 0) {
      this.buf = Buffer.from(this.buf.subarray(offset))
    }

    // Return accumulated raw bytes (if any) and reset
    const raw = this.rawAccum.length > 0 ? this.rawAccum : null
    this.rawAccum = Buffer.alloc(0)

    return {frames, raw}
  }

  /** Drain and return the internal buffer (for displaying stale data) */
  flush(): Buffer {
    const data = Buffer.concat([this.rawAccum, this.buf])
    this.rawAccum = Buffer.alloc(0)
    this.buf = Buffer.alloc(0)
    return data
  }

  /** Reset internal buffer */
  reset(): void {
    this.rawAccum = Buffer.alloc(0)
    this.buf = Buffer.alloc(0)
  }
}

// ── Incomplete expression detection ────────────────────────────────

/** Returns true if the code has unmatched brackets/parens/braces,
 *  unterminated strings, or template literals. */
export function isIncomplete(code: string): boolean {
  let level = 0
  let inSingleQuote = false
  let inDoubleQuote = false
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false
  let escape = false

  for (let i = 0; i < code.length; i++) {
    const c = code[i]!

    if (escape) {
      escape = false
      continue
    }

    if (c === '\\' && (inSingleQuote || inDoubleQuote || inTemplate)) {
      escape = true
      continue
    }

    if (inLineComment) {
      if (c === '\n') inLineComment = false
      continue
    }

    if (inBlockComment) {
      if (c === '*' && i + 1 < code.length && code[i + 1] === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inSingleQuote) {
      if (c === "'") inSingleQuote = false
      continue
    }

    if (inDoubleQuote) {
      if (c === '"') inDoubleQuote = false
      continue
    }

    if (inTemplate) {
      if (c === '`') {
        inTemplate = false
      } else if (c === '$' && i + 1 < code.length && code[i + 1] === '{') {
        level++
        i++
      } else if (c === '}' && level > 0) {
        level--
      }
      continue
    }

    // Not inside any string or comment
    if (c === '/' && i + 1 < code.length) {
      if (code[i + 1] === '/') {
        inLineComment = true
        i++
        continue
      }
      if (code[i + 1] === '*') {
        inBlockComment = true
        i++
        continue
      }
    }

    if (c === "'") {
      inSingleQuote = true
    } else if (c === '"') {
      inDoubleQuote = true
    } else if (c === '`') {
      inTemplate = true
    } else if (c === '(' || c === '[' || c === '{') {
      level++
    } else if (c === ')' || c === ']' || c === '}') {
      level--
    }
  }

  return level > 0 || inSingleQuote || inDoubleQuote || inTemplate || inBlockComment
}

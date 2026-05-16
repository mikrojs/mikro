/**
 * ReplSession — transport-agnostic protocol session.
 *
 * Usage:
 *   const session = connectRepl(transport)
 *   session.messages$.subscribe(event => ...)
 *   session.eval('1+1')
 *   await session.deploy(files, envVars)
 *   session.close()
 */

import {createHash} from 'node:crypto'

import {decode as decodeCbor} from 'cbor2'
import {
  catchError,
  concat,
  filter,
  finalize,
  first,
  firstValueFrom,
  from,
  ignoreElements,
  map,
  merge,
  mergeMap,
  type Observable,
  of,
  scan,
  share,
  shareReplay,
  Subject,
  type Subscription,
  switchMap,
  takeUntil,
  tap,
  timeout,
  timer,
} from 'rxjs'

import {
  checkFirmwareCompat,
  type FirmwareCompatDirection,
  FirmwareIncompatibleError,
  formatAdvisory,
  formatIncompatibleError,
} from './firmwareCompat.js'
import {detectPreferredPm} from './pkgManager.js'
import {
  buildCompleteCommand,
  buildConfigDeleteCommand,
  buildConfigListCommand,
  buildConfigSetCommand,
  buildDeployAbortCommand,
  buildDeployChecksumCommand,
  buildDeployDoneCommand,
  buildDeployEraseCommand,
  buildDeployKeepCommand,
  buildDeployPutChunkCommand,
  buildDeployPutCommand,
  buildDirectiveCommand,
  buildEvalCommand,
  buildExitCommand,
  buildFsGetCommand,
  buildHelloCommand,
  buildRestartCommand,
  buildRuntimePauseCommand,
  buildRuntimeResumeCommand,
  type CompletionResult,
  type Frame,
  FrameParser,
  frameToMessage,
  parseCompletions,
} from './protocol.js'
import type {Transport} from './transport.js'
import {TROUBLESHOOTING_URL} from './troubleshooting.js'

// ── Event types ────────────────────────────────────────────────────

export interface FirmwareAdvisory {
  kind: FirmwareCompatDirection
  message: string
}

export interface ReadyEvent {
  type: 'ready'
  chip: string | null
  id: string | null
  version: string | null
  advisory?: FirmwareAdvisory | null
}

export interface TextEvent {
  type: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'result' | 'eval_error'
  text: string
}

export interface CompletionsEvent {
  type: 'completions'
  result: CompletionResult
}

export interface PromptEvent {
  type: 'prompt'
  timing: string
}

export interface RawEvent {
  type: 'raw'
  text: string
}

export interface OkEvent {
  type: 'ok'
  payload: Buffer
}

export interface ErrEvent {
  type: 'err'
  message: string
}

export interface ChecksumResultEvent {
  type: 'checksum_result'
  match: boolean
}

export interface ConfigEntriesEvent {
  type: 'config_entries'
  entries: EnvEntry[]
}

export interface FsChunkEvent {
  type: 'fs_chunk'
  data: Buffer
}

export interface TestEvent {
  type: 'test'
  data: Record<string, unknown>
}

export interface ManifestDoneEvent {
  type: 'manifest_done'
}

export interface DisconnectEvent {
  type: 'disconnect'
  error?: string
}

/** Emitted by `createSupervisedSession` when the underlying serial transport
 *  drops but a reconnect attempt is in progress. The state machine renders
 *  a subtle "reconnecting…" line. */
export interface ReconnectingEvent {
  type: 'reconnecting'
}

/** Emitted by `createSupervisedSession` after the reconnect handshake
 *  succeeds (a fresh MSG_READY arrives via the new transport). The state
 *  machine's `ready` reducer already handles the transition back to
 *  `ready`; this event is informational. */
export interface ReconnectedEvent {
  type: 'reconnected'
}

export type ReplEvent =
  | ReadyEvent
  | TextEvent
  | CompletionsEvent
  | PromptEvent
  | RawEvent
  | OkEvent
  | ErrEvent
  | ChecksumResultEvent
  | ConfigEntriesEvent
  | FsChunkEvent
  | TestEvent
  | ManifestDoneEvent
  | DisconnectEvent
  | ReconnectingEvent
  | ReconnectedEvent

/** Response events that deploy/config commands wait for */
type ResponseEvent = OkEvent | ErrEvent | ChecksumResultEvent | ConfigEntriesEvent

function isResponseEvent(event: ReplEvent): event is ResponseEvent {
  return (
    event.type === 'ok' ||
    event.type === 'err' ||
    event.type === 'checksum_result' ||
    event.type === 'config_entries'
  )
}

// ── Deploy types ───────────────────────────────────────────────────

export interface DeployFile {
  path: string
  data: Buffer
}

export interface EnvVar {
  key: string
  value: string
  secret: boolean
}

export interface DeployOptions {
  files: DeployFile[]
  envVars?: EnvVar[]
  force?: boolean
  erase?: boolean
  restart?: boolean
  /** When true, restart the device even if the deploy short-circuits as a
   * no-op (no file changes, no env changes). `mikro test` needs this so a
   * re-run against an unchanged app still boots fresh and the supervisor
   * picks up the test manifest from a clean runtime. Has no effect when
   * `restart` is false. */
  alwaysRestart?: boolean
  /** Timeout in ms for waiting for device to be ready (default: 10000) */
  timeout?: number
}

export type DeployEvent =
  | {type: 'connecting'}
  | {type: 'checking'; file: string; index: number; total: number}
  | {type: 'uploading'; file: string; index: number; total: number}
  | {type: 'env_changed'; changed: string[]; removed: string[]}
  | {type: 'restarting'}
  | {type: 'complete'; deployed: boolean; stats: {put: number; kept: number}}

// ── Config types ───────────────────────────────────────────────────

export interface EnvEntry {
  key: string
  value: string
  secret: boolean
}

// ── Session interface ──────────────────────────────────────────────

export interface ReplSession {
  /** Observable stream of protocol events */
  messages$: Observable<ReplEvent>

  /** Send an eval command */
  eval(code: string): void
  /** Send a directive command */
  directive(name: string): void
  /** Send a tab-completion request */
  complete(partial: string): void
  /** Send exit command */
  exit(): void

  /** Emits each time the device sends MSG_READY (in response to CMD_HELLO).
   *  shareReplay(1) means late subscribers get the most recent ready event.
   *  The device only replies to HELLO, so something must drive the
   *  handshake (deploy/config/eraseApp do this internally; otherwise call
   *  awaitReady$). */
  ready$: Observable<ReadyEvent>

  /** Send CMD_HELLO repeatedly until the device responds with a fresh
   *  MSG_READY (newer than any pre-restart cached ready). Throws on timeout
   *  or version incompatibility. Most callers can rely on deploy/config
   *  awaiting ready internally; this is for explicit handshake control. */
  awaitReady$(timeoutMs?: number): Observable<ReadyEvent>

  /** High-level incremental deploy. Emits progress events, completes after final event. */
  deploy(options: DeployOptions): Observable<DeployEvent>

  /** Erase the deployed app on the device without re-deploying anything.
   * Sends ERASE + DONE + optional RESTART. Unlike deploy({files: [], erase: true}),
   * this leaves nothing behind: no staged dir, no .checksums stamp, no /app at all. */
  eraseApp(options?: {restart?: boolean}): Promise<void>

  /** Config operations */
  config: {
    list(): Promise<EnvEntry[]>
    set(key: string, value: string, secret: boolean): Promise<void>
    delete(key: string): Promise<void>
  }

  /** Pull a file off the device. Streams chunks over the wire and resolves
   * with the concatenated body. Rejects with the device error message
   * (e.g. "open failed: ENOENT") when the path can't be read. */
  fsGet(path: string): Promise<Buffer>

  /** Send restart command */
  restart(): void

  /** Tear down the session */
  close(): void
}

// ── Checksums manifest ─────────────────────────────────────────────

const CHECKSUMS_PATH = '/app/.checksums'

function buildChecksumsManifest(hashes: Map<string, Buffer>): Buffer {
  const lines: string[] = []
  for (const [name, hash] of hashes) {
    lines.push(`${hash.toString('hex')}  ${name}\n`)
  }
  return Buffer.from(lines.join(''))
}

// ── connectRepl ────────────────────────────────────────────────────

/** Window for MSG_READY after CMD_RESTART. A healthy reboot is <1s, but
 * CMD_RESTART itself only gets serviced when the device's JS thread
 * yields — and apps doing display/modem work can block it for several
 * seconds. 10s accommodates both without hanging forever on a wedged
 * device. Callers can override via `DeployOptions.timeout`. */
const READY_TIMEOUT_MS = 10_000
const RESPONSE_TIMEOUT_MS = 30_000
/** How often awaitReady$ re-sends CMD_HELLO while waiting for MSG_READY.
 * The device replies immediately, so a single HELLO normally suffices.
 * Polling exists to cover (a) the post-restart window where the transport
 * is down or the device is mid-reboot and (b) connections established
 * before the device's protocol mode is up. */
const HELLO_POLL_INTERVAL_MS = 250
/** Timeout for protocol commands whose on-device work is near-instant
 * (pause, resume) but whose handler is interleaved with JS. The budget
 * isn't for the command itself — it's for the longest plausible
 * blocking JS native call (display SPI, flash write, etc.) that can
 * delay the next handler tick. */
const JS_YIELD_TIMEOUT_MS = 10_000
/** Body bytes per CMD_DEPLOY_PUT_CHUNK frame. Sized so a single TLV frame
 * (5-byte header + body) stays well below the device's USJ RX ring with
 * room for the next command's header to land alongside it. Larger chunks
 * trade per-chunk round-trip cost against the risk of overrun on devices
 * with smaller rings — 2 KB is the sweet spot for both the ESP32 USJ peripheral
 * (RX 4 KB) and any plausible UART path. */
const PUT_CHUNK_SIZE = 2048

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`
}

/** Thrown when a protocol command (or the initial handshake) doesn't get
 * a response in time. Carries the timed-out operation label so logs and
 * `--agent` consumers can tell *which* step stalled, while the UI footer
 * can render just the human summary. Callers downstream (devSession,
 * RenderAndExit handlers) classify connection-class failures via
 * `instanceof DeviceTimeoutError` rather than string-matching the
 * message. */
export class DeviceTimeoutError extends Error {
  readonly name = 'DeviceTimeoutError'
  readonly timeoutMs: number
  readonly context: string | undefined

  constructor(timeoutMs: number, context?: string) {
    const summary = `Device did not respond within ${formatDuration(timeoutMs)}. See ${TROUBLESHOOTING_URL} for help.`
    super(context ? `${summary} (during ${context})` : summary)
    this.timeoutMs = timeoutMs
    this.context = context
  }
}

export interface ConnectReplOptions {}

export function connectRepl(
  transport: Transport,
  _connectOptions: ConnectReplOptions = {},
): ReplSession {
  const frameParser = new FrameParser()
  let sub: Subscription | undefined
  // Fires once when session.close() runs; lets per-call pipelines (notably
  // awaitReady$'s 10s timeout) terminate cleanly instead of throwing an
  // uncaught DeviceTimeoutError after the caller has been torn down.
  const closed$ = new Subject<void>()

  // Buffer for raw (non-protocol) bytes so we only emit complete lines.
  let rawLineBuf = ''

  // Core observable: transport bytes → parsed ReplEvents (shared/hot).
  // Emits a 'disconnect' event when the transport completes, then completes.
  const messages$: Observable<ReplEvent> = concat(
    transport.data.pipe(
      mergeMap((chunk) => {
        const {frames, raw} = frameParser.feed(Buffer.from(chunk))
        const events: ReplEvent[] = []

        if (raw) {
          rawLineBuf += raw.toString('utf-8')
          // Emit only complete lines; keep the trailing partial for later
          const lastNewline = rawLineBuf.lastIndexOf('\n')
          if (lastNewline !== -1) {
            const complete = rawLineBuf.slice(0, lastNewline).trim()
            rawLineBuf = rawLineBuf.slice(lastNewline + 1)
            if (complete) events.push({type: 'raw', text: complete})
          }
        }

        for (const frame of frames) {
          const event = frameToEvent(frame)
          if (event) events.push(event)
        }

        return events
      }),
      finalize(() => {
        frameParser.flush()
        rawLineBuf = ''
      }),
    ),
    [{type: 'disconnect'} satisfies DisconnectEvent],
  ).pipe(share())

  // Keep the pipeline alive (shared observables need at least one subscriber)
  sub = messages$.subscribe()

  // ready$: emits each time the device sends MSG_READY (after boot or restart).
  // Tagged with a sequence number AND arrival timestamp so awaitReady$ can
  // distinguish a genuinely post-restart ready from one that pre-dates the
  // reboot. After `session.restart()`, two failure modes need filtering:
  //   1. The previously-cached MSG_READY replayed by shareReplay (caught by
  //      sequence number — restart() snapshots the current seq).
  //   2. A pre-restart MSG_READY that was already in the OS read buffer or
  //      otherwise in flight when restart() ran, so it arrives shortly
  //      *after* the seq snapshot but is still from the pre-reboot device
  //      state. The sequence check passes for these, but the timestamp
  //      doesn't: a real post-reboot MSG_READY arrives at least one boot
  //      cycle (~500 ms) later. We require a 1 s blackout to be safe.
  // Both conditions together prevent deploy from sending CMD_RUNTIME_PAUSE
  // while the device is still rebooting (which lands during the USB-CDC
  // re-enumeration window and gets dropped).
  let readySeq = 0
  let lastSeenRestartSeq = -1
  let lastRestartAt = 0
  // Show the firmware "update available" notice at most once per session.
  let advisoryShown = false
  const POST_RESTART_BLACKOUT_MS = 1000
  const readyWithMeta$ = messages$.pipe(
    filter((e): e is ReadyEvent => e.type === 'ready'),
    map((e) => ({event: e, seq: ++readySeq, arrivedAt: Date.now()})),
    shareReplay(1),
  )
  // Eagerly subscribe so shareReplay captures ready events
  sub.add(readyWithMeta$.subscribe())
  const ready$ = readyWithMeta$.pipe(map(({event}) => event))

  // Response stream: OK, ERR, CHECKSUM_RESULT, CONFIG_ENTRIES
  const responses$ = messages$.pipe(filter(isResponseEvent))

  /** Send a command and wait for the next response event. A timeout is
   * surfaced as a `DeviceTimeoutError` so callers and the UI can tell
   * which operation stalled (the `context` label flows through) and
   * classify it via `instanceof` rather than string-matching. */
  async function sendAndWait(
    frame: Buffer,
    context: string,
    timeoutMs: number = RESPONSE_TIMEOUT_MS,
  ): Promise<ResponseEvent> {
    const response = firstValueFrom(responses$.pipe(first(), timeout(timeoutMs)))
    await transport.write(frame)
    try {
      return await response
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new DeviceTimeoutError(timeoutMs, context)
      }
      throw err
    }
  }

  /** Send a command and expect MSG_OK. Throws on MSG_ERR or timeout.
   *  Returns the OK payload so callers can inspect extra bytes (e.g. the
   *  changed/existed flag returned by CONFIG_SET / CONFIG_DELETE). The
   *  `context` label annotates both device-side error responses
   *  (MSG_ERR / unexpected type) and the `DeviceTimeoutError` raised on
   *  timeout. */
  async function sendExpectOk(frame: Buffer, context: string, timeoutMs?: number): Promise<Buffer> {
    const resp = await sendAndWait(frame, context, timeoutMs)
    if (resp.type === 'err') {
      throw new Error(`${context}: ${resp.message}`)
    }
    if (resp.type !== 'ok') {
      throw new Error(`${context}: unexpected response type '${resp.type}'`)
    }
    return resp.payload
  }

  /** Stream a file to the device as one CMD_DEPLOY_PUT (begin) followed by
   *  one or more CMD_DEPLOY_PUT_CHUNK frames. Each frame awaits MSG_OK
   *  before the next is sent so the device's RX ring can never overrun
   *  regardless of file size. Empty files are valid: BEGIN with size=0
   *  closes the file immediately and no chunks are sent. */
  async function streamPutFile(path: string, data: Buffer): Promise<void> {
    await sendExpectOk(buildDeployPutCommand(path, data.length), `deploy put '${path}'`)
    for (let offset = 0; offset < data.length; offset += PUT_CHUNK_SIZE) {
      const chunk = data.subarray(offset, offset + PUT_CHUNK_SIZE)
      await sendExpectOk(buildDeployPutChunkCommand(chunk), `deploy put chunk '${path}' @${offset}`)
    }
  }

  /**
   * Wait for device to be ready. Emits the ReadyEvent, then completes.
   * Errors if the device firmware version is incompatible.
   */
  function awaitReady$(timeoutMs = READY_TIMEOUT_MS): Observable<ReadyEvent> {
    const checkVersion = async (event: ReadyEvent): Promise<ReadyEvent> => {
      const compat = checkFirmwareCompat(event.version)
      if (compat.status === 'match') {
        return {...event, advisory: null}
      }
      const pm = await detectPreferredPm()
      if (compat.status === 'incompatible') {
        throw new FirmwareIncompatibleError(formatIncompatibleError(compat, pm))
      }
      // status === 'update_available'
      const message = formatAdvisory(compat, pm)
      if (!advisoryShown) {
        advisoryShown = true
        process.stderr.write(message + '\n')
      }
      return {...event, advisory: {kind: compat.direction!, message}}
    }

    const mapTimeout = (ms: number, context: string) =>
      catchError<ReadyEvent, never>((err) => {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new DeviceTimeoutError(ms, context)
        }
        throw err
      })

    // The device only sends MSG_READY in response to CMD_HELLO, so poll
    // HELLO at a steady interval until a ready arrives. The first tick fires
    // immediately. Best-effort writes: during the post-restart USB-CDC
    // re-enumeration window the transport may reject — swallow and retry on
    // the next tick.
    const hello$ = timer(0, HELLO_POLL_INTERVAL_MS).pipe(
      tap(() => {
        transport.write(buildHelloCommand()).catch(() => {})
      }),
      ignoreElements(),
    )

    // Wait for a ready event whose sequence number is newer than the one
    // captured at the most recent `session.restart()` call. This skips any
    // cached pre-restart ready that shareReplay would otherwise replay, so
    // we don't proceed to send commands while the device is still in the
    // middle of rebooting.
    const ready$ = readyWithMeta$.pipe(
      filter(
        ({seq, arrivedAt}) =>
          seq > lastSeenRestartSeq && arrivedAt >= lastRestartAt + POST_RESTART_BLACKOUT_MS,
      ),
      map(({event}) => event),
    )

    return merge(hello$, ready$).pipe(
      first(),
      timeout(timeoutMs),
      mapTimeout(timeoutMs, 'handshake'),
      mergeMap(checkVersion),
      takeUntil(closed$),
    )
  }

  /** Promise version for config operations */
  async function awaitReady(): Promise<void> {
    await firstValueFrom(awaitReady$())
  }

  // ── Deploy ─────────────────────────────────────────────────────

  function deploy(options: DeployOptions): Observable<DeployEvent> {
    const readyTimeoutMs = options.timeout ?? READY_TIMEOUT_MS

    return concat(
      of({type: 'connecting'} satisfies DeployEvent),
      awaitReady$(readyTimeoutMs).pipe(switchMap(() => from(deployAfterReady(options)))),
    )
  }

  async function* deployAfterReady(options: DeployOptions): AsyncGenerator<DeployEvent> {
    const {
      files,
      envVars = [],
      force = false,
      erase = false,
      restart: shouldRestart = true,
      alwaysRestart = false,
    } = options

    // Freeze the device's JS runtime so user code can't interleave log
    // output (raw or MSG_LOG) with deploy traffic during the checksum and
    // upload phases. The device already pauses internally on the first
    // deploy command, but that leaves a brief window before the first
    // command arrives; sending PAUSE explicitly up front closes it.
    // A reboot implicitly resumes; otherwise we send RESUME in the finally
    // block. `didRestart` (not `shouldRestart`) drives that decision because
    // the no-op/abort branch skips the restart even when shouldRestart=true.
    await sendExpectOk(buildRuntimePauseCommand(), 'runtime pause', JS_YIELD_TIMEOUT_MS)

    let didRestart = false
    try {
      // Compute local hashes
      const localHashes = new Map<string, Buffer>()
      for (const file of files) {
        localHashes.set(file.path, createHash('sha256').update(file.data).digest())
      }

      const filesToPut: DeployFile[] = []
      const filesToKeep: string[] = []

      // With erase, the checksum-based KEEP optimization is unsafe: erase wipes
      // the live appDir before KEEP operations copy from it, so any file marked
      // KEEP would silently drop out of the deploy. Force all files to PUT.
      if (force || erase) {
        filesToPut.push(...files)
      } else {
        // Checksum-based incremental deploy
        let checksumSupported = true
        for (let i = 0; i < files.length; i++) {
          const file = files[i]!
          yield {type: 'checking', file: file.path, index: i, total: files.length}

          if (!checksumSupported) {
            filesToPut.push(file)
            continue
          }
          const hash = localHashes.get(file.path)!
          const resp = await sendAndWait(
            buildDeployChecksumCommand(file.path, hash),
            `deploy checksum '${file.path}'`,
          )
          if (resp.type === 'err') {
            checksumSupported = false
            filesToPut.push(file)
            filesToKeep.length = 0
            continue
          }
          if (resp.type === 'checksum_result' && resp.match) {
            filesToKeep.push(file.path)
          } else {
            filesToPut.push(file)
          }
        }
      }

      // Env vars: diff against current device state so we only mutate
      // actual differences. Firmware reports per-entry changed/existed bits,
      // giving the CLI a definitive "did anything change" signal without
      // any local caching.
      const envChanged: string[] = []
      const envRemoved: string[] = []
      if (envVars.length > 0) {
        const tooLong = envVars.filter((v) => Buffer.byteLength(v.key, 'utf-8') > 15)
        if (tooLong.length > 0) {
          throw new Error(
            `Env key(s) exceed NVS 15-char limit: ${tooLong.map((v) => v.key).join(', ')}`,
          )
        }

        const deviceEntries = await config.list()
        const desiredKeys = new Set(envVars.map((v) => v.key))

        for (const v of envVars) {
          const payload = await sendExpectOk(
            buildConfigSetCommand(v.key, v.value, v.secret),
            `config set '${v.key}'`,
          )
          if (payload.length > 0 && payload[0] === 1) envChanged.push(v.key)
        }

        for (const entry of deviceEntries) {
          if (desiredKeys.has(entry.key)) continue
          const payload = await sendExpectOk(
            buildConfigDeleteCommand(entry.key),
            `config delete '${entry.key}'`,
          )
          if (payload.length > 0 && payload[0] === 1) envRemoved.push(entry.key)
        }
      }

      const envActuallyChanged = envChanged.length > 0 || envRemoved.length > 0
      const hasChanges = filesToPut.length > 0 || envActuallyChanged || erase

      // Nothing changed: abort. Restart anyway when the caller asked for
      // it via alwaysRestart (mikro test wants a fresh runtime per run
      // even when files+env are unchanged, so the supervisor re-picks up
      // the manifest from a clean boot).
      if (!hasChanges) {
        await sendExpectOk(buildDeployAbortCommand(), 'deploy abort')
        if (shouldRestart && alwaysRestart) {
          yield {type: 'restarting'}
          lastSeenRestartSeq = readySeq
          lastRestartAt = Date.now()
          await transport.write(buildRestartCommand())
          didRestart = true
        }
        yield {type: 'complete', deployed: false, stats: {put: 0, kept: filesToKeep.length}}
        return
      }

      if (envActuallyChanged) {
        yield {type: 'env_changed', changed: envChanged, removed: envRemoved}
      }

      // Erase
      if (erase) {
        await sendExpectOk(buildDeployEraseCommand(), 'deploy erase')
      }

      // KEEP unchanged files
      for (const filePath of filesToKeep) {
        await sendExpectOk(buildDeployKeepCommand(filePath), `deploy keep '${filePath}'`)
      }

      // PUT changed/new files
      for (let i = 0; i < filesToPut.length; i++) {
        const file = filesToPut[i]!
        yield {type: 'uploading', file: file.path, index: i, total: filesToPut.length}
        await streamPutFile(file.path, file.data)
      }

      // PUT checksums manifest — but only if we actually have files to track.
      // Otherwise an empty-files + erase deploy would write a stub .checksums
      // file back into /app and defeat the erase.
      if (filesToPut.length > 0 || filesToKeep.length > 0) {
        const manifest = buildChecksumsManifest(localHashes)
        await streamPutFile(CHECKSUMS_PATH, manifest)
      }

      // Finalize
      await sendExpectOk(buildDeployDoneCommand(), 'deploy done')

      if (shouldRestart) {
        yield {type: 'restarting'}
        lastSeenRestartSeq = readySeq
        lastRestartAt = Date.now()
        await transport.write(buildRestartCommand())
        didRestart = true
      }

      yield {
        type: 'complete',
        deployed: true,
        stats: {put: filesToPut.length, kept: filesToKeep.length},
      }
    } finally {
      // If we didn't actually restart (no-op abort, thrown error, or
      // shouldRestart=false), the runtime is still paused on the device.
      // Resume it so the user's app keeps running. Best-effort: a dropped
      // transport leaves the session_end hook to resume anyway.
      if (!didRestart) {
        try {
          await sendExpectOk(buildRuntimeResumeCommand(), 'runtime resume', JS_YIELD_TIMEOUT_MS)
        } catch {
          // Transport likely gone; session_end on device will resume.
        }
      }
    }
  }

  // ── Erase app ──────────────────────────────────────────────────

  /** Erase the deployed app without going through the full deploy flow.
   * Sends CMD_DEPLOY_ERASE + CMD_DEPLOY_DONE directly, so the device wipes
   * /appfs/app and the DONE handler's stamp_checksums_manifest() silently
   * no-ops because /appfs/app no longer exists. Nothing gets staged or
   * written back. Optionally restarts the device afterwards. */
  async function eraseApp(options: {restart?: boolean} = {}): Promise<void> {
    const {restart: shouldRestart = true} = options
    await awaitReady()
    await sendExpectOk(buildDeployEraseCommand(), 'deploy erase')
    await sendExpectOk(buildDeployDoneCommand(), 'deploy done')
    if (shouldRestart) {
      lastSeenRestartSeq = readySeq
      lastRestartAt = Date.now()
      await transport.write(buildRestartCommand())
    }
  }

  // ── Config ─────────────────────────────────────────────────────

  const config = {
    async list(): Promise<EnvEntry[]> {
      await awaitReady()
      const resp = await sendAndWait(buildConfigListCommand(), 'config list')
      if (resp.type === 'err') throw new Error(`config list: ${resp.message}`)
      if (resp.type === 'config_entries') return resp.entries
      throw new Error(`config list: unexpected response type '${resp.type}'`)
    },

    async set(key: string, value: string, secret: boolean): Promise<void> {
      await awaitReady()
      await sendExpectOk(buildConfigSetCommand(key, value, secret), `config set '${key}'`)
    },

    async delete(key: string): Promise<void> {
      await awaitReady()
      await sendExpectOk(buildConfigDeleteCommand(key), `config delete '${key}'`)
    },
  }

  // ── File pull ──────────────────────────────────────────────────

  /** Send CMD_FS_GET and collect MSG_FS_CHUNK frames until the terminal
   * MSG_OK (or MSG_ERR) arrives. Returns the concatenated body. */
  async function fsGet(path: string): Promise<Buffer> {
    await awaitReady()
    type FsGetAcc = {chunks: Buffer[]; terminal: OkEvent | ErrEvent | null}
    const done = firstValueFrom(
      messages$.pipe(
        filter(
          (e): e is FsChunkEvent | OkEvent | ErrEvent =>
            e.type === 'fs_chunk' || e.type === 'ok' || e.type === 'err',
        ),
        scan<FsChunkEvent | OkEvent | ErrEvent, FsGetAcc>(
          (acc, e) => {
            if (e.type === 'fs_chunk') acc.chunks.push(e.data)
            else acc.terminal = e
            return acc
          },
          {chunks: [], terminal: null},
        ),
        first((acc): acc is FsGetAcc & {terminal: OkEvent | ErrEvent} => acc.terminal !== null),
        timeout(RESPONSE_TIMEOUT_MS),
      ),
    )
    await transport.write(buildFsGetCommand(path))
    let result: FsGetAcc & {terminal: OkEvent | ErrEvent}
    try {
      result = await done
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new DeviceTimeoutError(RESPONSE_TIMEOUT_MS, `fs get '${path}'`)
      }
      throw err
    }
    if (result.terminal.type === 'err') {
      throw new Error(`fs get '${path}': ${result.terminal.message}`)
    }
    return Buffer.concat(result.chunks)
  }

  // ── Public API ─────────────────────────────────────────────────

  return {
    messages$,
    ready$,
    awaitReady$,

    eval(code: string): void {
      void transport.write(buildEvalCommand(code))
    },

    directive(name: string): void {
      void transport.write(buildDirectiveCommand(name))
    },

    complete(partial: string): void {
      void transport.write(buildCompleteCommand(partial))
    },

    exit(): void {
      void transport.write(buildExitCommand())
    },

    deploy,
    eraseApp,
    config,
    fsGet,

    restart(): void {
      // Mark the current ready cache as stale so the next awaitReady$
      // skips it and waits for a fresh post-restart MSG_READY.
      lastSeenRestartSeq = readySeq
      lastRestartAt = Date.now()
      void transport.write(buildRestartCommand())
    },

    close(): void {
      closed$.next()
      closed$.complete()
      sub?.unsubscribe()
      sub = undefined
      frameParser.flush()
    },
  }
}

// ── Frame → Event mapping ──────────────────────────────────────────

function frameToEvent(frame: Frame): ReplEvent | null {
  const msg = frameToMessage(frame)
  if (!msg) return null

  switch (msg.type) {
    case 'ready': {
      let chip: string | null = null
      let id: string | null = null
      let version: string | null = null
      try {
        const info = decodeCbor(msg.payload) as {chip?: string; id?: string; v?: string}
        chip = info.chip ?? null
        id = info.id ?? null
        version = info.v ?? null
      } catch {
        // ignore
      }
      return {type: 'ready', chip, id, version}
    }
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
    case 'result':
    case 'eval_error':
      return {type: msg.type, text: msg.payload.toString('utf-8')}
    case 'completions': {
      const result = parseCompletions(msg.payload)
      return result ? {type: 'completions', result} : null
    }
    case 'prompt':
      return {type: 'prompt', timing: msg.payload.toString('utf-8')}
    case 'ok':
      return {type: 'ok', payload: msg.payload}
    case 'err':
      return {type: 'err', message: msg.payload.toString('utf-8')}
    case 'checksum_result':
      return {type: 'checksum_result', match: msg.payload.length > 0 && msg.payload[0] === 1}
    case 'config_entries': {
      let entries: EnvEntry[] = []
      try {
        entries = decodeCbor(msg.payload) as EnvEntry[]
      } catch {
        // ignore
      }
      return {type: 'config_entries', entries}
    }
    case 'test': {
      try {
        const data = JSON.parse(msg.payload.toString('utf-8')) as Record<string, unknown>
        return {type: 'test', data}
      } catch {
        return null
      }
    }
    case 'fs_chunk':
      return {type: 'fs_chunk', data: msg.payload}
    case 'manifest_done':
      return {type: 'manifest_done'}
    default:
      return null
  }
}

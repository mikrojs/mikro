/**
 * Simulator subprocess entry point.
 *
 * Speaks the same TLV protocol as the ESP32 firmware over stdin/stdout.
 * Spawned by the CLI via createSimTransport(). Acts as a virtual device:
 * boots QuickJS runtime, handles deploy/config/eval/restart commands.
 *
 * Usage: node simProcess.js --fs-root <path> [--mem-limit <bytes>] [--fs-limit <bytes>] [--sim-dir <path>]
 */

// Side-effect import: must run before any code path that strips .ts types.
import '../suppressStripTypesWarning.js'

import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as pathlib from 'node:path'
import {parseArgs} from 'node:util'

import type {HostMessage} from '@mikrojs/native'
import {encode as encodeCbor} from 'cbor2'
import pkg from 'mikro/package.json' with {type: 'json'}
import {type Observable, scan, takeWhile, tap} from 'rxjs'

import {
  buildFrame,
  CMD_COMPLETE,
  CMD_CONFIG_DELETE,
  CMD_CONFIG_LIST,
  CMD_CONFIG_SET,
  CMD_DEPLOY_ABORT,
  CMD_DEPLOY_BUILD,
  CMD_DEPLOY_CHECKSUM,
  CMD_DEPLOY_DONE,
  CMD_DEPLOY_ERASE,
  CMD_DEPLOY_KEEP,
  CMD_DEPLOY_PUT,
  CMD_DEPLOY_PUT_CHUNK,
  CMD_DIRECTIVE,
  CMD_EVAL,
  CMD_EXIT,
  CMD_FS_GET,
  CMD_HELLO,
  CMD_KV_DELETE,
  CMD_KV_SET,
  CMD_LOG_RESET,
  CMD_RESTART,
  CMD_RUNTIME_PAUSE,
  CMD_RUNTIME_RESUME,
  ENV_FLAG_SECRET,
  type Frame,
  HEADER_SIZE,
  MSG_CHECKSUM_RESULT,
  MSG_COMPLETIONS,
  MSG_CONFIG_ENTRIES,
  MSG_DEBUG,
  MSG_ERR,
  MSG_ERROR,
  MSG_EVAL_ERROR,
  MSG_INFO,
  MSG_LOG,
  MSG_MANIFEST_DONE,
  MSG_OK,
  MSG_PROMPT,
  MSG_READY,
  MSG_RESULT,
  MSG_TEST,
  MSG_WARN,
  parseFrame,
} from '../cli/lib/protocol.js'
import {createDevRunner, type DevRunner} from './devRunner.js'
import {loadSimStubs} from './loadSimStubs.js'

// ── Args ────────────────────────────────────────────────────────────

const {values: args} = parseArgs({
  options: {
    'fs-root': {type: 'string'},
    'mem-limit': {type: 'string'},
    'fs-limit': {type: 'string'},
    'fs-read-max': {type: 'string'},
    'sim-dir': {type: 'string'},
    'profile-output': {type: 'string'},
  },
  strict: false,
})

const fsRootArg = args['fs-root']
if (!fsRootArg || typeof fsRootArg !== 'string') {
  process.stderr.write('simProcess: --fs-root is required\n')
  process.exit(1)
}
const fsRoot: string = fsRootArg

const memLimitArg = args['mem-limit']
const memLimit = typeof memLimitArg === 'string' ? parseInt(memLimitArg, 10) : undefined
const fsLimitArg = args['fs-limit']
const fsLimit = typeof fsLimitArg === 'string' ? parseInt(fsLimitArg, 10) : undefined
const fsReadMaxArg = args['fs-read-max']
const fsReadMax = typeof fsReadMaxArg === 'string' ? parseInt(fsReadMaxArg, 10) : undefined
const simDirArg = args['sim-dir']
const simDir = typeof simDirArg === 'string' ? simDirArg : process.cwd()
const profileOutputArg = args['profile-output']
const profileOutput = typeof profileOutputArg === 'string' ? profileOutputArg : undefined

// ── NVS Storage ─────────────────────────────────────────────────────
// Mirrors the firmware's mik.env namespace. Written by CMD_CONFIG_SET/DELETE;
// the CLI's deploy flow now diffs against this rather than clearing+rewriting.

interface NvsEntry {
  value: string
  secret: boolean
}

interface NvsStore {
  entries: Record<string, NvsEntry>
}

const mikroDir = pathlib.dirname(fsRoot)
const configPath = pathlib.join(mikroDir, 'nvs.json')

function readStore(path: string): NvsStore {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NvsStore
  } catch {
    return {entries: {}}
  }
}

function writeStore(path: string, store: NvsStore): void {
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n')
}

// ── Filesystem helpers ──────────────────────────────────────────────

const appDir = pathlib.join(fsRoot, 'app')
const stagingDir = pathlib.join(fsRoot, '.deploy-tmp')
const oldDir = pathlib.join(fsRoot, '.deploy-old')

/** Resolve a path and verify it stays within the given base directory. */
function resolveSandboxPath(base: string, userPath: string): string {
  const resolved = pathlib.resolve(base, userPath.replace(/^\/+/, ''))
  const normalizedBase = pathlib.resolve(base)
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + pathlib.sep)) {
    throw new Error(`Path escapes sandbox: ${userPath}`)
  }
  return resolved
}

function ensureDir(dir: string): void {
  mkdirSync(dir, {recursive: true})
}

// ── Frame I/O ───────────────────────────────────────────────────────

function send(type: number, payload?: string | Buffer): void {
  const frame = buildFrame(type, payload)
  process.stdout.write(frame)
}

function sendOk(): void {
  send(MSG_OK)
}

function sendErr(message: string): void {
  send(MSG_ERR, message)
}

// ── HostMessage → TLV mapping ───────────────────────────────────────

const HOST_MSG_TYPE_MAP: Record<string, number> = {
  'console:log': MSG_LOG,
  'console:warn': MSG_WARN,
  'console:error': MSG_ERROR,
  'console:info': MSG_INFO,
  'console:debug': MSG_DEBUG,
}

const TEST_PREFIX = '__TEST__'

function forwardConsoleMessage(msg: {type: string; data: string}): void {
  const msgType = HOST_MSG_TYPE_MAP[msg.type]
  if (msgType === undefined) return
  try {
    const args = JSON.parse(msg.data) as string[]
    const text = args.join(' ')
    // Intercept test events emitted via console.log fallback
    if (msg.type === 'console:log' && text.startsWith(TEST_PREFIX)) {
      send(MSG_TEST, text.slice(TEST_PREFIX.length))
      return
    }
    send(msgType, text)
  } catch {
    send(msgType, msg.data)
  }
}

/** Drain pending messages from the runtime and forward them as TLV frames.
 *  Called synchronously after evalScript to ensure console output appears
 *  before MSG_RESULT (same ordering as the firmware). Messages are also
 *  emitted to runner.messages$ so the subscriber doesn't re-process them. */
function forwardPendingMessages(): void {
  if (!runner) return
  for (const msg of runner.runtime.drainMessages()) {
    forwardHostMessage(msg)
  }
}

function forwardHostMessage(msg: {type: string; data: string}): void {
  if (msg.type.startsWith('console:')) {
    forwardConsoleMessage(msg)
  } else if (msg.type === 'error:uncaught') {
    try {
      const {name, message, stack} = JSON.parse(msg.data) as {
        name?: string
        message?: string
        stack?: string
      }
      // QuickJS stack traces are just frames (no leading "Name: message"),
      // so synthesize the header to match firmware MSG_EVAL_ERROR formatting.
      const header = name && message ? `${name}: ${message}` : (name ?? message ?? 'Unknown error')
      const text = stack ? `${header}\n${stack}` : header
      send(MSG_EVAL_ERROR, text)
    } catch {
      send(MSG_EVAL_ERROR, msg.data)
    }
  } else if (msg.type === 'oom') {
    // OOM events fire when QuickJS heap headroom crosses a low-water mark
    // either before or after module evaluation. Surface them to the user
    // as warnings — the underlying error (if any) will follow as a normal
    // MSG_EVAL_ERROR via error:uncaught.
    try {
      const {phase, filename, mallocSize, mallocLimit, headroom} = JSON.parse(msg.data) as {
        phase: string
        filename: string
        mallocSize: number
        mallocLimit: number
        headroom: number
      }
      const text =
        `OOM ${phase}: '${filename}' — QuickJS heap ${mallocSize} / ${mallocLimit} bytes ` +
        `(${headroom} bytes free). Lower memReserved or split the module graph.`
      send(MSG_WARN, text)
    } catch {
      send(MSG_WARN, `OOM event: ${msg.data}`)
    }
  } else if (msg.type === 'test') {
    send(MSG_TEST, msg.data)
  }
}

// ── Runtime management ──────────────────────────────────────────────

let runner: DevRunner | null = null
let stopRunner: (() => void) | null = null
let messagesSub: {unsubscribe(): void} | null = null

/** Resolve `package.json#main` (or `main.js` fallback) to an absolute path
 * inside appDir, or null if no entry can be found. */
function findMainEntry(): string | null {
  const pkgPath = pathlib.join(appDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {main?: string}
      if (pkg.main) {
        const mainBase = pkg.main.replace(/\.[tj]s$/, '')
        const jsPath = pathlib.join(appDir, mainBase + '.js')
        const bcPath = pathlib.join(appDir, mainBase + '.bjs')
        if (existsSync(jsPath) || existsSync(bcPath)) return jsPath
      }
    } catch {
      // ignore invalid package.json
    }
  }
  const mainPath = pathlib.join(appDir, 'main.js')
  const mainBcPath = pathlib.join(appDir, 'main.bjs')
  if (existsSync(mainPath) || existsSync(mainBcPath)) return mainPath
  return null
}

/** Resolve `package.json#tests` into an array of absolute paths inside
 * appDir. Returns an empty array if no tests array is present — the sole
 * signal for "test mode", matching the firmware supervisor contract. The
 * entries reference `.js` logical names but `.bjs` bytecode variants
 * also count as present — the runtime resolves the two interchangeably,
 * so an entry is valid if either exists on disk. */
function findTestManifest(): string[] {
  const pkgPath = pathlib.join(appDir, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {tests?: unknown}
    if (!Array.isArray(pkg.tests)) return []
    const resolved: string[] = []
    for (const entry of pkg.tests) {
      if (typeof entry !== 'string') continue
      const cleaned = entry.replace(/^\.\//, '')
      const jsPath = pathlib.join(appDir, cleaned)
      const bjsPath = jsPath.replace(/\.js$/, '.bjs')
      if (existsSync(jsPath) || existsSync(bjsPath)) {
        // Pass the .js logical name; MikroRuntime resolves to .bjs when present.
        resolved.push(jsPath)
      }
    }
    return resolved
  } catch {
    return []
  }
}

function disposeRuntime(): void {
  messagesSub?.unsubscribe()
  messagesSub = null
  if (stopRunner) {
    stopRunner()
    stopRunner = null
  }
  if (runner) {
    runner.runtime.dispose()
    runner = null
  }
}

/** Spin up a fresh runtime evaluating `entryScript` (or the app's main,
 * if omitted). Tears down any existing runtime first. By default host
 * messages are forwarded to the CLI as TLV frames via `forwardHostMessage`.
 *
 * Callers that need richer observation — e.g. the supervisor's run_done
 * detection with synthetic-event injection — pass a `composeMessages`
 * operator that transforms the raw `messages$` into the subscribed
 * pipeline. The pipeline is subscribed BEFORE `start()` so messages
 * fired during initial module evaluation (fatal throws at TLA, etc.)
 * are observed.
 *
 * When `composeMessages` is supplied, the returned Promise resolves
 * when that pipeline completes — the caller uses it to detect end-of-
 * file. For the default (no composer) case the returned Promise is
 * null: the forward subscription stays open for the runtime's life. */
async function bootRuntime(
  entryScript?: string,
  composeMessages?: (messages$: Observable<HostMessage>) => Observable<unknown>,
): Promise<Promise<void> | null> {
  disposeRuntime()

  const script = entryScript ?? findMainEntry()
  if (!script) {
    // No app deployed: runtime available for REPL but no main script
    return null
  }

  // Load env from the unified NVS store
  const config = readStore(configPath)
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(config.entries)) {
    env[key] = entry.value
  }

  // Load user stub sources (run directly in QuickJS, replacing native modules)
  const stubSources = loadSimStubs(simDir)

  runner = createDevRunner({
    script,
    memLimit,
    fsRoot,
    fsLimit,
    fsReadMax,
    env,
    stubSources,
    profile: profileOutput !== undefined,
  })

  /* Test-mode boot (i.e. driven by the supervisor in runTestManifest, which
   * passes a composer): install the C-level __testEmit / __testFileDone
   * globals. Mirrors the firmware supervisor's per-file MIK_EnableTestHelpers
   * call. Skipping it for ordinary dev runs keeps globalThis unpolluted. */
  if (composeMessages) {
    runner.runtime.enableTestHelpers()
  }

  /* Subscribe BEFORE start() so messages fired during initial module
   * evaluation (fatal throws at TLA, etc.) reach the pipeline. When a
   * composer is supplied, expose its completion as a Promise — that's
   * how the supervisor detects end-of-file without a race. */
  let completion: Promise<void> | null = null
  if (composeMessages) {
    const pipeline = composeMessages(runner.messages$)
    completion = new Promise<void>((resolve, reject) => {
      messagesSub = pipeline.subscribe({
        complete: () => resolve(),
        error: reject,
      })
    })
  } else {
    messagesSub = runner.messages$.subscribe(forwardHostMessage)
  }

  // Register eval queue processing on tick
  runner.onTick(() => {
    processEvalQueue()
  })

  stopRunner = runner.start()
  return completion
}

/** Run a test-manifest cycle: for each path, spin up a fresh runtime,
 * observe until `run_done` (e:6), tear down, move on. Emits supervisor
 * announcements and a terminal MSG_MANIFEST_DONE so the CLI can attribute
 * events correctly and finalize the run. Mirrors the firmware's
 * mik_main.cpp supervisor loop. */
/** Classify a host message against the supervisor's terminal conditions.
 * `run_done` arrives in the normal flow; `fatal` signals an uncaught
 * module-load rejection (the test runtime's setTimeout(run, 0) never fires,
 * so we must synthesize the close-out events ourselves). `duplicate_fatal`
 * covers the second uncaught-rejection event that QuickJS often emits after
 * a sync throw — it would pollute the next file's attribution if forwarded. */
type FileTransition = 'none' | 'run_done' | 'fatal' | 'duplicate_fatal'

function classify(msg: HostMessage, fatalSeen: boolean): FileTransition {
  if (msg.type === 'test') {
    try {
      const data = JSON.parse(msg.data) as {e?: number}
      if (data.e === 6) return 'run_done'
    } catch {
      // malformed test frame, ignore
    }
    return 'none'
  }
  if (msg.type === 'error:uncaught') {
    return fatalSeen ? 'duplicate_fatal' : 'fatal'
  }
  return 'none'
}

interface SupervisorState {
  readonly msg: HostMessage | null
  readonly transition: FileTransition
  readonly fatalSeen: boolean
  readonly done: boolean
}

function reduceSupervisorState(prev: SupervisorState, msg: HostMessage): SupervisorState {
  const transition = classify(msg, prev.fatalSeen)
  switch (transition) {
    case 'run_done':
      return {msg, transition, fatalSeen: prev.fatalSeen, done: true}
    case 'fatal':
      return {msg, transition, fatalSeen: true, done: true}
    case 'duplicate_fatal':
      return {msg, transition, fatalSeen: prev.fatalSeen, done: false}
    case 'none':
      return {msg, transition, fatalSeen: prev.fatalSeen, done: false}
  }
}

const INITIAL_SUPERVISOR_STATE: SupervisorState = {
  msg: null,
  transition: 'none',
  fatalSeen: false,
  done: false,
}

/** Build the per-file observable pipeline. Forwards most messages via the
 * default forwarder, suppresses duplicate uncaught-rejection events, and
 * injects synthetic e:3+e:6 test frames on a fatal module load so the CLI
 * reducer attributes the failure to the correct file. Completes after the
 * first `done` transition. */
function fileRunStream(
  messages$: Observable<HostMessage>,
  logicalPath: string,
): Observable<SupervisorState> {
  return messages$.pipe(
    scan<HostMessage, SupervisorState>(reduceSupervisorState, INITIAL_SUPERVISOR_STATE),
    tap((state) => {
      // Suppress the duplicate-fatal's default forward; everything else
      // forwards normally (run_done, first-fatal, regular messages).
      if (state.msg && state.transition !== 'duplicate_fatal') {
        forwardHostMessage(state.msg)
      }
      // On first fatal, synthesize close-out events after forwarding the
      // original eval_error so the CLI sees them in the right order.
      if (state.transition === 'fatal') {
        send(
          MSG_TEST,
          JSON.stringify({e: 3, s: '<load>', t: logicalPath, d: 0, m: 'Evaluation threw'}),
        )
        send(MSG_TEST, JSON.stringify({e: 6, p: 0, f: 1, k: 0, o: 0, d: 0}))
      }
    }),
    takeWhile((state) => !state.done, true),
  )
}

async function runTestManifest(tests: string[]): Promise<void> {
  for (let i = 0; i < tests.length; i++) {
    const entry = tests[i]!
    const logicalPath = '/' + pathlib.relative(fsRoot, entry).split(pathlib.sep).join('/')
    send(MSG_DEBUG, `[supervisor] running ${i + 1}/${tests.length}: ${logicalPath}`)

    /* Hand fileRunStream to bootRuntime as the message composer so the
     * pipeline is subscribed BEFORE evalModule runs — otherwise a file
     * that throws synchronously at TLA would emit error:uncaught before
     * any post-start() subscriber saw it, and we'd hang forever waiting
     * on a run_done that never comes. bootRuntime returns the pipeline's
     * completion as a Promise, which resolves when takeWhile finishes. */
    const completion = await bootRuntime(entry, (messages$) =>
      fileRunStream(messages$, logicalPath),
    )
    if (completion === null) continue
    await completion
  }

  send(MSG_MANIFEST_DONE)
}

// ── Eval queue ──────────────────────────────────────────────────────

const evalQueue: string[] = []

function processEvalQueue(): void {
  if (!runner) return
  while (evalQueue.length > 0) {
    const code = evalQueue.shift()!
    const t0 = performance.now()
    const timing = (): string => `${(performance.now() - t0).toFixed(1)}ms`
    try {
      const result = runner.runtime.evalForRepl(code)
      forwardPendingMessages()
      // Timing precedes the result so the CLI can render it on that line.
      send(MSG_PROMPT, timing())
      if (result !== undefined) {
        send(MSG_RESULT, result)
      } else {
        send(MSG_RESULT) // empty payload = undefined
      }
    } catch (err) {
      forwardPendingMessages()
      // Prefer err.message: the addon's evalForRepl already builds the full
      // "Name: message\nstack" string from the QuickJS exception. err.stack
      // would prepend "Error: " plus the Node-side frames we don't want.
      const text = err instanceof Error ? err.message : String(err)
      send(MSG_PROMPT, timing())
      send(MSG_EVAL_ERROR, text)
    }
  }
}

// ── Deploy handlers ─────────────────────────────────────────────────

/** In-progress streaming PUT — mirrors the firmware state machine.
 * `path` is the absolute staging-dir path opened by CMD_DEPLOY_PUT;
 * `remaining` is how many body bytes the host still owes us. Cleared
 * when remaining hits zero or when the deploy session is reset. */
let putState: {path: string; remaining: number} | null = null

function clearPut(): void {
  putState = null
}

function handleDeployPut(payload: Buffer): void {
  // Payload: u16le name_len | name | u32le total_size
  clearPut()

  if (payload.length < 6) {
    sendErr('put header too short')
    return
  }
  const nameLen = payload.readUInt16LE(0)
  if (payload.length < 2 + nameLen + 4) {
    sendErr('put filename too long')
    return
  }
  const name = payload.subarray(2, 2 + nameLen).toString('utf-8')
  const totalSize = payload.readUInt32LE(2 + nameLen)

  const filePath = resolveSandboxPath(stagingDir, name)
  ensureDir(pathlib.dirname(filePath))
  // Truncate to size 0 so subsequent chunks append into a known-empty file.
  writeFileSync(filePath, Buffer.alloc(0))

  if (totalSize > 0) {
    putState = {path: filePath, remaining: totalSize}
  }
  sendOk()
}

function handleDeployPutChunk(payload: Buffer): void {
  if (!putState) {
    sendErr('put chunk without active put')
    return
  }
  if (payload.length > putState.remaining) {
    clearPut()
    sendErr('put chunk overruns declared size')
    return
  }
  appendFileSync(putState.path, payload)
  putState.remaining -= payload.length
  if (putState.remaining === 0) {
    clearPut()
  }
  sendOk()
}

function handleDeployKeep(payload: Buffer): void {
  const nameLen = payload.readUInt16LE(0)
  const name = payload.subarray(2, 2 + nameLen).toString('utf-8')

  // Firmware uses FS_BASE + name as source (e.g. /appfs + /app/main.bjs)
  const src = resolveSandboxPath(fsRoot, name)
  const dst = resolveSandboxPath(stagingDir, name)
  ensureDir(pathlib.dirname(dst))

  if (existsSync(src)) {
    copyFileSync(src, dst)
  }
  sendOk()
}

function handleDeployChecksum(payload: Buffer): void {
  const nameLen = payload.readUInt16LE(0)
  const name = payload.subarray(2, 2 + nameLen).toString('utf-8')
  const expectedHash = payload.subarray(2 + nameLen, 2 + nameLen + 32)

  // Firmware checks FS_BASE + name (e.g. /appfs + /app/main.bjs)
  const filePath = resolveSandboxPath(fsRoot, name)
  if (!existsSync(filePath)) {
    // File doesn't exist: no match
    send(MSG_CHECKSUM_RESULT, Buffer.from([0x00]))
    return
  }

  const actualHash = createHash('sha256').update(readFileSync(filePath)).digest()
  const match = actualHash.equals(expectedHash)
  send(MSG_CHECKSUM_RESULT, Buffer.from([match ? 0x01 : 0x00]))
}

function handleDeployErase(): void {
  rmSync(appDir, {force: true, recursive: true})
  sendOk()
}

function handleDeployDone(): void {
  // Mirror firmware: refuse DONE while a streaming PUT is mid-flight so a
  // CLI bug can't promote a truncated file into the live app dir.
  if (putState) {
    clearPut()
    rmSync(stagingDir, {force: true, recursive: true})
    sendErr('deploy done while put in progress')
    return
  }

  // Atomic swap: .deploy-tmp/app → app (matches firmware behavior)
  const stagedApp = pathlib.join(stagingDir, 'app')
  rmSync(oldDir, {force: true, recursive: true})

  if (existsSync(appDir)) {
    renameSync(appDir, oldDir)
  }

  ensureDir(pathlib.dirname(appDir))
  if (existsSync(stagedApp)) {
    renameSync(stagedApp, appDir)
  }

  // Clean up staging dir and old backup
  rmSync(stagingDir, {force: true, recursive: true})
  rmSync(oldDir, {force: true, recursive: true})

  sendOk()
}

function handleDeployAbort(): void {
  clearPut()
  rmSync(stagingDir, {force: true, recursive: true})
  sendOk()
}

/** Adopt a streamed `.tgz` as the live app (mirrors the firmware
 * MIK_CMD_DEPLOY_BUILD / mik__ota_adopt_build path). The build was streamed
 * via PUT("/.build.tgz") + chunks into <stagingDir>/.build.tgz; here we
 * verify its checksum, unpack it, and swap its `app/` member into the live app
 * dir. The sim has no persistent OTA rollback state, so this just installs.
 * Payload: u16le checksum_len | checksum. */
function handleDeployBuild(payload: Buffer): void {
  clearPut()
  if (payload.length < 2) {
    sendErr('build header too short')
    return
  }
  const chkLen = payload.readUInt16LE(0)
  const checksum = payload.subarray(2, 2 + chkLen).toString('utf-8')

  const tgzPath = pathlib.join(stagingDir, '.build.tgz')
  if (!existsSync(tgzPath)) {
    sendErr('build not staged')
    return
  }
  if (checksum) {
    const got = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
    if (got !== checksum) {
      sendErr('checksum mismatch (corrupt build)')
      return
    }
  }

  const unpackDir = pathlib.join(stagingDir, '.build-unpack')
  rmSync(unpackDir, {force: true, recursive: true})
  ensureDir(unpackDir)
  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', unpackDir])
  } catch {
    sendErr('unpack build')
    return
  }

  const stagedApp = pathlib.join(unpackDir, 'app')
  if (!existsSync(stagedApp)) {
    sendErr('build missing app/')
    return
  }

  // Atomic-ish swap: app → old, unpacked app/ → app, then drop staging.
  rmSync(oldDir, {force: true, recursive: true})
  if (existsSync(appDir)) {
    renameSync(appDir, oldDir)
  }
  ensureDir(pathlib.dirname(appDir))
  renameSync(stagedApp, appDir)
  rmSync(stagingDir, {force: true, recursive: true})
  rmSync(oldDir, {force: true, recursive: true})
  sendOk()
}

// ── Config handlers ─────────────────────────────────────────────────

function handleConfigList(): void {
  const store = readStore(configPath)
  const entries = Object.entries(store.entries).map(([key, entry]) => ({
    key,
    value: entry.secret ? '' : entry.value,
    secret: entry.secret,
  }))
  const cbor = Buffer.from(encodeCbor(entries))
  send(MSG_CONFIG_ENTRIES, cbor)
}

function handleConfigSet(payload: Buffer): void {
  const flags = payload[0]!
  const secret = (flags & ENV_FLAG_SECRET) !== 0
  const keyLen = payload.readUInt16LE(1)
  const key = payload.subarray(3, 3 + keyLen).toString('utf-8')
  const valLen = payload.readUInt16LE(3 + keyLen)
  const value = payload.subarray(5 + keyLen, 5 + keyLen + valLen).toString('utf-8')

  const store = readStore(configPath)
  const prev = store.entries[key]
  const changed = !prev || prev.value !== value || prev.secret !== secret
  if (changed) {
    store.entries[key] = {value, secret}
    writeStore(configPath, store)
  }
  send(MSG_OK, Buffer.from([changed ? 1 : 0]))
}

function handleConfigDelete(payload: Buffer): void {
  const keyLen = payload.readUInt16LE(0)
  const key = payload.subarray(2, 2 + keyLen).toString('utf-8')

  const store = readStore(configPath)
  const existed = key in store.entries
  if (existed) {
    const {[key]: _, ...rest} = store.entries
    store.entries = rest
    writeStore(configPath, store)
  }
  send(MSG_OK, Buffer.from([existed ? 1 : 0]))
}

// ── KV provisioning handlers ────────────────────────────────────────
// Mirror the firmware's kv namespaces: values are CBOR-encoded blobs,
// persisted where the sim's `mikro/kv/nvs` builtin reads them (nvs_kv.json
// for mik.kv, nvs_sys.json for mik.sys, base64(cbor) per key — see
// devRunner's nvs_kv RPC handlers). A leading namespace byte selects the
// store (0 = kv, 1 = sys), matching the firmware handler.

interface NvsKvStore {
  entries: Record<string, string>
}

function kvStorePath(ns: number): string {
  return pathlib.join(mikroDir, ns === 1 ? 'nvs_sys.json' : 'nvs_kv.json')
}

function readKvStore(path: string): NvsKvStore {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NvsKvStore
  } catch {
    return {entries: {}}
  }
}

function handleKvSet(payload: Buffer): void {
  const ns = payload[0]!
  if (ns > 1) {
    sendErr('unknown kv namespace')
    return
  }
  const keyLen = payload.readUInt16LE(1)
  const key = payload.subarray(3, 3 + keyLen).toString('utf-8')
  const valLen = payload.readUInt16LE(3 + keyLen)
  const value = payload.subarray(5 + keyLen, 5 + keyLen + valLen).toString('utf-8')

  const path = kvStorePath(ns)
  const store = readKvStore(path)
  store.entries[key] = Buffer.from(encodeCbor(value)).toString('base64')
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n')
  sendOk()
}

function handleKvDelete(payload: Buffer): void {
  const ns = payload[0]!
  if (ns > 1) {
    sendErr('unknown kv namespace')
    return
  }
  const keyLen = payload.readUInt16LE(1)
  const key = payload.subarray(3, 3 + keyLen).toString('utf-8')

  const path = kvStorePath(ns)
  const store = readKvStore(path)
  const existed = key in store.entries
  if (existed) {
    const {[key]: _, ...rest} = store.entries
    writeFileSync(path, JSON.stringify({entries: rest}, null, 2) + '\n')
  }
  send(MSG_OK, Buffer.from([existed ? 1 : 0]))
}

// ── REPL handlers ───────────────────────────────────────────────────

function handleEval(payload: Buffer): void {
  const code = payload.toString('utf-8')
  if (runner) {
    evalQueue.push(code)
  } else {
    send(MSG_EVAL_ERROR, 'No app deployed. Deploy an app first.')
    send(MSG_PROMPT)
  }
}

function handleComplete(payload: Buffer): void {
  const partial = payload.toString('utf-8')
  // Return empty completions for now
  const cbor = Buffer.from(encodeCbor({prefix: partial, items: []}))
  send(MSG_COMPLETIONS, cbor)
}

function handleDirective(payload: Buffer): void {
  const line = payload.toString('utf-8')
  const [cmd, ...rest] = line.split(' ')
  const arg = rest.join(' ').trim()

  switch (cmd) {
    case '/help':
    case 'help':
      send(
        MSG_INFO,
        '/help      Show this help\n' +
          '/mem       Show heap memory usage\n' +
          '/gc        Run garbage collector\n' +
          '/pause     Pause app (suspend timers/callbacks)\n' +
          '/resume    Resume app\n' +
          '/ls [DIR]  List directory contents\n' +
          '/cat FILE  Print file contents\n' +
          '/rm FILE   Remove a file\n' +
          '/info      Show runtime info\n' +
          '/df        Show filesystem free/total space\n' +
          '/du [PATH] Show disk usage for path\n' +
          '/exit      Exit REPL\n',
      )
      break

    case '/mem':
    case 'mem': {
      if (!runner) {
        send(MSG_INFO, 'No runtime active')
        break
      }
      const m = runner.runtime.memoryUsage()
      send(
        MSG_INFO,
        `Heap used: ${m.heapUsed} / ${m.heapTotal} bytes ` +
          `(${m.heapTotal > 0 ? ((m.heapUsed / m.heapTotal) * 100).toFixed(1) : 0}%)`,
      )
      break
    }

    case '/gc':
    case 'gc': {
      if (!runner) break
      const before = runner.runtime.memoryUsage().heapUsed
      runner.runtime.gc()
      const after = runner.runtime.memoryUsage().heapUsed
      send(MSG_INFO, `GC collected ${before - after} bytes (${before} -> ${after})`)
      break
    }

    case '/pause':
      if (runner?.paused) {
        send(MSG_INFO, 'App is already paused')
      } else if (runner) {
        runner.paused = true
        send(MSG_INFO, 'App paused (timers, callbacks suspended). Use /resume to continue.')
      }
      break

    case '/resume':
      if (runner && !runner.paused) {
        send(MSG_INFO, 'App is not paused')
      } else if (runner) {
        runner.paused = false
        send(MSG_INFO, 'App resumed')
      }
      break

    case '/info': {
      const lines: string[] = ['Chip: simulator']
      if (runner) {
        const m = runner.runtime.memoryUsage()
        lines.push(
          `JS heap: ${m.heapUsed} / ${m.heapTotal} bytes ` +
            `(${m.heapTotal > 0 ? ((m.heapUsed / m.heapTotal) * 100).toFixed(1) : 0}% used)`,
        )
      }
      try {
        const total = fsDiskUsage(appDir)
        lines.push(`Filesystem: ${total} bytes used`)
      } catch {
        // skip
      }
      send(MSG_INFO, lines.join('\n'))
      break
    }

    case '/df': {
      try {
        const used = fsDiskUsage(appDir)
        const limit = fsLimit ?? 1024 * 1024
        const free = limit > used ? limit - used : 0
        send(
          MSG_INFO,
          `Filesystem: ${used} / ${limit} bytes used ` +
            `(${limit > 0 ? ((used / limit) * 100).toFixed(1) : 0}%), ${free} bytes free`,
        )
      } catch {
        send(MSG_INFO, 'Filesystem info unavailable')
      }
      break
    }

    case '/du': {
      const target = arg || '/'
      const resolved = resolveSandboxPath(fsRoot, target)
      try {
        const st = statSync(resolved)
        if (!st.isDirectory()) {
          send(MSG_INFO, `  ${st.size}\t${target}`)
          break
        }
        let total = 0
        const lines: string[] = []
        for (const entry of readdirSync(resolved, {withFileTypes: true})) {
          if (!entry.isFile()) continue
          const size = statSync(pathlib.join(resolved, entry.name)).size
          const trailing = target.endsWith('/') ? '' : '/'
          lines.push(`  ${size}\t${target}${trailing}${entry.name}`)
          total += size
        }
        lines.push(`  ${total}\ttotal`)
        send(MSG_INFO, lines.join('\n'))
      } catch {
        send(MSG_INFO, `Cannot stat '${target}'`)
      }
      break
    }

    case '/ls': {
      const target = arg || '/'
      const resolved = resolveSandboxPath(fsRoot, target)
      try {
        const entries = readdirSync(resolved, {withFileTypes: true})
        const lines: string[] = []
        for (const entry of entries) {
          const size = entry.isFile() ? statSync(pathlib.join(resolved, entry.name)).size : 0
          const suffix = entry.isDirectory() ? '/' : ''
          lines.push(entry.isFile() ? `  ${size}\t${entry.name}` : `  -\t${entry.name}${suffix}`)
        }
        if (lines.length === 0) lines.push('  (empty)')
        send(MSG_INFO, lines.join('\n'))
      } catch {
        send(MSG_INFO, `Cannot open '${target}'`)
      }
      break
    }

    case '/cat': {
      if (!arg) {
        send(MSG_INFO, 'Usage: /cat FILE')
        break
      }
      const resolved = resolveSandboxPath(fsRoot, arg)
      try {
        const content = readFileSync(resolved, 'utf-8')
        send(MSG_INFO, content)
      } catch {
        send(MSG_INFO, `Cannot open '${arg}'`)
      }
      break
    }

    case '/rm': {
      if (!arg) {
        send(MSG_INFO, 'Usage: /rm FILE')
        break
      }
      const resolved = resolveSandboxPath(fsRoot, arg)
      try {
        rmSync(resolved)
        send(MSG_INFO, `Removed '${arg}'`)
      } catch {
        send(MSG_INFO, `Cannot remove '${arg}'`)
      }
      break
    }

    default:
      send(MSG_INFO, `Unknown directive: ${line}`)
  }
}

function fsDiskUsage(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = pathlib.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += fsDiskUsage(full)
    } else {
      total += statSync(full).size
    }
  }
  return total
}

// ── Frame dispatcher ────────────────────────────────────────────────

async function handleFrame(frame: Frame): Promise<void> {
  const {type, payload} = frame

  // Deploy commands (0x20-0x27)
  if (type >= 0x20 && type <= 0x27) {
    switch (type) {
      case CMD_DEPLOY_PUT:
        handleDeployPut(payload)
        break
      case CMD_DEPLOY_PUT_CHUNK:
        handleDeployPutChunk(payload)
        break
      case CMD_DEPLOY_DONE:
        handleDeployDone()
        break
      case CMD_DEPLOY_ABORT:
        handleDeployAbort()
        break
      case CMD_DEPLOY_ERASE:
        handleDeployErase()
        break
      case CMD_DEPLOY_KEEP:
        handleDeployKeep(payload)
        break
      case CMD_DEPLOY_CHECKSUM:
        handleDeployChecksum(payload)
        break
    }
    return
  }

  // Config + kv provisioning commands (0x40-0x44)
  if (type >= 0x40 && type <= 0x44) {
    switch (type) {
      case CMD_CONFIG_LIST:
        handleConfigList()
        break
      case CMD_CONFIG_SET:
        handleConfigSet(payload)
        break
      case CMD_CONFIG_DELETE:
        handleConfigDelete(payload)
        break
      case CMD_KV_SET:
        handleKvSet(payload)
        break
      case CMD_KV_DELETE:
        handleKvDelete(payload)
        break
    }
    return
  }

  // REPL commands (0x10-0x14)
  switch (type) {
    case CMD_EVAL:
      handleEval(payload)
      break
    case CMD_COMPLETE:
      handleComplete(payload)
      break
    case CMD_DIRECTIVE:
      handleDirective(payload)
      break
    case CMD_EXIT:
      process.exit(0)
      break
    case CMD_HELLO:
      // Match firmware contract: device only sends MSG_READY in response to
      // CMD_HELLO. The CLI polls HELLO every 250ms after a restart, and uses
      // a 1-second post-restart blackout (session.ts) to ignore stale READYs
      // — answering HELLO here lets the CLI clear that blackout naturally.
      sendReady()
      break
    case CMD_RESTART:
      // Don't sendReady() unprompted: the CLI's awaitReady$ filter discards
      // any MSG_READY that arrives within 1s of CMD_RESTART (the blackout
      // covers stale pre-reboot frames in flight from the device). Letting
      // CMD_HELLO polling drive the post-restart handshake matches the
      // firmware behavior and keeps the CLI's restart logic identical
      // across sim and device.
      await bootOrRunManifest()
      break
    case CMD_RUNTIME_PAUSE:
      if (runner) runner.paused = true
      sendOk()
      break
    case CMD_RUNTIME_RESUME:
      if (runner) runner.paused = false
      sendOk()
      break
    case CMD_FS_GET:
      // File logging itself isn't wired into the simulator yet, so there's
      // nothing to pull. Surface a clear error instead of timing out.
      sendErr('fs get: not supported in simulator')
      break
    case CMD_LOG_RESET:
      // File logging isn't wired into the simulator yet, so there's nothing
      // to clear. Surface a clear error instead of timing out.
      sendErr('log reset: not supported in simulator')
      break
    case CMD_DEPLOY_BUILD:
      handleDeployBuild(payload)
      break
  }
}

/** Post-boot orchestration: if the deployed app carries a `tests` array
 * in package.json, run the manifest loop (fresh runtime per file, emit
 * MSG_MANIFEST_DONE at the end, then fall through to an idle runtime so
 * the CLI can still issue REPL/deploy commands). Otherwise, boot the
 * main app normally. */
async function bootOrRunManifest(): Promise<void> {
  const tests = findTestManifest()
  if (tests.length > 0) {
    try {
      await runTestManifest(tests)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`simProcess: manifest run failed: ${msg}\n`)
    }
    // Idle runtime for post-test REPL / deploy traffic.
    await bootRuntime()
  } else {
    await bootRuntime()
  }
}

// ── Ready message ───────────────────────────────────────────────────

const cliVersion = pkg.version

function sendReady(): void {
  const cbor = Buffer.from(encodeCbor({chip: 'simulator', id: null, v: cliVersion}))
  send(MSG_READY, cbor)
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDir(fsRoot)

  // Boot runtime (runs deployed app, or iterates through a tests manifest
  // if one is present — matching the firmware supervisor flow).
  await bootOrRunManifest()

  // Profile mode: runtime has booted and the full static import graph has
  // been loaded. Write the profile JSON and exit. We don't start the TLV
  // listener because profile runs are one-shot.
  if (profileOutput !== undefined) {
    if (!runner) {
      process.stderr.write('simProcess: profile requested but no app deployed\n')
      process.exit(1)
    }
    const entries = runner.runtime.getProfile()
    const baseline = runner.runtime.getProfileBaseline()
    writeFileSync(profileOutput, JSON.stringify({entries, baseline}, null, 2) + '\n')
    process.exit(0)
  }

  // Send ready to CLI
  sendReady()

  // Set up stdin frame parser (raw TLV, no type filtering like FrameParser does).
  // Frames are queued and processed sequentially to avoid races when async
  // handlers (CMD_RESTART) overlap with subsequent frames.
  let buf = Buffer.alloc(0)
  const frameQueue: Frame[] = []
  let processing = false

  async function drainFrameQueue(): Promise<void> {
    if (processing) return
    processing = true
    while (frameQueue.length > 0) {
      const frame = frameQueue.shift()!
      try {
        await handleFrame(frame)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        sendErr(msg)
      }
    }
    processing = false
  }

  process.stdin.on('data', (chunk: Buffer) => {
    buf = buf.length > 0 ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)

    let offset = 0
    while (offset + HEADER_SIZE <= buf.length) {
      const result = parseFrame(buf, offset)
      if (!result) break
      offset += result.bytesConsumed
      frameQueue.push(result.frame)
    }

    // Keep unconsumed bytes
    buf = offset > 0 ? Buffer.from(buf.subarray(offset)) : buf

    void drainFrameQueue()
  })

  process.stdin.on('end', () => {
    process.exit(0)
  })
}

main().catch((err: unknown) => {
  process.stderr.write(`simProcess fatal: ${err}\n`)
  process.exit(1)
})

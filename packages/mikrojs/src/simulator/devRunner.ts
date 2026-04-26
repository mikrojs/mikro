import nodeFs from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import * as pathlib from 'node:path'

import {type HostMessage, MikroRuntime} from '@mikrojs/native'
import {Subject} from 'rxjs'

import {builtinModuleNames, defaultBuiltins} from './builtins/index.js'
import type {BuiltinName} from './builtins/types.js'

const DEFAULT_MEM_LIMIT = 300 * 1024 // 300 KB
const DEFAULT_FS_ROOT = '.mikro/sim-fs'
const DEFAULT_FS_LIMIT = 1024 * 1024 // 1 MB

// Node-side handler for the http stub's host.call('http.fetch'). Uses Node's
// global fetch so the simulator can hit real URLs without a device. Body is
// base64-encoded for transport since RPC payloads are JSON strings.
interface HttpFetchArgs {
  url: string
  method?: string
  headers?: [string, string][]
  body?: string // base64
}
interface HttpFetchResult {
  status: number
  headers: [string, string][]
  body: string // base64
}
async function rpcHttpFetch(args: HttpFetchArgs): Promise<HttpFetchResult> {
  const init: RequestInit = {method: args.method ?? 'GET'}
  if (args.headers && args.headers.length > 0) init.headers = args.headers
  if (args.body) init.body = Buffer.from(args.body, 'base64')
  const res = await fetch(args.url, init)
  const headers: [string, string][] = []
  res.headers.forEach((v, k) => headers.push([k, v]))
  const buf = Buffer.from(await res.arrayBuffer())
  return {status: res.status, headers, body: buf.toString('base64')}
}

// Persistent NVS-backed kv for the simulator. Mirrors the firmware contract:
// `mikrojs/kv/nvs` survives power cycles on device, so it must survive
// `mikro sim dev` restarts here. Stored alongside `nvs.json` (env config) as
// `nvs_kv.json` — values are base64-encoded CBOR blobs (the QuickJS-side
// stub wraps user values via native:cbor before persistence).
interface NvsKvStore {
  entries: Record<string, string> // key → base64(cbor)
}
function nvsKvPath(fsRoot: string): string {
  return pathlib.join(pathlib.dirname(fsRoot), 'nvs_kv.json')
}
function readNvsKvStore(fsRoot: string): NvsKvStore {
  try {
    return JSON.parse(nodeFs.readFileSync(nvsKvPath(fsRoot), 'utf-8')) as NvsKvStore
  } catch {
    return {entries: {}}
  }
}
function writeNvsKvStore(fsRoot: string, store: NvsKvStore): void {
  nodeFs.writeFileSync(nvsKvPath(fsRoot), JSON.stringify(store, null, 2) + '\n')
}

export interface DevRunnerOptions {
  script: string
  memLimit?: number
  fsRoot?: string
  fsLimit?: number
  fsReadMax?: number
  env?: Record<string, string>
  /**
   * User-provided stub sources keyed by module name (e.g. 'native:wifi').
   * These override the default stubs. TypeScript is stripped before registration.
   */
  stubSources?: Record<string, string>
  /**
   * Enable per-module memory profiling. Profile data is collected as modules
   * are loaded and can be read via runtime.getProfile() after execution.
   */
  profile?: boolean
}

export interface DevRunner {
  /** Observable stream of host messages from the QuickJS runtime. */
  messages$: Subject<HostMessage>
  /** Post a message into the QuickJS runtime (delivered on next loop tick). */
  postMessage(type: string, data: string): void
  /** Start the event loop. Returns a cleanup function. */
  start(): () => void
  /** Register a callback that runs on each tick, after loopOnce + drainMessages. */
  onTick(callback: () => void): void
  /** When true, skips loopOnce (timers/promises freeze) but tick callbacks still run. */
  paused: boolean
  /** The underlying MikroRuntime instance. */
  runtime: MikroRuntime
}

/**
 * Create a QuickJS dev runner for the simulator.
 * Default stubs provide mock implementations for all native modules.
 * User stubs (from sim/*.stub.ts) override defaults.
 */
export function createDevRunner(options: DevRunnerOptions): DevRunner {
  const {script, env, memLimit = DEFAULT_MEM_LIMIT, fsLimit = DEFAULT_FS_LIMIT, fsReadMax} = options
  const fsRoot = pathlib.resolve(options.fsRoot ?? DEFAULT_FS_ROOT)
  nodeFs.mkdirSync(fsRoot, {recursive: true})

  // Resolve the entry script to a logical path rooted at fsRoot (e.g.
  // /app/http/foo.test.bjs). Passing a logical path — rather than an
  // absolute host path — lets bytecode's baked module names (also logical,
  // e.g. /app/http/foo.test.js) line up with the runtime module resolver, so
  // cross-file imports inside bytecode modules resolve against fsRoot via
  // fs_base_path (set below).
  let logicalScript: string
  if (pathlib.isAbsolute(script)) {
    // Subprocess mode: script is already inside fsRoot.
    const rel = pathlib.relative(fsRoot, script)
    if (rel.startsWith('..') || pathlib.isAbsolute(rel)) {
      throw new Error(
        `Script ${script} is not inside fsRoot ${fsRoot}; cannot compute logical path.`,
      )
    }
    logicalScript = '/' + rel.split(pathlib.sep).join('/')
  } else {
    // In-process dev mode: symlink the script's top-level directory into
    // fsRoot so the runtime can read it via the fs_base_path prefix.
    const topDir = script.split(pathlib.sep)[0]!
    if (topDir) {
      const appDir = pathlib.resolve(topDir)
      const appLink = pathlib.join(fsRoot, topDir)
      try {
        const existing = nodeFs.readlinkSync(appLink)
        if (existing !== appDir) {
          nodeFs.unlinkSync(appLink)
          nodeFs.symlinkSync(appDir, appLink)
        }
      } catch {
        nodeFs.rmSync(appLink, {force: true, recursive: true})
        nodeFs.symlinkSync(appDir, appLink)
      }
    }
    logicalScript = '/' + script.split(pathlib.sep).join('/')
  }

  // Register virtual modules: default stubs, then user overrides
  const modules: Record<string, string> = {}
  for (const [name, builtin] of Object.entries(defaultBuiltins) as [
    BuiltinName,
    {source: string},
  ][]) {
    const moduleName = builtinModuleNames[name]
    if (!moduleName) continue
    modules[moduleName] = stripTypeScriptTypes(builtin.source, {mode: 'strip'})
  }

  // User stub sources override defaults (already stripped by loadSimStubs)
  if (options.stubSources) {
    for (const [moduleName, source] of Object.entries(options.stubSources)) {
      modules[moduleName] = source
    }
  }

  // fsBasePath enables logical module resolution: the runtime prepends it to
  // /-prefixed module names so bytecode's baked names can resolve to sim-fs.
  const runtime = new MikroRuntime({
    memLimit,
    env,
    fsRoot,
    fsBasePath: fsRoot,
    fsLimit,
    fsReadMax,
    modules,
  })

  // Profiling must be enabled before any module loads to capture the full
  // import graph. Do it immediately after runtime construction, before the
  // stub/console bootstrap registers or evaluates anything.
  if (options.profile) {
    runtime.enableProfiling()
  }

  // Strip TypeScript types from .ts files before QuickJS compiles them
  runtime.setPreprocessor((filename, source) => {
    if (filename.endsWith('.ts')) {
      return stripTypeScriptTypes(source, {mode: 'strip'})
    }
    return undefined
  })

  // RPC handler: bridges QuickJS host.call(...) to Node-side capabilities.
  // Returns a string for sync methods (host.call resolves immediately on
  // the QuickJS side) and a Promise for async ones (host.call returns a JS
  // Promise). Keeping nvs_kv ops sync matches firmware NVS semantics —
  // `set` is expected to be observable on the next read in the same tick.
  runtime.setRpcHandler((method, argsJson) => {
    if (method === 'http.fetch') {
      return rpcHttpFetch(JSON.parse(argsJson)).then((r) => JSON.stringify(r))
    }
    if (method === 'nvs_kv.list') {
      return JSON.stringify(readNvsKvStore(fsRoot).entries)
    }
    if (method === 'nvs_kv.set') {
      const {key, value} = JSON.parse(argsJson) as {key: string; value: string}
      const store = readNvsKvStore(fsRoot)
      store.entries[key] = value
      writeNvsKvStore(fsRoot, store)
      return '{}'
    }
    if (method === 'nvs_kv.remove') {
      const {key} = JSON.parse(argsJson) as {key: string}
      const store = readNvsKvStore(fsRoot)
      const existed = key in store.entries
      if (existed) {
        const {[key]: _omit, ...rest} = store.entries
        writeNvsKvStore(fsRoot, {entries: rest})
      }
      return JSON.stringify({existed})
    }
    if (method === 'nvs_kv.clear') {
      writeNvsKvStore(fsRoot, {entries: {}})
      return '{}'
    }
    throw new Error(`Unknown sim RPC method: ${method}`)
  })

  const messages$ = new Subject<HostMessage>()
  const tickCallbacks: (() => void)[] = []

  function start(): () => void {
    // Bootstrap console and evaluate user script inside start() so that
    // messages$ subscriptions are active before any messages are emitted.
    if (modules['native:console']) {
      runtime.evalModuleContent('native:dev_bootstrap', "import 'native:console'")
    }
    runtime.evalModule(logicalScript)

    // Drain any messages produced during evalModule
    for (const msg of runtime.drainMessages()) {
      messages$.next(msg)
    }

    let stopped = false

    function tick() {
      if (stopped) return
      if (!handle.paused) runtime.loopOnce()

      for (const msg of runtime.drainMessages()) {
        messages$.next(msg)
      }

      for (const cb of tickCallbacks) {
        cb()
      }

      setImmediate(tick)
    }
    setImmediate(tick)

    return () => {
      stopped = true
      messages$.complete()
    }
  }

  const handle: DevRunner = {
    messages$,
    postMessage(type: string, data: string) {
      runtime.postMessage(type, data)
    },
    start,
    onTick(callback: () => void) {
      tickCallbacks.push(callback)
    },
    paused: false,
    runtime,
  }
  return handle
}

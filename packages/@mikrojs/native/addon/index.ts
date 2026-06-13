import {createRequire} from 'node:module'
import {join} from 'node:path'

import type {
  HostMessage,
  MikroRuntimeOptions,
  NativeBindings,
  NativeMikroRuntime,
  ProfileEntry,
} from './types.js'

const require = createRequire(import.meta.url)
const nodeGypBuild = require('node-gyp-build') as (pkgRoot: string) => unknown

function loadBindings(): NativeBindings {
  const pkgRoot = join(import.meta.dirname, '..')
  try {
    return nodeGypBuild(pkgRoot) as NativeBindings
  } catch (prebuildErr) {
    // Dev fallback: cmake-js builds to addon/build/Release/, which is outside
    // the paths node-gyp-build probes by default.
    const devPath = join(pkgRoot, 'addon', 'build', 'Release', 'mikrojs_node.node')
    try {
      return require(devPath) as NativeBindings
    } catch {
      throw prebuildErr
    }
  }
}

const bindings = loadBindings()

export class MikroRuntime {
  private native: NativeMikroRuntime

  constructor(options?: MikroRuntimeOptions) {
    this.native = new bindings.MikroRuntime(options)
  }

  evalModule(filename: string, isMain = true): void {
    this.native.evalModule(filename, isMain)
  }

  /** Evaluate module source code directly, bypassing filesystem path resolution. */
  evalModuleContent(filename: string, content: string): void {
    this.native.evalModuleContent(filename, content)
  }

  /** Evaluate a script (not module) and return the stringified result. Returns undefined if the result is undefined/null. */
  evalScript(code: string): string | undefined {
    return this.native.evalScript(code)
  }

  /** Evaluate a script as the REPL would: inspect the result (so objects
   *  render as `{...}` instead of `[object Object]`) and stash the value
   *  as `globalThis._` for follow-up expressions. Mirrors the firmware
   *  REPL's eval path. Returns undefined for `undefined` results. */
  evalForRepl(code: string, depth = 2): string | undefined {
    return this.native.evalForRepl(code, depth)
  }

  loop(): Promise<void> {
    return this.native.loop()
  }

  /** Run one iteration of the event loop synchronously. Returns 0 on success. */
  loopOnce(): number {
    return this.native.loopOnce()
  }

  stop(): void {
    this.native.stop()
  }

  dispose(): void {
    this.native.dispose()
  }

  /** Register a JS source string as a named virtual module.
   * Virtual modules are checked by the loader before builtin bytecode,
   * allowing JS-based mocks to override any native:* C module. */
  registerModuleSource(name: string, source: string): void {
    this.native.registerModuleSource(name, source)
  }

  /** Drain all outbound messages sent from QuickJS via native:mikro/host.send().
   * Returns and clears the queue. Call after each loopOnce(). */
  drainMessages(): HostMessage[] {
    return this.native.drainMessages()
  }

  /** Post a message from Node.js into the QuickJS runtime.
   * Delivered to the native:mikro/host.onMessage() callback on the next loop tick. */
  postMessage(type: string, data: string): void {
    this.native.postMessage(type, data)
  }

  /** Set a preprocessor function called on module source before compilation.
   * Return a string to replace the source, or undefined to use the original.
   * Useful for stripping TypeScript types from .ts files. */
  setPreprocessor(fn: (filename: string, source: string) => string | undefined): void {
    this.native.setPreprocessor(fn)
  }

  /** Set a synchronous RPC handler called from QuickJS via native:mikro/host.call().
   * The handler receives a method name (e.g. 'pin.pinMode') and JSON-encoded args,
   * and must return a JSON-encoded result string (or a Promise of one for async). */
  setRpcHandler(handler: (method: string, argsJson: string) => string | Promise<string>): void {
    this.native.setRpcHandler(handler)
  }

  /** Enable per-module memory profiling. Must be called before any module loads
   * to capture the full import graph. Profile storage lives outside QuickJS's
   * tracked heap so instrumentation does not pollute the numbers being measured. */
  enableProfiling(): void {
    this.native.enableProfiling()
  }

  /** Return the collected profile entries. Each entry records the QuickJS heap
   * delta observed while loading a specific module. */
  getProfile(): ProfileEntry[] {
    return this.native.getProfile()
  }

  /** Return the QuickJS heap baseline (bytes) at the time profiling was enabled.
   * This is the cost of the runtime + context + built-in prototypes, before
   * any user modules are loaded. */
  getProfileBaseline(): number {
    return this.native.getProfileBaseline()
  }

  /** Snapshot the QuickJS heap. Mirrors the firmware's `/mem` directive
   *  which calls JS_ComputeMemoryUsage directly. `heapTotal` is
   *  `malloc_limit` (or 0 if no limit is set). */
  memoryUsage(): {heapUsed: number; heapTotal: number} {
    return this.native.memoryUsage()
  }

  /** Trigger QuickJS garbage collection. Mirrors the firmware's `/gc`
   *  directive (JS_RunGC on the underlying JSRuntime). */
  gc(): void {
    this.native.gc()
  }

  /** Install the test-helper globals (`__testEmit`, `__testFileDone`) on
   *  this runtime. Opt-in so ordinary dev/REPL runs don't carry them.
   *  Mirrors `MIK_EnableTestHelpers` — call it per test-file the same way
   *  the firmware supervisor does. */
  enableTestHelpers(): void {
    this.native.enableTestHelpers()
  }
}

/** Serialize a JSON string to QuickJS binary JSON (bjson) format. */
export function jsonToBjson(json: string): Buffer {
  return bindings.jsonToBjson(json)
}

/** Compile a JS module to QuickJS bytecode. External imports must be declared to avoid resolution errors. */
export function compileBytecode(source: string, moduleName: string, externals?: string[]): Buffer {
  return bindings.compileBytecode(source, moduleName, externals)
}

/** Compile a JS module to bytecode and return as a C header string (equivalent to qjsc -o header.h). */
export function compileBytecodeToHeader(
  source: string,
  moduleName: string,
  symbolName: string,
  externals?: string[],
): string {
  const buf = bindings.compileBytecode(source, moduleName, externals)

  // Match qjsc dump_hex format: " 0xNN," with newline every 8 bytes
  let hex = ''
  let col = 0
  for (let i = 0; i < buf.length; i++) {
    hex += ` 0x${buf[i]!.toString(16).padStart(2, '0')},`
    if (++col === 8) {
      hex += '\n'
      col = 0
    }
  }
  if (col !== 0) {
    hex += '\n'
  }

  return (
    `/* File generated automatically by the QuickJS-ng compiler. */\n` +
    `\n` +
    `#include <inttypes.h>\n` +
    `\n` +
    `const uint32_t ${symbolName}_size = ${buf.length};\n` +
    `\n` +
    `const uint8_t ${symbolName}[${buf.length}] = {\n` +
    hex +
    `};\n`
  )
}

export type {HostMessage, MikroRuntimeOptions, NativeMikroRuntime, ProfileEntry} from './types.ts'

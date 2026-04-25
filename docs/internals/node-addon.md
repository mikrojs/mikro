---
title: Node.js Addon
description: How the runtime runs on desktop via Node-API, host bridge, and RPC
---

# Node.js Addon

The Node.js addon (`packages/@mikrojs/native/addon/`) allows the Mikro.js runtime to run on desktop as a native Node.js module. This powers the CLI's `mikro dev` command, the simulator, and host-side testing.

## Architecture

```
 Node.js process
 ┌────────────────────────────────────────┐
 │  MikroRuntime (TypeScript)             │
 │    │                                   │
 │    ├── evalModule() / evalScript()     │
 │    ├── loop()  ──► LoopWorker (async)  │
 │    ├── postMessage() ──┐               │
 │    └── drainMessages() │               │
 │                        │               │
 │  RuntimeWrap (C++, Node-API)           │
 │    │                   │               │
 │    ├── MIKRuntime      │               │
 │    └── HostBridge ◄────┘               │
 │         │                              │
 │         └── native:host (C module)       │
 └────────────────────────────────────────┘
```

## MikroRuntime class

The public TypeScript interface:

```ts
class MikroRuntime {
  // Execute a module from the filesystem
  evalModule(filename: string, isMain?: boolean): void

  // Execute a module from a source string
  evalModuleContent(filename: string, content: string): void

  // Execute a script (not a module) and return the result
  evalScript(code: string): string | undefined

  // Run the event loop asynchronously (resolves when stopped)
  loop(): Promise<void>

  // Run a single loop iteration synchronously
  loopOnce(): number

  // Stop the event loop
  stop(): void

  // Clean up all resources
  dispose(): void

  // Register a JS source string as a virtual module
  registerModuleSource(name: string, source: string): void

  // Read pending messages from QuickJS → Node.js
  drainMessages(): HostMessage[]

  // Send a message from Node.js → QuickJS
  postMessage(type: string, data: string): void

  // Set a preprocessor for module source (e.g., strip TypeScript types)
  setPreprocessor(fn: (filename: string, source: string) => string | undefined): void

  // Set an RPC handler for sync/async calls from QuickJS
  setRpcHandler(handler: (method: string, argsJson: string) => string | Promise<string>): void
}
```

## Async loop

The event loop runs on a separate thread via `LoopWorker` (a `Napi::AsyncWorker`):

```cpp
class LoopWorker : public Napi::AsyncWorker {
    void Execute() override {
        while (!stopped_) {
            int rc = MIK_Loop(mik_rt_);
            if (rc != 0) break;
            MIK_GetPlatform()->yield();
        }
    }
};
```

`loop()` returns a `Promise<void>` that resolves when the loop exits. This keeps Node.js's event loop free while the QuickJS runtime runs.

## Host bridge

The host bridge enables bidirectional communication between the QuickJS runtime and the Node.js host. Inside QuickJS, the `native:host` native module provides:

```js
import {send, onMessage, call, callAsync} from 'native:host'

// Send a message to the Node.js host
send('log', JSON.stringify({level: 'info', msg: 'hello'}))

// Receive messages from the host
onMessage((type, data) => {
  console.log('Got message: %s %s', type, data)
})

// Synchronous RPC call to the host
const result = call('readFile', JSON.stringify({path: '/tmp/foo'}))

// Async RPC call (returns a Promise)
const data = await callAsync('fetch', JSON.stringify({url: '...'}))
```

On the Node.js side:

```ts
const rt = new MikroRuntime()

// Send a message into QuickJS
rt.postMessage('config', JSON.stringify({debug: true}))

// Read messages from QuickJS
const messages = rt.drainMessages()
// → [{type: 'log', data: '{"level":"info","msg":"hello"}'}]

// Handle RPC calls from QuickJS
rt.setRpcHandler((method, argsJson) => {
  if (method === 'readFile') {
    return JSON.stringify(fs.readFileSync(JSON.parse(argsJson).path, 'utf8'))
  }
})
```

Messages are string pairs (`type` + `data`). The bridge stores outbound messages in a vector, drained by the host after each loop iteration. Inbound messages are delivered on the next loop tick.

## Preprocessor

The preprocessor hook transforms module source before QuickJS compiles it:

```ts
rt.setPreprocessor((filename, source) => {
  if (filename.endsWith('.ts')) {
    return stripTypes(source) // Remove TypeScript syntax
  }
  return undefined // No transformation
})
```

This is called from the C module loader via a callback. The preprocessor receives the filename and source, and returns either transformed source or `undefined` (no change). The CLI uses this to enable direct `.ts` file execution during development.

## Virtual modules

Virtual modules let the host override any module with a source string:

```ts
rt.registerModuleSource(
  'native:pin',
  `
    export function pinMode() { /* mock */ }
    export function digitalWrite() { /* mock */ }
`,
)
```

Virtual modules have the highest resolution priority (checked before native modules and builtins). This is how the simulator provides mock hardware APIs on desktop without compiling any ESP-IDF code.

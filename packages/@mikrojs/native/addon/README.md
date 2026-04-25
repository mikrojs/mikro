# addon/

Node-API (N-API) addon that exposes the mikrojs C++ runtime to Node.js.

- `binding.cpp` — N-API binding entry point, registers native functions
- `runtime_wrap.cpp/.h` — Wraps `MIKRuntime` as a JS class with methods like `evalModule`, `loop`, `postMessage`
- `platform_node.cpp` — `MIKPlatform` implementation backed by Node.js/libuv APIs
- `index.ts` — TypeScript entry point that loads the `.node` binary and exports `MikroRuntime`
- `types.ts` — TypeScript interfaces (`MikroRuntimeOptions`, `NativeBindings`, etc.)
- `CMakeLists.txt` — cmake-js build for the native addon

Built with `pnpm run build:native` (or `build:native:debug`).

# @mikrojs/native

Standalone, platform-independent C++ runtime library for mikrojs, powered by QuickJS-NG. Zero ESP-IDF dependencies — runs on any POSIX host for development and testing, and on ESP32 via a thin platform adapter.

## Directory structure

```
include/        Public C/C++ headers (mikrojs.h, platform.h, private.h, …)
src/            C/C++ source files (runtime, modules, timers, REPL, …)
runtime/        TypeScript runtime modules bundled to bytecode at build time
addon/          Node-API addon exposing the runtime to Node.js
scripts/        Build scripts (esbuild bundling, qjsc bytecode compilation)
test/           Host-side C++ tests (Unity, run via ctest)
```

## Build

```sh
# Standalone library (host)
cmake -B build && cmake --build build

# Run C++ tests
ctest --test-dir build --output-on-failure

# Node addon
pnpm run build:native
```

## Architecture

The runtime abstracts platform-specific operations via `MIKPlatform` (defined in `include/mikrojs/platform.h`). A default POSIX implementation is provided in `src/platform_posix.cpp`. The ESP32 adapter in `packages/@mikrojs/firmware/components/mikrojs/` supplies an ESP-IDF implementation.

### Runtime modules

TypeScript modules in `runtime/` are the JS-facing APIs (fetch, pin, wifi, etc.). During each CMake build they are:

1. Bundled with esbuild (`scripts/bundle-runtime.js`)
2. Compiled to bytecode with qjsc (`scripts/compile-bytecode.sh`)
3. Included as C headers in `src/builtins.cpp`

Type-checked separately via `tsconfig.runtime.json`:

```sh
tsc --noEmit -p tsconfig.runtime.json
```

### Node addon

The `addon/` directory contains a Node-API binding that wraps the C++ runtime for use from Node.js/TypeScript. See [`addon/README.md`](addon/README.md).

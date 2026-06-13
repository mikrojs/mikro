---
title: Architecture
description: How the Mikro.js build system, module registration, and bytecode pipeline work
---

# Architecture

This page explains how the pieces fit together. The goal is "enough to understand what goes where" when building drivers and board packages.

## Three layers

```
 ┌─────────────────────────────────────────────┐
 │  Board packages                             │
 │  Pin maps, sdkconfig, re-export drivers     │
 ├─────────────────────────────────────────────┤
 │  Driver packages                            │
 │  Native C or pure JS hardware abstractions  │
 ├─────────────────────────────────────────────┤
 │  Core runtime  (@mikrojs/native)            │
 │  QuickJS engine, event loop, builtins       │
 └─────────────────────────────────────────────┘
```

**Core runtime** is a standalone C++ library with zero ESP-IDF dependencies. It can be built and tested on a desktop.

**Driver packages** come in two flavors:

- **Native drivers**: ESP-IDF components with C/C++ code, registered via `MIK_REGISTER_MODULE` and `MIK_REGISTER_BUILTIN`. Compiled into firmware. Use for QSPI displays and other peripherals needing direct hardware access.
- **Pure JS drivers**: Regular npm packages that use core APIs like `mikro/spi`. Bundled and deployed with the user's app. No native code, no `cmake.js`.

**Board packages** are thin layers that depend on drivers and provide board-specific pin assignments. Native boards include sdkconfig and ESP-IDF components. Pure JS boards are just TypeScript re-exports.

## Native module registration

Native modules (C/C++ functions callable from JavaScript) self-register using the `MIK_REGISTER_MODULE` macro:

```cpp
MIK_REGISTER_MODULE(bme280, "native:@my-scope/bme280/sensor", mik__bme280_init, nullptr, nullptr)
```

The macro takes five arguments: a unique C identifier, the module name, an init function, an optional loop consumer, and an optional destroy function. It works via a GCC/Clang constructor attribute. At program startup, before `main()` runs, each registered module adds itself to a global linked list. When JavaScript code imports `native:@my-scope/bme280/sensor`, the module loader walks this list and calls the module's init function.

Native module names are package-qualified: `native:<package-name>/<module>`. The bare `native:mikro/*` namespace is reserved for the core runtime. The build defines `MIK_PACKAGE_NAME` per component and the macro enforces the prefix at compile time, so a package cannot claim or shadow another's `native:` name.

Modules are initialized lazily: the factory function runs on first import, not at startup. This keeps boot time and memory usage low when a module is compiled in but not used.

### Linker considerations

Because the module registration symbols live in static library archives, the linker may discard them if nothing else in the program references them. The `mikrojs_force_include_modules()` CMake function adds the necessary linker flags (`-u` on GCC/Clang) to force-include specific symbols:

```cmake
mikrojs_force_include_modules(bme280)
```

## Bytecode builtin registration

TypeScript wrapper modules are pre-compiled to QuickJS bytecode and embedded in the firmware binary. They register with `MIK_REGISTER_BUILTIN`:

```cpp
MIK_REGISTER_BUILTIN("@my-scope/bme280/sensor",
                      qjsc_bme280, qjsc_bme280_size)
```

This uses the same constructor/linked-list pattern as native modules. When JavaScript imports `@my-scope/bme280/sensor`, the loader finds the matching builtin, deserializes the bytecode with `JS_ReadObject`, and returns the module.

The builtin name matches the npm package path that user code imports. This is how `import {readSensor} from '@my-scope/bme280/sensor'` resolves without a filesystem lookup.

Like native modules, builtins need force-include linker flags:

```cmake
mikrojs_force_include_builtins(bme280)
```

## Bytecode pipeline

TypeScript source files become C headers containing bytecode arrays:

```
  runtime/bme280/bme280.ts
           │
           ▼
     esbuild bundle          (1 JS file, externals preserved)
           │
           ▼
     qjsc compile            (bytecode → C uint8_t array)
           │
           ▼
  gen/bme280.bytecode.h      (#include'd in .cpp, linked into firmware)
```

The `mikrojs_generate_bytecode()` CMake function orchestrates both steps:

```cmake
mikrojs_generate_bytecode(
    RUNTIME_DIR "${CMAKE_CURRENT_LIST_DIR}/../runtime"
    MODULES sensor
    MODULE_PREFIX "@my-scope/bme280"
    SYMBOL_PREFIX "bme280"
)
```

**esbuild** bundles each TypeScript module into a single JavaScript file. All `mikro/*` and `@mikrojs/*` imports are marked as external since they resolve at runtime inside the firmware.

**qjsc** (the QuickJS bytecode compiler) takes the bundled JS and produces a C header with a `const uint8_t[]` array. This is built from the same QuickJS source as the runtime engine, guaranteeing bytecode version compatibility.

## Module resolution at runtime

When JavaScript executes an `import` statement, the module loader checks several sources in order:

1. **Native modules**: Names starting with `native:` are looked up in the native module registry (the linked list populated by `MIK_REGISTER_MODULE`).
2. **Bytecode builtins**: Names matching registered builtins (e.g., `@my-scope/bme280/sensor`, `mikro/result`) are deserialized from embedded bytecode.
3. **Filesystem**: Relative paths (starting with `.` or `/`) are loaded from the device filesystem (LittleFS). JSON files are auto-wrapped. `.bjs` files are loaded as pre-compiled bytecode.

The module normalizer passes through `native:`, `mikro/`, and `@mikrojs/` prefixed names unchanged. Relative paths are resolved against the importing module's directory.

## How board packages wire in

The build system discovers driver and board packages automatically:

1. **Package discovery**: During CMake configure, the build system reads `esp32/package.json`, finds all `@mikrojs/*` dependencies, and calls `require('<pkg>/cmake')` on each.
2. **Component registration**: Each package's `cmake.js` exports a `componentPath` pointing to its ESP-IDF component directory. CMake adds these as extra component directories.
3. **sdkconfig merge**: If a package exports `sdkconfigDefaultsPath`, the file is appended to the sdkconfig defaults list. Board-specific values override the base project defaults.
4. **Dependency wiring**: ESP-IDF's component system handles the rest. `REQUIRES` declarations in each component's `CMakeLists.txt` set up include paths and link order.

## Key CMake functions

| Function                           | Purpose                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `mikrojs_generate_bytecode()`      | Run the TS -> esbuild -> qjsc pipeline for runtime modules                            |
| `mikrojs_force_include_modules()`  | Add `-u` linker flags so self-registered native modules survive dead-code elimination |
| `mikrojs_force_include_builtins()` | Same, but for bytecode builtins                                                       |

All three are defined in the CMake module exported by `@mikrojs/native` (accessed via `require('@mikrojs/native/cmake').cmakePath`).

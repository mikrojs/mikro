---
title: Architecture
description: How the Mikro.js build system, module registration, and bytecode pipeline work
---

# Architecture

This page explains how the parts of Mikro.js fit together, for people who build drivers and board packages.

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

**Drivers** are of two kinds:

- **Native drivers** are [native modules](./native-modules): C or C++ in an ESP-IDF component, compiled into the firmware. Apps import them by package name. None of their code is deployed with the app.
- **Pure JS drivers** are normal modules that use core APIs like `mikro/spi`. They are bundled and deployed with the app.

**Board packages** are thin layers that depend on drivers and provide board-specific pin assignments and sdkconfig defaults. C or C++ that a board needs is a native module, which the firmware project lists. See [Creating Boards](./creating-boards) and [Creating Drivers](./creating-drivers).

## Native module registration

A native module registers itself with `MIK_REGISTER_PUBLIC_MODULE`, under the name that apps import:

```cpp
MIK_REGISTER_PUBLIC_MODULE(epaper, "@my-scope/epaper/panel", mik__epaper_init, nullptr, nullptr)
```

The macro has five arguments: a unique C identifier, the module name, an init function, an optional loop consumer, and an optional destroy function. It uses a GCC/Clang constructor attribute. Before `main()` runs, each module adds itself to a global linked list. When JavaScript imports `@my-scope/epaper/panel`, the loader finds the module in this list and calls its init function.

The runtime's internal modules register with `MIK_REGISTER_MODULE`, under `native:mikro/*` names. Apps cannot import these names.

Each component's `CMakeLists.txt` sets `MIK_PACKAGE_NAME` (`mikro` for the runtime). At compile time, the macros make sure that each module name starts with it. This catches a module name copied from another package by mistake. It doesn't stop a package that sets another package's name on purpose.

NVS namespaces that start with `mik.` also belong to the runtime (`mik.env`, `mik.sec`, `mik.kv`, `mik.sys`). In `mik.sys`, runtime subsystems start their keys with `<subsystem>.`, within the 15-character NVS limit.

A module initializes on its first import, not at startup. This keeps boot time and memory use low when a module is compiled in but not used.

### Linker considerations

The registration symbols are in static libraries, so the linker can discard them when nothing else refers to them. `mikrojs_force_include_modules()` adds linker flags (`-u` on GCC/Clang) that keep them:

```cmake
mikrojs_force_include_modules(epaper)
```

## Bytecode builtins

The core runtime's own TypeScript modules (`mikro/fs`, `mikro/result` and so on) are pre-compiled to QuickJS bytecode and embedded in the firmware binary, in a table in `builtins.cpp`. When JavaScript imports `mikro/fs`, the loader finds the matching builtin, deserializes the bytecode with `JS_ReadObject`, and returns the module, with no filesystem lookup.

Driver and board modules do not use this path. They are normal modules, deployed with the app. Only native modules are in the firmware.

### Bytecode pipeline

```
  runtime/fs/fs.ts
           │
           ▼
     esbuild bundle          (1 JS file, externals preserved)
           │
           ▼
     qjsc compile            (bytecode → C uint8_t array)
           │
           ▼
  gen/<module>.h             (#include'd in builtins.cpp, linked into firmware)
```

**esbuild** bundles each TypeScript module into a single JavaScript file. `mikro/*` and `native:*` imports are marked as external since they resolve at runtime inside the firmware.

**qjsc** (the QuickJS bytecode compiler) takes the bundled JS and produces a C header with a `const uint8_t[]` array. It is built from the same QuickJS source as the runtime engine, which guarantees bytecode version compatibility.

## Module resolution at runtime

When JavaScript runs an `import`, the loader tries these sources in order:

1. **Runtime internals**: A `native:` name is looked up in the list that `MIK_REGISTER_MODULE` fills.
2. **Bytecode builtins**: A builtin name, for example `mikro/result`, loads from bytecode in the firmware.
3. **Native modules**: A name that a native module registered, for example `@acme/drivers/sh8601` or an app's own `#sensor`, runs that module's init function.
4. **Filesystem**: A relative path (starting with `.` or `/`) loads from the device filesystem (LittleFS). JSON files load as modules, and `.bjs` files load as bytecode. Other package names resolve through `node_modules`. See [Module System](/internals/module-system).

The loader does not change `native:` names, `mikro/` names, or the names of registered native modules. It resolves relative paths against the folder of the importing module.

## How native modules get into firmware

Installing a package puts nothing in the firmware. The project lists what goes in:

1. The project lists its native modules with `set(MIKROJS_NATIVE_MODULES "@acme/drivers/sh8601")` in its `CMakeLists.txt`, or with the same variable in the environment or `-D`.
2. `project.cmake` runs `mikro-fw inputs`, which resolves each entry with the `native` condition to C or C++ source: a package export, or for a `#` entry, the app's `imports`. The source's folder becomes an ESP-IDF component.
3. ESP-IDF builds each component; the `REQUIRES` in its `CMakeLists.txt` set the include paths and the link order.

`mikro deploy` follows the app's imports to make sure that the device's firmware has every native module that the app needs.

## Key CMake functions

| Function                          | Purpose                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `mikrojs_force_include_modules()` | Add `-u` linker flags so self-registered native modules survive dead-code elimination |
| `mikrojs_generate_bytecode()`     | Run the TS -> esbuild -> qjsc pipeline (core runtime modules)                         |

Both are defined in the CMake module exported by `@mikrojs/native` (`bytecodeCmakePath` from `@mikrojs/native/cmake`).

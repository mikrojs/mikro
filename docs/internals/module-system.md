---
title: Module System
description: How import statements resolve to native modules, bytecode builtins, and filesystem modules
---

# Module System

When JavaScript executes an `import` statement, the module loader checks four sources in priority order. Each source has different registration mechanics and use cases.

## Resolution order

```
 import 'foo'
    │
    ▼
 ┌──────────────────┐
 │ 1. Virtual module │  Registered by host, highest priority
 └────────┬─────────┘
          │ miss
          ▼
 ┌──────────────────┐
 │ 2. Native module  │  C functions, native:* prefix
 └────────┬─────────┘
          │ miss
          ▼
 ┌──────────────────┐
 │ 3. Bytecode       │  Pre-compiled TS, mikro/*
 │    builtin        │
 └────────┬─────────┘
          │ miss
          ▼
 ┌──────────────────┐
 │ 4. Filesystem     │  .bjs, .json, .js files
 └──────────────────┘
```

### 1. Virtual modules

Virtual modules are source strings registered by the host process:

```c
MIK_RegisterVirtualModule(mik_rt, "native:mikro/sleep", js_source_code, source_len);
```

They take precedence over all other sources. The primary use case is the Node.js addon, where virtual modules mock hardware APIs (like `native:mikro/sleep`) on desktop so the TypeScript wrappers can be tested without device hardware.

### 2. Native modules

Native modules are C/C++ functions exposed to JavaScript. They use the `native:` prefix (with underscore) by convention, indicating they are internal and not meant to be imported directly by user code.

Native modules self-register at program startup via GCC/Clang constructor attributes. The `MIK_REGISTER_MODULE` macro creates a descriptor with external linkage and a constructor that links it into a global list:

```c
MIK_REGISTER_MODULE(sleep, "native:mikro/sleep", mik__sleep_init, NULL, NULL);
//                  ^id    ^name                 ^init            ^consume ^destroy
```

On first import, the loader walks the global linked list, finds the matching entry, and calls the init function. The init function creates a `JSModuleDef` and exports C functions:

```c
static JSModuleDef* mik__sleep_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/sleep", mik__sleep_module_init);
    JS_AddModuleExport(ctx, m, "deepSleep");
    JS_AddModuleExport(ctx, m, "lightSleep");
    JS_AddModuleExport(ctx, m, "getWakeupCause");
    return m;
}
```

Modules with async behavior also register loop consumer and destroy functions:

```c
MIK_REGISTER_MODULE(wifi, "native:wifi",
    mik__wifi_init,     // init: called on first import
    mik__wifi_consume,  // consume: called every loop iteration
    mik__wifi_destroy   // destroy: called on runtime teardown
);
```

See [Event Loop: Loop consumers](/internals/event-loop#loop-consumers) for how consume/destroy work.

::: info Why the prefix?
The `native:` prefix marks internal C/C++ modules. User code imports public APIs from `mikro/*` (for example `mikro/sntp`), which are TypeScript wrappers compiled to bytecode builtins around the internal `native:*` modules. A few `mikro/*` modules, such as `mikro/gpio` and `mikro/pwm`, are implemented entirely in C and registered under their public name.
:::

### 3. Bytecode builtins

Bytecode builtins are TypeScript modules pre-compiled to QuickJS bytecode and embedded in the binary.

They are the core runtime's `mikro/*` modules, compiled during the CMake build and stored in a static table in `builtins.cpp`. Packages do not add builtins: their JavaScript deploys with the app.

On import, `mik__load_builtin()` looks the name up in the table. When found, it deserializes the bytecode with `JS_ReadObject()` and evaluates the module. No parsing or compilation happens at runtime, which saves both time and memory on the microcontroller.

### 4. Filesystem modules

If no virtual, native, or builtin module matches, the loader falls back to the filesystem. It tries extensions in order:

1. `.bjs` (pre-compiled bytecode)
2. `.json` / `.bjson` (auto-wrapped in `export default JSON.parse(...)`)
3. `.js` / `.txt` (source code, parsed and compiled at runtime)

File paths are resolved relative to `fs_base_path` (set during runtime creation). On ESP32, this points to the LittleFS partition. On desktop, it points to the project directory.

A deployed app does not import packages by name. The build resolves every package import on the host, the way Node.js resolves ESM, and rewrites it to a relative path: `import 'tiny-font'` deploys as `import '../node_modules/tiny-font/index.js'`. Each package deploys once, at `node_modules/<name>/`. When the app uses more than one version of a package, the version the app's own files import keeps that directory, and the others deploy at `node_modules/<name>@<version>/`.

The loader still resolves bare specifiers (not starting with `.`, `/`, `native:`, or `mikro/`), for code that no build has rewritten: the REPL, and files written on the device. The normalizer parses the package name, walks up from the importing module's directory looking for `node_modules/<package>/package.json`, and reads the entry point from its `exports` field. It matches exact subpath keys with the `import`, `default` and `native` conditions, in that order. A `native` target is C/C++ source, which means that the firmware was not built with that native module. The loader then throws `Cannot import '<name>': this firmware was not built with that native module.` It does not read wildcard patterns or the `imports` field.

The build writes that `package.json` itself. A package at `node_modules/<name>/` gets one that maps the subpaths the app imports to the deployed files. A `<name>@<version>` directory gets none, so it cannot be imported by name.

A preprocessor hook can transform source before compilation. The Node.js addon uses this to strip TypeScript types from `.ts` files.

## Module normalizer

The normalizer runs before the loader and handles two jobs:

1. **Path resolution**: Relative imports (starting with `.` or `..`) are resolved against the importing module's directory. Non-relative names pass through unchanged.

2. **import.meta population**: For each module, the normalizer constructs `import.meta` properties:
   - `url`: Module identifier
   - `main`: Whether this is the entry module
   - `dirname`: Directory portion of the path
   - `basename`: Filename portion
   - `path`: Full resolved path
   - `env`: Reference to the frozen environment object

## The two-layer pattern

Most hardware APIs follow a two-layer pattern:

```
User code
    │
    ▼  import {sntp} from 'mikro/sntp'
┌────────────────────┐
│ mikro/sntp         │  TypeScript wrapper (bytecode builtin)
│ - Type-safe API    │  - Validates arguments
│ - Result types     │  - Maps enums to native values
│ - Error mapping    │  - Returns typed Result<T, SntpError>
└────────┬───────────┘
         │  import {sync} from 'native:mikro/sntp'
         ▼
┌────────────────────┐
│ native:mikro/sntp  │  C module (native)
│ - Direct HW access │  - esp_sntp_init()
│ - Raw results      │  - Returns {ok, value/error}
└────────────────────┘
```

The native layer handles hardware interaction and returns raw result objects. The TypeScript layer provides the public API with proper types, enums, and domain-specific error types. This separation keeps C code minimal and lets the type system catch misuse at compile time.

## Sandbox

Filesystem module resolution is sandboxed. Path normalization resolves `..` segments and prevents traversal outside `fs_root`, so user code on the device cannot read files outside the designated partition.

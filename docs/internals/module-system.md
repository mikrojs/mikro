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
 │ 3. Bytecode       │  Pre-compiled TS, mikro/* and @mikrojs/*
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
MIK_RegisterVirtualModule(mik_rt, "native:pin", js_source_code, source_len);
```

They take precedence over all other sources. The primary use case is the Node.js addon, where virtual modules mock hardware APIs (like `native:pin`) on desktop so the TypeScript wrappers can be tested without device hardware.

### 2. Native modules

Native modules are C/C++ functions exposed to JavaScript. They use the `native:` prefix (with underscore) by convention, indicating they are internal and not meant to be imported directly by user code.

Native modules self-register at program startup via GCC/Clang constructor attributes. The `MIK_REGISTER_MODULE` macro creates a descriptor with external linkage and a constructor that links it into a global list:

```c
MIK_REGISTER_MODULE(pin, "native:pin", mik__pin_init, NULL, NULL);
//                  ^id   ^name       ^init          ^consume ^destroy
```

On first import, the loader walks the global linked list, finds the matching entry, and calls the init function. The init function creates a `JSModuleDef` and exports C functions:

```c
static JSModuleDef* mik__pin_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:pin", mik__pin_module_init);
    JS_AddModuleExport(ctx, m, "pinMode");
    JS_AddModuleExport(ctx, m, "digitalWrite");
    JS_AddModuleExport(ctx, m, "digitalRead");
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
The `native:` prefix marks internal C/C++ modules. User code imports public APIs from `mikro/*` (e.g., `mikro/pin`), which are TypeScript wrappers compiled to bytecode builtins around the internal `native:*` modules.
:::

### 3. Bytecode builtins

Bytecode builtins are TypeScript modules pre-compiled to QuickJS bytecode and embedded in the binary.

Core builtins (the `mikro/*` public API) are compiled during the CMake build and stored in a static table in `builtins.cpp`. External builtins from driver/board packages register via constructors, similar to native modules:

```c
MIK_REGISTER_BUILTIN(pin, "mikro/pin", qjsc_pin, qjsc_pin_size);
//                   ^id   ^name          ^data     ^size
```

On import, `mik__load_builtin()` first checks the core builtin table, then walks the external builtin linked list. When found, it deserializes the bytecode with `JS_ReadObject()` and evaluates the module. No parsing or compilation happens at runtime, which saves both time and memory on the microcontroller.

### 4. Filesystem modules

If no virtual, native, or builtin module matches, the loader falls back to the filesystem. It tries extensions in order:

1. `.bjs` (pre-compiled bytecode)
2. `.json` / `.bjson` (auto-wrapped in `export default JSON.parse(...)`)
3. `.js` / `.txt` (source code, parsed and compiled at runtime)

File paths are resolved relative to `fs_base_path` (set during runtime creation). On ESP32, this points to the LittleFS partition. On desktop, it points to the project directory.

Bare specifiers (not starting with `.`, `/`, `native:`, or `mikro/`) are resolved as npm packages via `node_modules` directory walking. The normalizer parses the package name, walks up from the importing module's directory looking for `node_modules/<package>/package.json`, and resolves the entry point via the `exports` field.

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
    ▼  import {pinMode} from 'mikro/pin'
┌────────────────────┐
│ mikro/pin          │  TypeScript wrapper (bytecode builtin)
│ - Type-safe API    │  - Validates arguments
│ - Result types     │  - Maps enums to native values
│ - Error mapping    │  - Returns typed Result<T, PinError>
└────────┬───────────┘
         │  import * as native from 'native:pin'
         ▼
┌────────────────────┐
│ native:pin           │  C module (native)
│ - Direct HW access │  - gpio_set_direction()
│ - Raw results      │  - Returns {ok, value/error}
└────────────────────┘
```

The native layer handles hardware interaction and returns raw result objects. The TypeScript layer provides the public API with proper types, enums, and domain-specific error types. This separation keeps C code minimal and lets the type system catch misuse at compile time.

## Sandbox

Filesystem module resolution is sandboxed. Path normalization resolves `..` segments and prevents traversal outside `fs_root`. This ensures user code on the device cannot read files outside the designated partition.

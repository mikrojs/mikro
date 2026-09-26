---
name: add-builtin-module
description: Step-by-step guide for adding new built-in JavaScript modules to mikrojs. Use this skill whenever the user wants to add a new JS-level module (not a raw C module), create a higher-level API wrapper around native C bindings, add a new "mikro/xxx" import, or asks about the TypeScript-to-bytecode pipeline, esbuild bundling, qjsc compilation, or how built-in modules are registered.
---

# Adding a Built-in JS Module to mikrojs

Built-in JS modules provide higher-level APIs on top of native C modules. They're written in TypeScript, bundled with esbuild, compiled to bytecode with qjsc, and embedded in the firmware. Users import them as `mikrojs/xxx`.

Builtins are part of the core runtime. Driver and board packages are not builtins: a driver is plain JavaScript that deploys with the app, or a native module compiled into custom firmware (see the `add-driver` skill and `docs/develop/native-modules.md`).

---

## Pipeline Overview

```
TypeScript source (.ts)
  -> esbuild bundle + minify (.js)     [scripts/bundle-runtime.js]
    -> qjsc bytecode compile (.h)      [scripts/compile-bytecode.sh]
      -> #include in builtins.cpp
        -> Available at import("mikro/xxx")
```

The pipeline is driven by the `mikrojs_generate_bytecode()` CMake function, which handles both the bundle and compile steps.

---

## Adding a Core Builtin (`mikrojs/xxx`)

### 1. Create the TypeScript source

Create `packages/@mikrojs/native/runtime/{name}/{name}.ts`:

```typescript
// packages/@mikrojs/native/runtime/example/example.ts
import * as native from 'native:example'
import {type Result, err, ok} from 'mikro/result'

export function read(channel: number): Result<number, {type: 'ReadFailed'}> {
  const result = native.read(channel)
  if (!result.ok) return err({type: 'ReadFailed' as const})
  return ok(result.value)
}
```

**Key rules:**

- Import native bindings from `native:xxx` (internal, not user-facing)
- Import other builtins from `mikrojs/xxx`
- Both `native:*` and `mikrojs/*` are marked external by esbuild
- Keep code minimal; every byte becomes firmware flash

### 2. If needed: create the native C module

Follow the `add-native-module` skill to create the `native:xxx` native module with `MIK_REGISTER_MODULE()`.

### 3. Add to the RUNTIME_MODULES list

**`packages/@mikrojs/native/CMakeLists.txt`** and **`packages/@mikrojs/firmware/components/mikrojs/CMakeLists.txt`** both call `mikrojs_generate_bytecode()` with the module list:

```cmake
mikrojs_generate_bytecode(
    RUNTIME_DIR "${MIK_RUNTIME_DIR}"
    MODULES result fetch i2c neopixel pin pwm rtc sleep spi sntp stdio sys wifi example
    TARGET gen_bytecode
)
```

Add your module name to the `MODULES` list in both files.

### 4. Include in builtins.cpp

**`packages/@mikrojs/native/src/builtins.cpp`** - Add the include and table entry:

```cpp
// Add with the other gen/ includes (alphabetical order)
#include "gen/mikrojs_example.h"

// Add to the builtins[] table (alphabetical order)
static const mik_builtin_t builtins[] = {
    // ...
    {"mikro/example", mikrojs_example_bytecode, mikrojs_example_bytecode_size},
    // ...
    {NULL, NULL, 0},
};
```

### 5. Add type declarations (optional but recommended)

Create type declarations so TypeScript users get autocomplete.

### 6. Build and verify

```bash
pnpm run build:lib     # standalone library (generates bytecode + compiles)
cd esp32 && pn mikro idf build  # ESP-IDF firmware
```

---

## Key Files

| Path                                                    | Role                            |
| ------------------------------------------------------- | ------------------------------- |
| `packages/@mikrojs/native/runtime/*/`                   | Core builtin TypeScript sources |
| `packages/@mikrojs/native/src/builtins.cpp`             | Core builtin table and loader   |
| `packages/@mikrojs/native/cmake/mikrojs_bytecode.cmake` | Bytecode generation function    |
| `packages/@mikrojs/native/scripts/bundle-runtime.js`    | esbuild bundler                 |
| `packages/@mikrojs/native/scripts/compile-bytecode.sh`  | qjsc compiler wrapper           |

---

## Checklist

1. [ ] TypeScript source: `packages/@mikrojs/native/runtime/{name}/{name}.ts`
2. [ ] Native C module if needed (see `add-native-module` skill)
3. [ ] Module added to `MODULES` list in both CMakeLists.txt files
4. [ ] Generated header included in `builtins.cpp`
5. [ ] Table entry added to `builtins[]` array
6. [ ] Type declarations added (optional)

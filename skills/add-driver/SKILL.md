---
name: add-driver
description: Scaffold a mikrojs driver package for a hardware peripheral. Use this skill whenever the user wants to create a native driver for a sensor, display, motor controller, LED strip, or any other hardware peripheral. Also trigger when the user mentions creating a driver package, writing an ESP-IDF component for mikrojs, wrapping a C/C++ hardware library for JavaScript, or asks about the MIK_REGISTER_MODULE / MIK_REGISTER_BUILTIN pattern for external packages. Even if the user just says "I want to add support for [hardware X]", this skill applies.
---

# Create a mikrojs Driver Package

Generate all files for a new driver package that exposes hardware functionality to JavaScript via a native C/C++ module and TypeScript wrapper.

When this skill triggers, gather the required information from the user, then generate all files listed below. The repo's `docs/develop/creating-drivers.md` walks through the file layout and the `MIK_REGISTER_MODULE` / `MIK_REGISTER_BUILTIN` registration pattern; refer to it for the canonical structure. After generating files, guide the user through building and testing.

The example below uses placeholders: `{scope}` is the author's npm scope (e.g. `@my-scope` — never `@mikrojs`, which is reserved for first-party packages), `{name}` is the package/chip name (e.g. `bme280`), and `{module}` is the import subpath (e.g. `sensor`). The package is a single standalone driver, `{scope}/{name}`, importable at `{scope}/{name}/{module}`.

## What you need from the user

1. **npm scope** (e.g. `@my-scope`) — the package publishes under the author's own scope
2. **Package / chip name** (e.g. `bme280`, `st7789`, `drv2605`)
3. **Module subpath** (e.g. `sensor`, `display`) — what app code imports after the package name
4. **Hardware interface** (I2C, SPI, GPIO, UART, etc.)
5. **What the JS API should look like** (e.g. `readTemperature()`, `createDisplay(config)`)

## Package structure to generate

```
{scope}/{name}/
  package.json                    # npm package with exports and cmake
  cmake.js                        # exports componentPath for ESP-IDF build
  tsconfig.json                   # TypeScript config for runtime files
  native/                         # ESP-IDF component directory
    CMakeLists.txt                # idf_component_register + bytecode generation
    idf_component.yml             # ESP-IDF dependencies
    src/
      mik_{name}.cpp              # Native module + MIK_REGISTER_MODULE + MIK_REGISTER_BUILTIN
  src/
    internal.d.ts                 # Type declarations for native:{scope}/{name}/{module}
    {module}/
      {module}.ts                 # JS wrapper (compiled to bytecode)
      types.ts                    # Public TypeScript types (exported to consumers)
```

## Files to generate

### 1. package.json

```json
{
  "name": "{scope}/{name}",
  "version": "0.0.0",
  "description": "{description}",
  "license": "MIT",
  "type": "module",
  "exports": {
    "./{module}": {
      "types": "./src/{module}/types.ts",
      "default": "./src/{module}/{module}.ts"
    },
    "./cmake": "./cmake.js"
  }
}
```

The builtin is resolved by exact subpath, so the package exports `./{module}` (not the package root). The `types` condition prevents `native:*` imports from leaking to TypeScript consumers; the `default` condition is what the bytecode compiler resolves.

### 2. cmake.js

```js
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const componentPath = join(__dirname, 'native')
```

### 3. tsconfig.json

```json
{
  "extends": "../../../tsconfig.json",
  "include": ["./src/**/*.ts"],
  "compilerOptions": {
    "types": [],
    "noEmit": true,
    "moduleDetection": "auto",
    "customConditions": ["development"]
  }
}
```

### 4. idf_component.yml

```yaml
dependencies:
  idf:
    version: '>=5.5.3'
```

### 5. CMakeLists.txt

```cmake
set(_DRIVER_PKG_DIR "${CMAKE_CURRENT_LIST_DIR}/..")
execute_process(
    COMMAND node -e "import {bytecodeCmakePath} from '@mikrojs/native/cmake'; import {cmakePath} from '@mikrojs/quickjs'; process.stdout.write(JSON.stringify({bytecodeCmake: bytecodeCmakePath, quickjsCmake: cmakePath, runtime: '${CMAKE_CURRENT_LIST_DIR}/../src'}))"
    WORKING_DIRECTORY ${_DRIVER_PKG_DIR}
    OUTPUT_VARIABLE _DRIVER_JSON
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(JSON _BYTECODE_CMAKE GET "${_DRIVER_JSON}" "bytecodeCmake")
string(JSON _QUICKJS_CMAKE GET "${_DRIVER_JSON}" "quickjsCmake")
string(JSON _RUNTIME_DIR GET "${_DRIVER_JSON}" "runtime")

include("${_QUICKJS_CMAKE}")

idf_component_register(
    SRCS "src/mik_{name}.cpp"
    INCLUDE_DIRS "src"
    REQUIRES mikrojs
)

# Package namespace. MIK_REGISTER_MODULE / MIK_REGISTER_BUILTIN enforce at build
# time that names are qualified with it (native:{scope}/{name}/<module> and
# {scope}/{name}/<module>), so the package can't claim or shadow another's
# native: name. native:mikro/* is reserved for the core runtime.
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_PACKAGE_NAME=\"{scope}/{name}\"")

include("${_BYTECODE_CMAKE}")
mikrojs_force_include_modules({name})
mikrojs_force_include_builtins({name})
mikrojs_generate_bytecode(
    RUNTIME_DIR "${_RUNTIME_DIR}"
    MODULES {module}
    MODULE_PREFIX "{scope}/{name}"
    SYMBOL_PREFIX "{name}"
    TARGET gen_{module}_bytecode
    WORKING_DIRECTORY "${_DRIVER_PKG_DIR}"
)
add_dependencies(${COMPONENT_LIB} gen_{module}_bytecode)
target_include_directories(${COMPONENT_LIB} PRIVATE "${gen_{module}_bytecode_INCLUDE_DIR}")
```

### 6. Native C++ module (mik\_{name}.cpp)

```cpp
#include "mikro/errors.h"
#include "mikro/mikrojs.h"
#include "mikro/private.h"
#include "mikro/utils.h"

// Generated bytecode header (gen/<SYMBOL_PREFIX>_<module>.h)
#include "gen/{name}_{module}.h"

// ... native function implementations ...

// Module init (called lazily on first import)
JSModuleDef* mik__{name}_mod_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:{scope}/{name}/{module}", mik__{name}_module_init);
    if (!m) return nullptr;
    // JS_AddModuleExport for each export
    return m;
}

MIK_REGISTER_MODULE({name}, "native:{scope}/{name}/{module}", mik__{name}_mod_init, nullptr, nullptr)

MIK_REGISTER_BUILTIN({name}, "{scope}/{name}/{module}",
                      {name}_{module}_bytecode,
                      {name}_{module}_bytecode_size)
```

### 7. TypeScript types (types.ts)

Export all public interfaces and function signatures. This file MUST NOT import from `native:*`. It is what TypeScript consumers see.

### 8. JS wrapper ({module}.ts)

```typescript
import * as native from 'native:{scope}/{name}/{module}'
import {type Result, err, ok} from 'mikro/result'
import type {SomeType} from './types.js'

export type {SomeType} from './types.js'

// Wrap native calls with typed Result returns
```

### 9. internal.d.ts

Ambient type declarations for the `native:{scope}/{name}/{module}` native module. Only used by the driver's own typechecking, NOT exported to consumers.

## Important notes

- The ESP-IDF component directory is named `native/`. Its parent package name determines the logical component identity.
- `mikrojs_force_include_modules()` and `mikrojs_force_include_builtins()` are required. Without them, the linker strips the self-registration constructors from the static library.
- The `types` export condition in package.json prevents `native:*` imports from leaking to TypeScript consumers.
- Use `heap_caps_malloc(size, MALLOC_CAP_DMA)` for DMA-capable buffers (internal SRAM only, limited).
- Vendor C files (`.c`) compile fine, but C++ code including vendor headers may need manual struct initialization instead of vendor macros (due to `-Werror`).

## Testing

1. Add the driver to the firmware's `package.json` dependencies
2. `pnpm install`
3. Build: `cd esp32 && idf.py build`
4. Flash: `idf.py flash monitor`
5. Test from the REPL or deploy a test app

# @mikrojs/quickjs

QuickJS-NG engine wrapper for Mikro.js. Provides the engine source, a shared CMake module, and the `qjsc` bytecode compiler.

## What's included

- **`deps/quickjs/`** - QuickJS-NG source (git submodule)
- **`quickjs.cmake`** - Shared CMake module. Creates a `quickjs` static library target for normal CMake builds; exports source/include variables for ESP-IDF builds.
- **`qjsc`** - Bytecode compiler, built from source at `pnpm install` time via `postinstall.js`.

## JS exports

```js
import {cmakePath, includePath, qjscPath} from '@mikrojs/quickjs'
```

- `cmakePath` - Path to `quickjs.cmake`
- `includePath` - Path to QuickJS header directory
- `qjscPath` - Path to the compiled `qjsc` binary

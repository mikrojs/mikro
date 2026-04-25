---
title: Using npm Packages
description: What works, what doesn't, and why
---

# Using npm Packages

You can use npm packages in your Mikro.js projects. When you build or deploy, the CLI traces your imports and copies everything your code needs to the device, including dependencies from `node_modules`.

```ts
import prettyMs from 'pretty-ms'

console.log(prettyMs(123456)) // "2m 3.5s"
```

This works because `pretty-ms` is a pure JavaScript ESM package with no platform dependencies.

## What works

Packages that meet all of these criteria:

- **ESM**: the package uses ES modules (`"type": "module"` in its `package.json`, or `.mjs` files)
- **Pure JS/TS**: no native addons (C++, Rust, WASM)
- **No Node.js APIs**: doesn't import from `node:fs`, `node:path`, `node:crypto`, or other Node.js built-in modules
- **No browser APIs**: doesn't use `window`, `document`, `DOM`, `Web Workers`, etc.

In practice, this means small utility libraries, parsers, formatters, and similar "platform-agnostic" packages can work, as long as they are no more than a few kilobytes.

For example, [`pretty-ms`](https://www.npmjs.com/package/pretty-ms) works because it's a small, pure JavaScript ESM package with no platform-specific dependencies.

## How it works under the hood

Unlike traditional bundlers (webpack, esbuild), Mikro.js does not bundle your code into a single file. Instead:

1. The CLI traces your import graph starting from your entry file (`app/main.ts`)
2. Every imported file is discovered, including files inside `node_modules`
3. All discovered files are copied to a build directory, preserving the directory structure
4. Files are minified and optionally compiled to QuickJS bytecode
5. The entire build directory is deployed to the device's filesystem

This means each imported npm package adds files to the device's flash storage. The device's ES module loader resolves imports at runtime using the same `package.json` `exports` field that Node.js uses.

## Memory considerations

Every package you import adds to your program's memory footprint. On an ESP32 with 80-150KB of free heap, this matters.

- Prefer small, focused packages over large utility libraries. Many popular npm packages are designed for servers or browsers and are simply too large for a microcontroller.
- Check `memoryUsage()` after importing a package to understand its impact
- When in doubt, vendor the specific function you need instead of pulling in a whole package

## Tips

- **Check the package's `package.json`** for `"type": "module"` before installing. If it's missing, the package is likely CommonJS.
- **Read the package's dependencies.** Even if a package looks pure, it might depend on something that uses Node.js APIs.
- **Test with `mikro sim dev`** before deploying to device. If a package fails in the simulator, it will also fail on device.
- **Consider vendoring small utilities.** If you only need one function from a package, copying that function into your project avoids the overhead of an entire dependency tree.

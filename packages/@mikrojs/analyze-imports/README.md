### Import tracer for Mikro.js builds

`traceImports` follows the imports of an app's entry files. It returns the files
that deploy to the device, the path each one deploys to, and the import
specifiers the build has to replace in it.

```ts
import {readFile} from 'node:fs/promises'

import {applyRewrites, traceImports} from '@mikrojs/analyze-imports'

const {files, externals, duplicatePackages, problems} = await traceImports(['app/main.ts'], {
  deployDir: 'app',
  isExternal: (specifier) => specifier.startsWith('mikro/'),
})

for (const [deployPath, file] of files) {
  const contents =
    'contents' in file
      ? file.contents
      : applyRewrites(await readFile(file.source, 'utf-8'), file.rewrites)
  // write `contents` to `deployPath`
}
```

`traceImports` only reads. It reports what it cannot deploy in `problems`
(an import that does not resolve, a file that does not parse, a CommonJS
package, a file outside the app) and throws only when the file system does.

The result has four fields:

- `files` maps each deploy path to `{source, rewrites}`: the real file to read,
  and the ranges in it to replace. A file the trace generates has `{contents}`.
- `externals` maps each specifier that `isExternal` accepted to `static` or
  `dynamic`. A specifier is `dynamic` when no file imports it statically.
- `duplicatePackages` lists every package name that deploys in more than one
  directory, with the path and version of each copy.
- `problems` is a list of messages. An empty list means the files can deploy.

Entries that are relative paths are relative to the working directory. `root`
(the app directory, by default the working directory) decides which files are
the app's own. Pass `fs` to trace a tree that is not on disk; the tests do.

#### Where files deploy

Imports are resolved on the host the way Node resolves ESM: `exports`,
conditions, wildcard patterns, `#imports`, self-reference, and symlinks. Each
resolved import is then rewritten to a relative path, so the device never looks
a package up by name.

An app file keeps its path. A package deploys once, at `node_modules/<name>/`,
however many paths lead to it. When the app uses several packages with one name
(two versions, usually), the copy that the app's own files import keeps
`node_modules/<name>/`, and each other copy deploys at
`node_modules/<name>@<version>/`.

A package at `node_modules/<name>/` also gets a generated `package.json`. Its
`exports` map the subpaths the app imports to the deployed files, so that the
REPL can `import('<name>')`. A `<name>@<version>` directory gets none, and
cannot be imported by name. A package's own `package.json`
deploys only when something imports it, and then as `_package.json`.

`deployDir` is the directory, relative to `root`, that becomes the root of the
device's file system. A file outside it deploys inside it: with `app`,
`node_modules/a/x.js` deploys at `app/node_modules/a/x.js`.

The tracer is ESM only: no CommonJS, no `main` field, no Node builtins. It began
as a cut-down [@vercel/nft](https://github.com/vercel/nft); the resolver and the
static evaluation of `import()` arguments still come from there.

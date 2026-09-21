### Import tracer for Mikro.js builds

Follows the imports of an app's entry files and says which files deploy to the
device, where, and with which import specifiers replaced.

```ts
import {applyRewrites, traceImports} from '@mikrojs/analyze-imports'

const {files, externals, duplicatePackages, problems} = await traceImports(['app/main.ts'], {
  deployDir: 'app',
  isExternal: (specifier) => specifier.startsWith('mikro/'),
})
```

- **The host resolves, the device loads by path.** Imports are resolved the way
  Node resolves ESM (`exports`, conditions, wildcards, `#imports`,
  self-reference, symlinks). Each resolved import is then rewritten to a
  relative path, so the device never looks a package up by name.
- **One directory per package.** An app file keeps its path. A package deploys
  at `node_modules/<name>/`, or at `node_modules/<name>@<version>/` when the
  app uses more than one.
- **Importable by name only when the name is unambiguous.** A package that is
  the only one with its name gets a generated `package.json` whose `exports`
  map the subpaths the app imports to the deployed files, so the REPL can
  `import('<name>')`. A `<name>@<version>` directory gets none. A package's own
  `package.json` deploys as `_package.json`, and only when it is imported.
- **Nothing is changed or thrown.** `files` maps each deploy path to its source
  and its rewrites (`applyRewrites` applies them), or to generated `contents`. `externals` lists the
  specifiers `isExternal` accepted, with `static` or `dynamic`. What cannot
  deploy is listed in `problems`.
- **Any file system.** Pass `fs` to trace a tree that is not on disk.

ESM only: no CommonJS, no `main` field, no Node builtins. It began as a cut-down
[@vercel/nft](https://github.com/vercel/nft); the resolver and the static
evaluation of `import()` arguments still come from there.

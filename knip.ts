import type {KnipConfig} from 'knip'

const config = {
  workspaces: {
    '.': {},
    'bench-site': {
      // app.ts is the browser entry, bundled by esbuild via build.ts (knip
      // can't see esbuild entrypoints on its own)
      entry: ['src/app.ts'],
      project: ['src/**/*.ts'],
      ignoreDependencies: ['wrangler'],
    },
    docs: {
      ignoreDependencies: ['mikro', 'wrangler'],
    },
    'packages/@mikrojs/firmware': {
      ignoreDependencies: ['@mikrojs/native', '@mikrojs/quickjs', 'esbuild'],
      // resolve.js is invoked by CMake, not imported. The ota_host .build/ tree
      // is scratch the gunzip host test generates (gitignored); knip still walks
      // it once the test has run, so the ignore is only redundant on a clean
      // checkout.
      ignore: ['resolve.js', 'components/mikrojs/test/ota_host/.build/**'],
    },
    'examples/sleep': {
      // Each app/*.ts file is a stand-alone entry — users pick one with
      // `mikro dev app/<name>.ts`. Without this, only `main` from
      // package.json counts as an entry and the rest get flagged as
      // "unused".
      entry: ['app/*.ts'],
    },
    'dev/module-costs': {
      // Every test/*.test.ts is a `mikro test` entry (one per builtin, run on
      // the device or simulator), not imported by anything.
      entry: ['test/*.test.ts'],
    },
    'dev/watchdog': {
      // One entry per watchdog, picked with `pnpm dev:<name>`; same shape as
      // examples/sleep.
      entry: ['app/*.ts'],
    },
    'packages/mikro': {
      entry: ['src/cli/cliWrapper.ts', 'src/cli/cli.ts', 'src/_exports/*.ts'],
      project: ['src/**/*.{ts,tsx}'],
      // @mikrojs/quickjs: native addon resolved at runtime
      // terser, @swc/core: optional minifiers loaded dynamically via importOptional()
      ignoreDependencies: ['@mikrojs/quickjs', 'terser', '@swc/core', 'tsx'],
    },
    'packages/@mikrojs/analyze-imports': {
      ignore: ['test/unit/**', 'test/symlink/**', 'dist/**'],
    },
    'packages/create-mikro': {
      // eslint, prettier, typescript-eslint, @mikrojs/eslint-plugin are
      // invoked by scaffold.test.ts via node_modules/.bin paths (to lint
      // and format-check scaffolded projects), not via JS imports — knip
      // can't see them.
      ignoreDependencies: ['@mikrojs/eslint-plugin', 'eslint', 'prettier', 'typescript-eslint'],
    },
    'packages/@repo/releaser': {
      // bin/releaser.js is auto-detected from package.json bin. The .ts is
      // invoked via tsx from the shim and dispatches to all command modules.
      entry: ['bin/releaser.ts'],
      project: ['src/**/*.ts', 'bin/**/*.ts'],
    },
    scripts: {
      // trust-setup.ts is invoked from the root `trust:setup` script via
      // shebang; knip can't see the entry through the package.json reference.
      entry: ['trust-setup.ts'],
    },
    esp32: {
      // @mikrojs/firmware is consumed by CMakeLists.txt (project.cmake,
      // component discovery), which knip can't see — no JS imports.
      ignoreDependencies: ['@mikrojs/firmware'],
    },
    'packages/@mikrojs/native': {
      // bundle-runtime.js + generate-symbol-map.js are invoked by CMake during
      // the firmware build (see @mikrojs/firmware/components/mikrojs/CMakeLists.txt
      // for the symbol-map invocation), not via JS imports — so knip can't
      // see them and we declare them as entries explicitly. gen-checkin-fixtures.js
      // is the same: CMakeLists.txt runs it for the host test build, and so is
      // gen-schema-fixtures.js.
      entry: [
        'scripts/bundle-runtime.js',
        'scripts/generate-symbol-map.js',
        'scripts/gen-checkin-fixtures.js',
        'scripts/gen-schema-fixtures.js',
      ],
      ignore: ['runtime/**'],
      // node-addon-api, @mikrojs/quickjs: resolved by CMake/node-gyp, not by JS imports
      // terser, @swc/core: optional minifiers loaded dynamically in bundle-runtime.js
      // @mikrojs/schema is imported only by runtime/schema/__test__, which the
      // `ignore` above hides from knip.
      ignoreDependencies: [
        'node-addon-api',
        '@mikrojs/quickjs',
        'terser',
        '@swc/core',
        '@mikrojs/schema',
      ],
    },
    'packages/@mikrojs/schema': {
      // schema.test-d.ts is a vitest typecheck suite, run via typecheck.include
      // in this package's vitest config rather than imported by anything, so
      // knip sees no consumer.
      ignore: ['src/**/*.test-d.ts'],
    },
  },
  ignore: [
    'taze.config.ts',
    'packages/@mikrojs/quickjs/deps/**',
    // todo: ideally we should run knip here too, but not sure how
    'packages/create-mikro/src/templates/**',
    // mikro.config.ts is discovered at runtime by the CLI, not imported
    '**/mikro.config.ts',
    // config schemas are value-imported only by mikro.config.ts (ignored
    // above) and type-imported by app code, so knip sees no consumer
    'examples/*/app/ota.config.ts',
    // sim stubs are loaded dynamically by mikro sim dev, not imported
    '**/*.stub.ts',
  ],
  ignoreDependencies: ['unbarrelify', 'taze'],
  // zizmor and gcovr are installed system-wide (brew/uv/pipx), not via npm.
  // open/xdg-open are OS-provided (macOS/Linux), used by coverage:lib:open.
  // `packages/` is how knip reads the `test:ota-unpack` script, which runs a
  // shell script by path rather than invoking a binary off PATH.
  ignoreBinaries: ['cmake', 'ctest', 'zizmor', 'gcovr', 'open', 'xdg-open', 'packages/'],
  // Knip can't trace `import * as` namespace member access or type-only re-exports
  // through barrel files. All remaining "unused" exports/types have been manually
  // verified as used.
  exclude: ['exports', 'types'],
} satisfies KnipConfig
export default config

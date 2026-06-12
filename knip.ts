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
      ignore: ['resolve.js'],
    },
    'examples/sleep': {
      // Each app/*.ts file is a stand-alone entry — users pick one with
      // `mikro dev app/<name>.ts`. Without this, only `main` from
      // package.json counts as an entry and the rest get flagged as
      // "unused".
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
    'packages/@mikrojs/native': {
      // bundle-runtime.js + generate-symbol-map.js are invoked by CMake during
      // the firmware build (see @mikrojs/firmware/components/mikrojs/CMakeLists.txt
      // for the symbol-map invocation), not via JS imports — so knip can't
      // see them and we declare them as entries explicitly.
      entry: ['scripts/bundle-runtime.js', 'scripts/generate-symbol-map.js'],
      ignore: ['runtime/**'],
      // node-addon-api, @mikrojs/quickjs: resolved by CMake/node-gyp, not by JS imports
      // terser, @swc/core: optional minifiers loaded dynamically in bundle-runtime.js
      ignoreDependencies: ['node-addon-api', '@mikrojs/quickjs', 'terser', '@swc/core'],
    },
  },
  ignore: [
    'taze.config.ts',
    'packages/@mikrojs/quickjs/deps/**',
    // todo: ideally we should run knip here too, but not sure how
    'packages/create-mikro/src/templates/**',
    // mikro.config.ts is discovered at runtime by the CLI, not imported
    '**/mikro.config.ts',
    // sim stubs are loaded dynamically by mikro sim dev, not imported
    '**/*.stub.ts',
  ],
  ignoreDependencies: ['unbarrelify', 'taze'],
  // zizmor is installed system-wide (brew/uv/pipx), not via npm
  ignoreBinaries: ['cmake', 'ctest', 'zizmor'],
  // Knip can't trace `import * as` namespace member access or type-only re-exports
  // through barrel files. All remaining "unused" exports/types have been manually
  // verified as used.
  exclude: ['exports', 'types'],
} satisfies KnipConfig
export default config

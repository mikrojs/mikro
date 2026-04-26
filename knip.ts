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
      ignoreDependencies: ['mikrojs', 'wrangler'],
    },
    'packages/@mikrojs/firmware': {
      ignoreDependencies: ['@mikrojs/native', '@mikrojs/quickjs', 'esbuild'],
      ignore: ['resolve.js'],
    },
    'packages/mikrojs': {
      entry: ['src/cli/cliWrapper.ts', 'src/cli/cli.ts', 'src/_exports/*.ts'],
      project: ['src/**/*.{ts,tsx}'],
      // @mikrojs/quickjs: native addon resolved at runtime
      // terser, @swc/core: optional minifiers loaded dynamically via importOptional()
      ignoreDependencies: ['@mikrojs/quickjs', 'terser', '@swc/core'],
    },
    'packages/@mikrojs/analyze-imports': {
      ignore: ['test/unit/**', 'test/symlink/**', 'dist/**'],
    },
    'packages/@repo/releaser': {
      // bin/releaser.js is auto-detected from package.json bin. The .ts is
      // invoked via tsx from the shim and dispatches to all command modules.
      // conventional-changelog-conventionalcommits is the preset loaded
      // dynamically by conventional-recommended-bump.
      entry: ['bin/releaser.ts'],
      project: ['src/**/*.ts', 'bin/**/*.ts'],
      ignoreDependencies: ['conventional-changelog-conventionalcommits'],
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
    'packages/create-mikrojs/src/templates/**',
    // mikro.config.ts is discovered at runtime by the CLI, not imported
    '**/mikro.config.ts',
    // sim stubs are loaded dynamically by mikro sim dev, not imported
    '**/*.stub.ts',
  ],
  ignoreDependencies: ['unbarrelify', 'taze'],
  ignoreBinaries: ['cmake', 'ctest'],
  // Knip can't trace `import * as` namespace member access or type-only re-exports
  // through barrel files. All remaining "unused" exports/types have been manually
  // verified as used.
  exclude: ['exports', 'types'],
} satisfies KnipConfig
export default config

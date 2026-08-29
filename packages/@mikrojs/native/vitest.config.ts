import path from 'node:path'

import {defineConfig} from 'vitest/config'

export default defineConfig({
  resolve: {
    /* Order matters — more specific aliases must come before broader ones,
     * otherwise vite matches the broader alias first and fails to resolve
     * sub-paths. */
    alias: [
      {
        find: 'mikro/observable/operators',
        replacement: path.resolve(import.meta.dirname, 'runtime/observable/operators.ts'),
      },
      {
        find: 'mikro/observable',
        replacement: path.resolve(import.meta.dirname, 'runtime/observable/observable.ts'),
      },
      {
        find: 'mikro/result',
        replacement: path.resolve(import.meta.dirname, 'runtime/result/result.ts'),
      },
      {
        find: 'mikro/schema',
        replacement: path.resolve(import.meta.dirname, 'runtime/schema/schema.ts'),
      },
      {
        find: 'mikro/http/helpers',
        replacement: path.resolve(import.meta.dirname, 'runtime/http/helpers.ts'),
      },
      {
        /* The host implementation of the same DSL. Not a shim written for the
         * tests: core.ts is what the CLI and the registry run, and the
         * conformance fixtures are what keep it and mik_schema.cpp together. */
        find: 'native:mikro/schema',
        replacement: path.resolve(import.meta.dirname, '../schema/src/core.ts'),
      },
      {
        find: 'native:mikro/result',
        replacement: path.resolve(import.meta.dirname, 'runtime/result/native-result.node-shim.ts'),
      },
      {
        find: 'native:mikro/observable',
        replacement: path.resolve(
          import.meta.dirname,
          'runtime/observable/native-observable.node-shim.ts',
        ),
      },
    ],
  },
  test: {
    include: ['addon/**/*.test.ts', 'src/**/*.test.ts', 'runtime/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['runtime/**/*.test-d.ts'],
    },
  },
})

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
        find: 'mikro/http/helpers',
        replacement: path.resolve(import.meta.dirname, 'runtime/http/helpers.ts'),
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

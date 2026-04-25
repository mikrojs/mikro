import path from 'node:path'

import {defineConfig} from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'mikrojs/result': path.resolve(import.meta.dirname, 'runtime/result/result.ts'),
      'mikrojs/http/helpers': path.resolve(import.meta.dirname, 'runtime/http/helpers.ts'),
      'native:result': path.resolve(
        import.meta.dirname,
        'runtime/result/native-result.node-shim.ts',
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'runtime/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['runtime/**/*.test-d.ts'],
    },
  },
})

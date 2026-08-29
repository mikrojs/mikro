import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The scaffold tests shell out to tsc, eslint and prettier per template,
    // which is far past vitest's 5s default on a loaded machine.
    testTimeout: 60_000,
  },
})

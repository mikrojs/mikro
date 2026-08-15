import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Scaffold tests shell out to pnpm/tsc/eslint/prettier, which can exceed
    // the 5s default on a loaded machine.
    testTimeout: 60_000,
  },
})

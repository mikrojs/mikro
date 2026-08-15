import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The first type-aware RuleTester case pays the whole projectService + TS
    // program startup, which can exceed the 5s default on a loaded machine.
    testTimeout: 30_000,
  },
})

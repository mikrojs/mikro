import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The first type-aware RuleTester case pays the whole typescript-eslint
    // projectService and TS program cold start, which alone can outlast
    // vitest's 5s default when the machine is busy (the agent pre-commit hook
    // runs test-js alongside build-cpp).
    testTimeout: 30_000,
  },
})

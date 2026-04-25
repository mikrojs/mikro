import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/mikrojs/vitest.config.ts',
      'packages/@mikrojs/analyze-imports/vitest.config.ts',
      'packages/@mikrojs/eslint-plugin/vitest.config.ts',
      'packages/@mikrojs/native/vitest.config.ts',
      'packages/create-mikrojs/vitest.config.ts',
    ],
  },
})

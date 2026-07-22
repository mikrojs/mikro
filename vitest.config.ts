import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/mikro/vitest.config.ts',
      'packages/@mikrojs/analyze-imports/vitest.config.ts',
      'packages/@mikrojs/eslint-plugin/vitest.config.ts',
      'packages/@mikrojs/firmware/vitest.config.ts',
      'packages/@mikrojs/native/vitest.config.ts',
      'packages/@mikrojs/registry/vitest.config.ts',
      'packages/@repo/releaser/vitest.config.ts',
      'packages/create-mikro/vitest.config.ts',
    ],
  },
})

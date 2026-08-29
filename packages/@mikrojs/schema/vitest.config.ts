import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/__test__/**/*.test.ts'],
    typecheck: {
      enabled: true,
      include: ['src/**/__test__/**/*.test-d.ts'],
    },
  },
})

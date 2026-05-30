import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    //setupFiles: ['./app/platforms/node/install.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})

import {defineConfig} from 'vitest/config'

// Only the drift guard. The census files under test/ are `mikro test` files
// and must not run under vitest, hence the .spec.ts suffix here.
export default defineConfig({
  test: {
    include: ['scripts/**/*.spec.ts'],
  },
})

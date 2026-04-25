import {defineConfig} from 'mikrojs'

export default defineConfig({
  memReserved: 8 * 1024,
  build: {
    minifier: 'swc',
    minifyLevel: 'max',
  },
})

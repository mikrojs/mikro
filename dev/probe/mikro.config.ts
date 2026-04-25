import {defineConfig} from 'mikrojs'

// `bundle: false` is required: the probe dynamic-imports each builtin one
// at a time to measure per-module retention. With bundling on, everything
// ends up in a single bytecode blob at build time and the deltas collapse.
export default defineConfig({
  build: {
    bundle: false,
  },
})

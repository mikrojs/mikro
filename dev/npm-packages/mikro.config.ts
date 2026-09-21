import {defineConfig} from 'mikro'

export default defineConfig({
  // The app reports through console.log; the deploy default of 'warn' would
  // strip those lines from the build.
  build: {logLevel: 'debug'},
})

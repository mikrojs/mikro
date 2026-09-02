import {defineConfig} from 'mikro'

// Short limits so each watchdog fires within seconds of deploy. The 1 s floor
// in the runtime is the only thing stopping these from going lower.
export default defineConfig({
  logFile: true,
  // The entries report through console.log; the deploy default of 'warn'
  // would strip those lines from the build.
  build: {logLevel: 'debug'},
  watchdog: {blocking: 5_000, feed: 5_000, awake: 30_000},
  onPanic: {mode: 'restart', delay: 1000},
})

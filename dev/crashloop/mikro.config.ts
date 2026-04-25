import {defineConfig} from 'mikrojs'

// Auto-restart on uncaught exceptions with a short delay. Combined with the
// deliberate throw in app/main.ts, this puts the device into a tight crash
// loop where a normal `mikro dev` or `mikro clean` can't land a command
// between reboots. Only `mikro ... --recover` can break out.
export default defineConfig({
  restartOnUncaughtException: true,
  restartDelay: 500,
})

import {defineConfig} from 'mikrojs'

// Combined with the deliberate throw in app/main.ts, the short panic-restart
// grace window puts the device into a tight crash loop where a normal
// `mikro dev` or `mikro clean` can't land a command between reboots. Only
// `mikro ... --recover` can break out.
export default defineConfig({
  panicRestartDelay: 2000,
  logFile: {maxSize: 1024},
})

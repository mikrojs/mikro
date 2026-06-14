import {defineConfig} from 'mikro'

export default defineConfig({
  logFile: true,
  wifi: {country: 'NO'},
  onPanic: {
    mode: 'restart',
    delay: 10_000,
  },
})

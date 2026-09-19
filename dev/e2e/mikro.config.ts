import {defineConfig} from 'mikro'

export default defineConfig({
  // The suite covers the full feature set, and loads the gated modules with
  // import() so a skipped suite never loads them. Listing them here makes
  // `mikro test` refuse firmware that lacks one instead of failing mid-run.
  features: ['wifi', 'ble', 'i2s'],
  wifi: {country: 'NO'},
  // Exercised by test/logfile.test.ts; also means every suite run soaks
  // the file-logger tap under real console traffic. flush: 'line' so the
  // test can probe with console.log instead of error-level output (which
  // renders red in the suite).
  logFile: {flush: 'line'},
})

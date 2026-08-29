import {defineConfig} from 'mikro'

export default defineConfig({
  wifi: {country: 'NO'},
  // Exercised by test/logfile.test.ts; also means every suite run soaks
  // the file-logger tap under real console traffic. flush: 'line' so the
  // test can probe with console.log instead of error-level output (which
  // renders red in the suite).
  logFile: {flush: 'line'},
})

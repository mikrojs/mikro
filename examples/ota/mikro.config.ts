import {defineConfig} from 'mikro'

import {ConfigSchema} from './app/ota.config.js'

export default defineConfig({
  wifi: {country: 'NO'},
  logFile: true,
  otaConfigSchema: ConfigSchema,
})

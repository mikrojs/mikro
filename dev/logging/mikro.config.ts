import {defineConfig} from 'mikro'

export default defineConfig({
  logFile: {
    maxSize: '8k',
  },
})

import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Path to the ESP-IDF component directory */
export const componentPath = join(__dirname, 'native')

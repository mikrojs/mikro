import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Path to quickjs.cmake shared module */
export const cmakePath = join(__dirname, 'quickjs.cmake')

/** Path to QuickJS include directory */
export const includePath = join(__dirname, 'deps', 'quickjs')

/** Path to the qjsc bytecode compiler binary */
export const qjscPath = join(__dirname, 'bin', 'qjsc')

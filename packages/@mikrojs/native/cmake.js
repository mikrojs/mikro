import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Path to the main CMakeLists.txt */
export const cmakePath = join(__dirname, 'CMakeLists.txt')

/** Path to the public include directory */
export const includePath = join(__dirname, 'include')

/** Path to the C++ source directory */
export const srcPath = join(__dirname, 'src')

/** Path to the build scripts directory */
export const scriptsPath = join(__dirname, 'scripts')

/** Path to the runtime TypeScript modules directory */
export const runtimePath = join(__dirname, 'runtime')

/** Path to the reusable bytecode generation CMake module */
export const bytecodeCmakePath = join(__dirname, 'cmake', 'mikrojs_bytecode.cmake')

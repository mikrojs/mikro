import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// EXTRA_COMPONENT_DIRS expects directories containing component subdirectories.
// ESP-IDF scans this and finds the mikrojs/ subdirectory as a component.
export const componentDir = join(__dirname, 'components')
export const projectCmakePath = join(__dirname, 'project.cmake')

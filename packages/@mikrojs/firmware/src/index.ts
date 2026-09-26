import {readFileSync} from 'node:fs'
import {join} from 'node:path'

/** The package root: src/ or dist/ is one level down. */
const packageRoot = join(import.meta.dirname, '..')

/** Chips the firmware supports, from chips.json (e.g. "esp32c6"). */
export const chips: string[] = (
  JSON.parse(readFileSync(join(packageRoot, 'chips.json'), 'utf8')) as {chips: string[]}
).chips

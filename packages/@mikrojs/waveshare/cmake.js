import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))

/** Component paths for each board declared in mikrojs.boards */
export const componentPaths = Object.keys(pkg.mikrojs?.boards ?? {}).map((subpath) => {
  const name = subpath.startsWith('./') ? subpath.slice(2) : subpath
  return join(__dirname, 'boards', name)
})

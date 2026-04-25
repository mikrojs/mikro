import {spawn} from 'node:child_process'
import {watch} from 'node:fs'
import {resolve} from 'node:path'

const ROOT = import.meta.dirname

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function debounce(fn: (trigger: string) => void, ms: number): (trigger: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (trigger: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(trigger), ms)
  }
}

// -- tsc watch ----------------------------------------------------------------
spawn('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {...process.env, FORCE_COLOR: '1'},
})

// -- Native addon rebuild on C++/runtime changes -----------------------------
const scheduleRebuild = debounce((trigger: string) => {
  // eslint-disable-next-line no-console
  console.log(`${DIM}Native addon rebuild triggered by: ${trigger}${RESET}`)
  const proc = spawn('pnpm', ['exec', 'cmake-js', 'compile', '--directory', 'addon'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {...process.env, FORCE_COLOR: '1'},
  })
  proc.on('exit', (code) => {
    if (code === 0) {
      // eslint-disable-next-line no-console
      console.log(`${BOLD}\x1b[32mNative addon rebuilt${RESET}`)
    }
  })
}, 500)

const isCpp = (f: string) => /\.(cpp|c|h|hpp)$/.test(f) && !f.includes('build/')
const isRuntimeTs = (f: string) => /\.ts$/.test(f) && !f.endsWith('.d.ts')

function watchDir(dir: string, filter: (filename: string) => boolean): void {
  watch(dir, {recursive: true}, (_event, filename) => {
    if (filename && filter(filename)) {
      scheduleRebuild(filename)
    }
  })
}

watchDir(resolve(ROOT, 'src'), isCpp)
watchDir(resolve(ROOT, 'include'), isCpp)
watchDir(resolve(ROOT, 'addon'), isCpp)
watchDir(resolve(ROOT, 'runtime'), isRuntimeTs)

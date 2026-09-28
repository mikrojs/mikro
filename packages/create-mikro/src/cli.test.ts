import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const tsx = import.meta.resolve('tsx/esm')

// Runs create-mikro the way a script does: stdin is not a terminal, so
// nothing can be asked.
describe('without a terminal', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'create-mikro-test-cli-'))
  })

  afterEach(() => {
    rmSync(cwd, {recursive: true, force: true})
  })

  function create(...argv: string[]) {
    const result = spawnSync(
      process.execPath,
      [`--import=${tsx}`, path.join(__dirname, 'index.ts'), ...argv],
      {cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']},
    )
    return {status: result.status, output: result.stdout + result.stderr}
  }
  const pkg = (dir: string) =>
    JSON.parse(readFileSync(path.join(cwd, dir, 'package.json'), 'utf-8'))

  it('takes every answer as an argument or a flag', () => {
    expect(create('my-app', '--template', 'blinky').status).toBe(0)
    expect(pkg('my-app').name).toBe('my-app')
    expect(create('board', '-t', 'blank').status).toBe(0)
    expect(pkg('board').main).toBe('./app/main.ts')
    const board = create('@acme/devboard', '--board', '--chip', 'esp32s3')
    expect(board.status).toBe(0)
    expect(pkg('@acme/devboard').name).toBe('@acme/devboard')
    expect(readFileSync(path.join(cwd, '@acme/devboard/boards.config.ts'), 'utf-8')).toContain(
      "chip: 'esp32s3'",
    )
  })

  it('names the package after the folder, as create-vite does', () => {
    expect(create('acme/devboard', '--board', '--chip', 'esp32c6').status).toBe(0)
    expect(pkg('acme/devboard').name).toBe('devboard')
    const spaced = create('My App', '-t', 'blank')
    expect(spaced.status).toBe(0)
    expect(spaced.output).toContain('Using "my-app" as the package name.')
    expect(spaced.output).toContain("cd 'My App'")
    expect(pkg('My App').name).toBe('my-app')
    const scoped = create('@Acme/devboard', '--board', '--chip', 'esp32c6')
    expect(scoped.output).toContain('Using "@acme/devboard" as the package name.')
    expect(pkg('@Acme/devboard').name).toBe('@acme/devboard')
    expect(create("it's", '-t', 'blank').output).toContain("cd 'it'\\''s'")
  })

  it('stops when a name has nothing a package name can use', () => {
    const result = create('项目', '-t', 'blank')
    expect(result.status).toBe(1)
    expect(result.output).toContain('"项目" can\'t be turned into a valid package name.')
  })

  it('refuses a path with spaces for what ESP-IDF builds', () => {
    for (const argv of [
      ['My Board', '--board', '--chip', 'esp32c6'],
      // Refused before the chip is asked for
      ['My Board', '--board'],
      ['My App', '-t', 'blank', '--firmware', '--chip', 'esp32c6'],
    ]) {
      const result = create(...argv)
      expect(result.status, argv.join(' ')).toBe(1)
      expect(result.output).toContain("ESP-IDF can't build in a path with spaces")
    }
    expect(existsSync(path.join(cwd, 'My Board'))).toBe(false)
  })

  it('creates a firmware project for the chip given', () => {
    const result = create('my-app', '-t', 'blank', '--firmware', '--chip', 'esp32s3')
    expect(result.status).toBe(0)
    expect(pkg('my-app').dependencies['@mikrojs/firmware']).toBeDefined()
  })

  it('stops, rather than wait for an answer, when one is missing', () => {
    const cases = [
      [['-t', 'blank'], 'No project name given. Pass it as an argument.'],
      [['my-app'], 'No template given. Pass it with --template.'],
      // An unset variable in a script: `-t "$TEMPLATE"`
      [['my-app', '-t', ''], 'Unknown template ""'],
      [['my-board', '--board', '--chip', ''], 'Unknown chip ""'],
      [['', '--board', '--chip', 'esp32c6'], 'No project name given'],
      [['my-app', '-t', 'blank', '--firmware'], 'No chip given. Pass it with --chip.'],
      [['--board', '--chip', 'esp32c6'], 'No project name given'],
      [['my-board', '--board'], 'No chip given. Pass it with --chip.'],
    ] as const
    for (const [argv, message] of cases) {
      const result = create(...argv)
      expect(result.status, argv.join(' ')).toBe(1)
      expect(result.output).toContain(message)
    }
    expect(existsSync(path.join(cwd, 'my-app'))).toBe(false)
    expect(existsSync(path.join(cwd, 'my-board'))).toBe(false)
  })

  it('keeps app options out of a board package', () => {
    for (const option of [['-t', 'blank'], ['--firmware']]) {
      const result = create('my-board', '--board', '--chip', 'esp32c6', ...option)
      expect(result.status).toBe(1)
      expect(result.output).toContain('--board takes no --template or --firmware')
    }
    expect(existsSync(path.join(cwd, 'my-board'))).toBe(false)
  })
})

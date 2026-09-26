import {execFileSync} from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const agent = vi.hoisted(() => ({mode: false}))
vi.mock('../../lib/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agent.js')>()),
  isAgentMode: () => agent.mode,
}))

const {run} = await import('../fw/pack.js')

/* `mikro fw pack` against a fake idf.py that writes a finished build into -B. */

const root = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'mikro-fw-pack-')))

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** What ESP-IDF leaves in the build directory, as far as packing goes. */
const template = pathlib.join(root, 'template')
write(
  pathlib.join(template, 'flasher_args.json'),
  JSON.stringify({
    flash_files: {
      '0x0': 'bootloader/bootloader.bin',
      '0x8000': 'partition_table/partition-table.bin',
      '0x10000': 'my-firmware.bin',
    },
    flash_settings: {flash_mode: 'dio', flash_size: '4MB', flash_freq: '80m'},
    extra_esptool_args: {after: 'hard-reset', before: 'default-reset', chip: 'esp32c6'},
  }),
)
write(pathlib.join(template, 'bootloader', 'bootloader.bin'), 'bootloader')
write(pathlib.join(template, 'partition_table', 'partition-table.bin'), 'partitions')
write(pathlib.join(template, 'my-firmware.bin'), 'app')
write(pathlib.join(template, 'my-firmware.elf'), 'not flashed')

/** A fake idf.py: exits with $FAKE_IDF_EXIT if set, else copies the template into -B. */
const idfDir = pathlib.join(root, 'idf')
write(
  pathlib.join(idfDir, 'idf.py'),
  [
    '#!/bin/sh',
    'while [ $# -gt 0 ]; do [ "$1" = -B ] && dir="$2"; shift; done',
    '[ -n "$FAKE_IDF_EXIT" ] && exit "$FAKE_IDF_EXIT"',
    `mkdir -p "$dir" && cp -R "${template}/." "$dir"`,
    '',
  ].join('\n'),
)
chmodSync(pathlib.join(idfDir, 'idf.py'), 0o755)

const app = pathlib.join(root, 'app')
write(pathlib.join(app, 'package.json'), '{}')

const originalCwd = process.cwd()

beforeEach(() => {
  vi.stubEnv('PATH', [idfDir, '/usr/bin', '/bin'].join(':'))
  process.chdir(app)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  agent.mode = false
  process.chdir(originalCwd)
  rmSync(pathlib.join(app, '.mikro'), {recursive: true, force: true})
  rmSync(pathlib.join(app, 'mikrojs-firmware-esp32c6.tar.gz'), {force: true})
})

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
})

function entries(tarball: string): string[] {
  return execFileSync('tar', ['-tzf', tarball], {encoding: 'utf8'}).trim().split('\n').sort()
}

describe('mikro fw pack', () => {
  it('builds into .mikro/build-fw and packs flasher_args.json with the files it flashes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined})

    expect(existsSync(pathlib.join(app, '.mikro', 'build-fw', 'flasher_args.json'))).toBe(true)
    expect(entries(pathlib.join(app, 'mikrojs-firmware-esp32c6.tar.gz'))).toEqual([
      'bootloader/bootloader.bin',
      'flasher_args.json',
      'my-firmware.bin',
      'partition_table/partition-table.bin',
    ])
    expect(log).toHaveBeenCalledWith('Packed firmware for esp32c6')
  })

  it('writes to --out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = pathlib.join(root, 'custom.tar.gz')

    await run({subcommand: 'pack', out})

    expect(entries(out)).toContain('my-firmware.bin')
    expect(existsSync(pathlib.join(app, 'mikrojs-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it("stops with idf.py's exit code when the build fails", async () => {
    vi.stubEnv('FAKE_IDF_EXIT', '2')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await run({subcommand: 'pack', out: undefined})

    // idf.py has printed the failure; a second line would repeat it.
    expect(error).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(2)
    expect(existsSync(pathlib.join(app, 'mikrojs-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it('prints only the result on stdout in agent mode', async () => {
    agent.mode = true
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await run({subcommand: 'pack', out: undefined})

    const lines = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)))
    expect(lines).toEqual([
      expect.objectContaining({
        type: 'result',
        command: 'fw pack',
        result: expect.objectContaining({chip: 'esp32c6'}),
      }),
    ])
  })
})

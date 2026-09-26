import {execFileSync} from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import pkg from 'mikro/package.json' with {type: 'json'}
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const agent = vi.hoisted(() => ({mode: false}))
vi.mock('../../lib/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agent.js')>()),
  isAgentMode: () => agent.mode,
}))

const {run} = await import('../fw/pack.js')
const {run: runPrepack} = await import('../fw/prepack.js')
const {run: runCheck} = await import('../fw/check.js')

/* `mikro fw pack`, `prepack` and `check` against a fake idf.py that writes a
 * finished build into -B. */

const root = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'mikro-fw-pack-')))

function write(file: string, content: string) {
  mkdirSync(pathlib.dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** What ESP-IDF and the mikrojs component leave in the build directory, as far
 *  as packing goes. */
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

/** A fake idf.py: exits with $FAKE_IDF_EXIT if set, else copies the template
 *  into -B and writes the firmware.json the component writes, named
 *  $FAKE_IDF_NAME (none when empty). */
const idfDir = pathlib.join(root, 'idf')
write(
  pathlib.join(idfDir, 'idf.py'),
  [
    '#!/bin/sh',
    'while [ $# -gt 0 ]; do [ "$1" = -B ] && dir="$2"; shift; done',
    '[ -n "$FAKE_IDF_EXIT" ] && exit "$FAKE_IDF_EXIT"',
    `mkdir -p "$dir" && cp -R "${template}/." "$dir"`,
    'if [ -n "$FAKE_IDF_NAME" ]; then name="\\"name\\": \\"$FAKE_IDF_NAME\\", "; fi',
    `printf '{%s"chip": "esp32c6", "version": "${pkg.version}"}\\n' "$name" > "$dir/firmware.json"`,
    'exit 0',
    '',
  ].join('\n'),
)
chmodSync(pathlib.join(idfDir, 'idf.py'), 0o755)

const app = pathlib.join(root, 'app')
write(pathlib.join(app, 'package.json'), '{"name": "my-firmware"}')

/** A single-board package whose root is its firmware project. */
const board = pathlib.join(root, 'devboard')
write(
  pathlib.join(board, 'package.json'),
  JSON.stringify({
    name: '@acme/devboard',
    files: ['dist-fw'],
    exports: {'.': {firmware: './dist-fw/firmware.json'}},
  }),
)
write(pathlib.join(board, 'CMakeLists.txt'), '')

const originalCwd = process.cwd()

beforeEach(() => {
  vi.stubEnv('PATH', [idfDir, '/usr/bin', '/bin'].join(':'))
  vi.stubEnv('FAKE_IDF_NAME', 'my-firmware')
  process.chdir(app)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  agent.mode = false
  process.chdir(originalCwd)
  for (const dir of [app, board]) {
    for (const file of ['.mikro', 'dist-fw'])
      rmSync(pathlib.join(dir, file), {recursive: true, force: true})
    for (const name of ['esp32c6', 'my-firmware-esp32c6', 'acme-devboard-esp32c6']) {
      rmSync(pathlib.join(dir, `mikro-fw-${name}.tar.gz`), {force: true})
    }
  }
})

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
})

function entries(tarball: string): string[] {
  return execFileSync('tar', ['-tzf', tarball], {encoding: 'utf8'}).trim().split('\n').sort()
}

const IMAGE = [
  'bootloader/bootloader.bin',
  'firmware.json',
  'flasher_args.json',
  'my-firmware.bin',
  'partition_table/partition-table.bin',
]

describe('mikro fw pack', () => {
  it('builds into .mikro/build-fw and packs the image, named after the firmware and chip', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined})

    expect(existsSync(pathlib.join(app, '.mikro', 'build-fw', 'flasher_args.json'))).toBe(true)
    // The name `mikro flash --from` looks for
    expect(entries(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for my-firmware')
  })

  it('names firmware without a name after its chip', async () => {
    vi.stubEnv('FAKE_IDF_NAME', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined})

    expect(entries(pathlib.join(app, 'mikro-fw-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for esp32c6')
  })

  it("packs a board's image as fw prepack writes it", async () => {
    vi.stubEnv('FAKE_IDF_NAME', '@acme/devboard')
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined})

    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(existsSync(pathlib.join(board, 'dist-fw', 'my-firmware.bin'))).toBe(true)
  })

  it('writes to --out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = pathlib.join(root, 'custom.tar.gz')

    await run({subcommand: 'pack', out})

    expect(entries(out)).toContain('my-firmware.bin')
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
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
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
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
        result: expect.objectContaining({chip: 'esp32c6', name: 'my-firmware'}),
      }),
    ])
  })
})

describe('mikro fw prepack', () => {
  it('writes the image where the package export points, and checks it', async () => {
    vi.stubEnv('FAKE_IDF_NAME', '@acme/devboard')
    process.chdir(board)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runPrepack({subcommand: 'prepack'})

    expect(
      JSON.parse(readFileSync(pathlib.join(board, 'dist-fw', 'firmware.json'), 'utf8')),
    ).toMatchObject({name: '@acme/devboard', chip: 'esp32c6'})
    for (const file of IMAGE) expect(existsSync(pathlib.join(board, 'dist-fw', file))).toBe(true)
    // Only what flashing needs: no .elf, no build tree
    expect(existsSync(pathlib.join(board, 'dist-fw', 'my-firmware.elf'))).toBe(false)
    expect(log).toHaveBeenCalledWith('Wrote the image of @acme/devboard (esp32c6) to dist-fw')
  })

  it('names the export to add when the package has none for the project', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runPrepack({subcommand: 'prepack'})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `"firmware" condition for the image of ${app}. Add one to "exports", for example:\n  ".": {"firmware": "./dist-fw/firmware.json"}`,
      ),
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('replaces only a folder of its own', async () => {
    vi.stubEnv('FAKE_IDF_NAME', '@acme/devboard')
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const pkg = JSON.parse(readFileSync(pathlib.join(board, 'package.json'), 'utf8'))
    try {
      // Pointing at the build output would delete the build it copies from
      pkg.exports = {'.': {firmware: './.mikro/build-fw/firmware.json'}}
      writeFileSync(pathlib.join(board, 'package.json'), JSON.stringify(pkg))
      await runPrepack({subcommand: 'prepack'})
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('holds more than the image'))

      // A folder with other files in it is not replaced
      pkg.exports = {'.': {firmware: './dist/firmware.json'}}
      writeFileSync(pathlib.join(board, 'package.json'), JSON.stringify(pkg))
      write(pathlib.join(board, 'dist', 'index.js'), 'export {}\n')
      await runPrepack({subcommand: 'prepack'})
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('holds files that are not an image'),
      )
      expect(existsSync(pathlib.join(board, 'dist', 'index.js'))).toBe(true)

      // Nor one with another firmware project's image in it
      pkg.exports = {'.': {firmware: './dist-fw/firmware.json'}}
      writeFileSync(pathlib.join(board, 'package.json'), JSON.stringify(pkg))
      write(pathlib.join(board, 'dist-fw', 't-display', 'firmware.json'), '{}')
      await runPrepack({subcommand: 'prepack'})
      expect(error).toHaveBeenLastCalledWith(
        expect.stringContaining('holds the images of other firmware projects (t-display)'),
      )
      expect(existsSync(pathlib.join(board, 'dist-fw', 't-display', 'firmware.json'))).toBe(true)
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      pkg.exports = {'.': {firmware: './dist-fw/firmware.json'}}
      writeFileSync(pathlib.join(board, 'package.json'), JSON.stringify(pkg))
      rmSync(pathlib.join(board, 'dist'), {recursive: true, force: true})
    }
  })

  it('refuses an image that would not flash under its name', async () => {
    // The build gives the firmware no name (no MIKROJS_BOARD_NAME, no package name)
    vi.stubEnv('FAKE_IDF_NAME', '')
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runPrepack({subcommand: 'prepack'})

    expect(error).toHaveBeenCalledWith(expect.stringContaining('(name): missing required field'))
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('mikro fw check', () => {
  it("lists a package's boards when nothing is wrong", async () => {
    vi.stubEnv('FAKE_IDF_NAME', '@acme/devboard')
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runPrepack({subcommand: 'prepack'})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    runCheck({subcommand: 'check'})

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/@acme\/devboard: @acme\/devboard \(esp32c6, .*\) in dist-fw$/),
    )
    expect(exit).not.toHaveBeenCalled()
  })

  it('fails on an image that is not built', async () => {
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/@acme\/devboard: not built: /))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails on a package that declares no board', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('has no export with a "firmware" condition'),
    )
    expect(exit).toHaveBeenCalledWith(1)
  })
})

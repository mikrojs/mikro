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

/** A fake idf.py: logs its arguments to $FAKE_IDF_LOG, exits with
 *  $FAKE_IDF_EXIT if set, else copies the template into -B and writes the
 *  firmware.json the component writes, named by -DMIKROJS_BOARD_NAME, else by
 *  set(MIKROJS_BOARD_NAME) in the -C project, else $FAKE_IDF_NAME (none when
 *  empty, or with $FAKE_IDF_NONAME). */
const idfDir = pathlib.join(root, 'idf')
write(
  pathlib.join(idfDir, 'idf.py'),
  [
    '#!/bin/sh',
    '[ -n "$FAKE_IDF_LOG" ] && printf "%s\\n" "$*" >> "$FAKE_IDF_LOG"',
    'name="$FAKE_IDF_NAME"',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -B) dir="$2" ;;',
    '    -C) project="$2" ;;',
    '    -DMIKROJS_BOARD_NAME=*) given="${1#-DMIKROJS_BOARD_NAME=}" ;;',
    '  esac',
    '  shift',
    'done',
    '[ -n "$project" ] && set_name=$(sed -n \'s/^set(MIKROJS_BOARD_NAME "\\(.*\\)")$/\\1/p\' "$project/CMakeLists.txt")',
    '[ -n "$set_name" ] && name="$set_name"',
    '[ -n "$given" ] && name="$given"',
    '[ -n "$FAKE_IDF_NONAME" ] && name=',
    '[ -n "$FAKE_IDF_EXIT" ] && exit "$FAKE_IDF_EXIT"',
    `mkdir -p "$dir" && cp -R "${template}/." "$dir"`,
    'if [ -n "$name" ]; then field="\\"name\\": \\"$name\\", "; fi',
    `printf '{%s"chip": "esp32c6", "version": "${pkg.version}"}\\n' "$field" > "$dir/firmware.json"`,
    'exit 0',
    '',
  ].join('\n'),
)
chmodSync(pathlib.join(idfDir, 'idf.py'), 0o755)
const idfLog = pathlib.join(root, 'idf.log')

/** @mikrojs/firmware above every project, as a workspace hoists it: the build
 *  resolves it for MikroFirmware_DIR. */
write(
  pathlib.join(root, 'node_modules', '@mikrojs', 'firmware', 'package.json'),
  JSON.stringify({
    name: '@mikrojs/firmware',
    exports: {'.': {cmake: './MikroFirmwareConfig.cmake'}},
  }),
)

/** Custom firmware: a firmware project that is no board package. */
const app = pathlib.join(root, 'app')
write(pathlib.join(app, 'package.json'), '{"name": "my-firmware"}')
write(pathlib.join(app, 'CMakeLists.txt'), '')

/** A single-board package: boards.config.ts and no firmware project. */
const board = pathlib.join(root, 'devboard')
const BOARD_PACKAGE = {
  name: '@acme/devboard',
  description: 'ACME DevBoard',
  files: ['dist-fw'],
  exports: {'.': {firmware: './dist-fw/firmware.json'}},
}
write(pathlib.join(board, 'package.json'), JSON.stringify(BOARD_PACKAGE))
const BOARD_CONFIG = `import {defineBoards} from 'mikro'\n\nexport default defineBoards({boards: {'.': {chip: 'esp32c6'}}})\n`
write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG)

/** A multi-board package: one board with settings of its own, one with a
 *  native module. */
const boards = pathlib.join(root, 'boards')
write(
  pathlib.join(boards, 'package.json'),
  JSON.stringify({
    name: '@acme/boards',
    files: ['dist-fw'],
    exports: {
      './t-display': {firmware: './dist-fw/t-display/firmware.json'},
      './devkit': {firmware: './dist-fw/devkit/firmware.json'},
    },
  }),
)
write(pathlib.join(boards, 't-display.defaults'), 'CONFIG_SPIRAM=y\n')
write(
  pathlib.join(boards, 'boards.config.ts'),
  [
    `import {defineBoards} from 'mikro'`,
    ``,
    `export default defineBoards({`,
    `  boards: {`,
    `    './t-display': {chip: 'esp32c6', description: 'T-Display', sdkconfig: 't-display.defaults'},`,
    `    './devkit': {chip: 'esp32c6', nativeModules: ['@acme/drivers/a', '@acme/drivers/b']},`,
    `  },`,
    `})`,
    ``,
  ].join('\n'),
)

const originalCwd = process.cwd()

beforeEach(() => {
  vi.stubEnv('PATH', [idfDir, '/usr/bin', '/bin'].join(':'))
  vi.stubEnv('FAKE_IDF_NAME', 'my-firmware')
  vi.stubEnv('FAKE_IDF_LOG', idfLog)
  process.chdir(app)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  agent.mode = false
  process.chdir(originalCwd)
  rmSync(idfLog, {force: true})
  for (const dir of [app, board, boards]) {
    for (const file of ['.mikro', 'dist-fw'])
      rmSync(pathlib.join(dir, file), {recursive: true, force: true})
    for (const name of [
      'esp32c6',
      'my-firmware-esp32c6',
      'acme-devboard-esp32c6',
      'acme-boards-t-display-esp32c6',
      'acme-boards-devkit-esp32c6',
    ]) {
      rmSync(pathlib.join(dir, `mikro-fw-${name}.tar.gz`), {force: true})
    }
  }
  write(pathlib.join(board, 'package.json'), JSON.stringify(BOARD_PACKAGE))
  write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG)
})

afterAll(() => {
  rmSync(root, {recursive: true, force: true})
})

function entries(tarball: string): string[] {
  return execFileSync('tar', ['-tzf', tarball], {encoding: 'utf8'}).trim().split('\n').sort()
}

/** The idf.py calls, one line of arguments each. */
function idfCalls(): string[] {
  return existsSync(idfLog) ? readFileSync(idfLog, 'utf8').trim().split('\n') : []
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

    await run({subcommand: 'pack', out: undefined, board: undefined})

    expect(existsSync(pathlib.join(app, '.mikro', 'build-fw', 'flasher_args.json'))).toBe(true)
    // The name `mikro flash --from` looks for
    expect(entries(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for my-firmware')
  })

  it('names firmware without a name after its chip', async () => {
    vi.stubEnv('FAKE_IDF_NAME', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined})

    expect(entries(pathlib.join(app, 'mikro-fw-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for esp32c6')
  })

  it("packs a board's image as fw prepack writes it", async () => {
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined})

    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(existsSync(pathlib.join(board, 'dist-fw', 'my-firmware.bin'))).toBe(true)
  })

  it('packs each board of a multi-board package, or the one --board names', async () => {
    process.chdir(boards)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined})

    for (const name of ['t-display', 'devkit']) {
      expect(entries(pathlib.join(boards, `mikro-fw-acme-boards-${name}-esp32c6.tar.gz`))).toEqual(
        IMAGE,
      )
    }
    rmSync(pathlib.join(boards, 'mikro-fw-acme-boards-devkit-esp32c6.tar.gz'))

    const out = pathlib.join(root, 'devkit.tar.gz')
    await run({subcommand: 'pack', out, board: 'devkit'})
    expect(entries(out)).toEqual(IMAGE)
    expect(existsSync(pathlib.join(boards, 'mikro-fw-acme-boards-devkit-esp32c6.tar.gz'))).toBe(
      false,
    )
  })

  it('refuses --out for several boards, and --board outside a board package', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    process.chdir(boards)
    await run({subcommand: 'pack', out: pathlib.join(root, 'x.tar.gz'), board: undefined})
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--out names one archive'))

    process.chdir(app)
    await run({subcommand: 'pack', out: undefined, board: 'devkit'})
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('has no boards.config.ts'))
    expect(exit).toHaveBeenCalledWith(1)
    expect(idfCalls()).toEqual([])
  })

  it('writes to --out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = pathlib.join(root, 'custom.tar.gz')

    await run({subcommand: 'pack', out, board: undefined})

    expect(entries(out)).toContain('my-firmware.bin')
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it("stops with idf.py's exit code when the build fails", async () => {
    vi.stubEnv('FAKE_IDF_EXIT', '2')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await run({subcommand: 'pack', out: undefined, board: undefined})

    // idf.py has printed the failure; a second line would repeat it.
    expect(error).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(2)
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it('prints only the result on stdout in agent mode', async () => {
    agent.mode = true
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await run({subcommand: 'pack', out: undefined, board: undefined})

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
  it('builds the board from a generated firmware project and writes its image', async () => {
    process.chdir(board)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runPrepack({subcommand: 'prepack', board: undefined})

    expect(
      JSON.parse(readFileSync(pathlib.join(board, 'dist-fw', 'firmware.json'), 'utf8')),
    ).toMatchObject({name: '@acme/devboard', chip: 'esp32c6'})
    for (const file of IMAGE) expect(existsSync(pathlib.join(board, 'dist-fw', file))).toBe(true)
    // Only what flashing needs: no .elf, no build tree
    expect(existsSync(pathlib.join(board, 'dist-fw', 'my-firmware.elf'))).toBe(false)
    expect(log).toHaveBeenCalledWith('Wrote the image of @acme/devboard (esp32c6) to dist-fw')

    // The generated project names the board itself, so it also builds on its own
    const project = pathlib.join(board, '.mikro', 'fw')
    expect(readFileSync(pathlib.join(project, 'CMakeLists.txt'), 'utf8')).toContain(
      [
        'set(MIKROJS_BOARD_NAME "@acme/devboard")',
        'set(MIKROJS_BOARD_DESCRIPTION "ACME DevBoard")',
        'set(MIKROJS_NATIVE_MODULES "")',
        'find_package(MikroFirmware REQUIRED COMPONENTS esp32 NO_DEFAULT_PATH)',
      ].join('\n'),
    )
    const [call] = idfCalls()
    expect(call).toContain(
      `-C ${project} -B ${pathlib.join(board, '.mikro', 'build-fw')} -DIDF_TARGET=esp32c6 build`,
    )
  })

  it('builds every board of a multi-board package, or the one --board names', async () => {
    process.chdir(boards)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runPrepack({subcommand: 'prepack', board: undefined})

    for (const name of ['t-display', 'devkit']) {
      expect(
        JSON.parse(readFileSync(pathlib.join(boards, 'dist-fw', name, 'firmware.json'), 'utf8')),
      ).toMatchObject({name: `@acme/boards/${name}`})
    }
    expect(
      readFileSync(pathlib.join(boards, '.mikro', 'fw-t-display', 'sdkconfig.defaults'), 'utf8'),
    ).toContain('CONFIG_SPIRAM=y')
    const [tDisplay] = idfCalls()
    expect(tDisplay).toContain(`-B ${pathlib.join(boards, '.mikro', 'build-fw-t-display')}`)
    const cmake = (board: string) =>
      readFileSync(pathlib.join(boards, '.mikro', `fw-${board}`, 'CMakeLists.txt'), 'utf8')
    expect(cmake('t-display')).toContain('set(MIKROJS_BOARD_DESCRIPTION "T-Display")')
    expect(cmake('devkit')).toContain(
      'set(MIKROJS_NATIVE_MODULES "@acme/drivers/a;@acme/drivers/b")',
    )

    rmSync(idfLog)
    await runPrepack({subcommand: 'prepack', board: '@acme/boards/devkit'})
    expect(idfCalls()).toHaveLength(1)
    expect(idfCalls()[0]).toContain('build-fw-devkit')
  })

  it('stops before building when the exports do not match the config', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'package.json'), JSON.stringify({...BOARD_PACKAGE, exports: {}}))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runPrepack({subcommand: 'prepack', board: undefined})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'add these to "exports" in package.json (next to any other conditions of the same export):\n' +
          '  ".": {"firmware": "./dist-fw/firmware.json"}',
      ),
    )
    expect(exit).toHaveBeenCalledWith(1)
    expect(idfCalls()).toEqual([])
  })

  it('shows what a boards.config.ts looks like when the package has none', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runPrepack({subcommand: 'prepack', board: undefined})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        `${pathlib.join(app, 'boards.config.ts')} does not exist. A board package lists its boards there`,
      ),
    )
    // The package has a firmware project of its own, which `project` keeps
    expect(error).toHaveBeenCalledWith(expect.stringContaining("{chip: 'esp32c6', project: '.'}"))
  })

  it('replaces only a folder of its own', async () => {
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // An image folder around the build would delete the build it copies from
    write(
      pathlib.join(board, 'boards.config.ts'),
      BOARD_CONFIG.replace('{boards:', `{dist: '.mikro', boards:`),
    )
    write(
      pathlib.join(board, 'package.json'),
      JSON.stringify({...BOARD_PACKAGE, exports: {'.': {firmware: './.mikro/firmware.json'}}}),
    )
    await runPrepack({subcommand: 'prepack', board: undefined})
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('holds more than the image'))

    // A folder with other files in it is not replaced
    write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG)
    write(pathlib.join(board, 'package.json'), JSON.stringify(BOARD_PACKAGE))
    write(pathlib.join(board, 'dist-fw', 'index.js'), 'export {}\n')
    await runPrepack({subcommand: 'prepack', board: undefined})
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('holds files that are not an image'),
    )
    expect(existsSync(pathlib.join(board, 'dist-fw', 'index.js'))).toBe(true)

    // Nor one with another board's image in it
    rmSync(pathlib.join(board, 'dist-fw', 'index.js'))
    write(pathlib.join(board, 'dist-fw', 't-display', 'firmware.json'), '{}')
    await runPrepack({subcommand: 'prepack', board: undefined})
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('holds the images of other boards (t-display)'),
    )
    expect(existsSync(pathlib.join(board, 'dist-fw', 't-display', 'firmware.json'))).toBe(true)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('refuses an image that would not flash under its name', async () => {
    vi.stubEnv('FAKE_IDF_NONAME', '1')
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runPrepack({subcommand: 'prepack', board: undefined})

    expect(error).toHaveBeenCalledWith(expect.stringContaining('(name): missing required field'))
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('mikro fw check', () => {
  it("lists a package's boards when nothing is wrong", async () => {
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runPrepack({subcommand: 'prepack', board: undefined})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/@acme\/devboard: @acme\/devboard \(esp32c6, .*\) in dist-fw$/),
    )
    expect(exit).not.toHaveBeenCalled()
  })

  it('fails on an image that is not built', async () => {
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/@acme\/devboard: not built: /))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails on exports that do not match boards.config.ts', async () => {
    process.chdir(board)
    write(
      pathlib.join(board, 'package.json'),
      JSON.stringify({...BOARD_PACKAGE, exports: {'.': {firmware: './image/firmware.json'}}}),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'the "firmware" condition of "." is "./image/firmware.json", but boards.config.ts puts the image at "./dist-fw/firmware.json"',
      ),
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails on a package that declares no board', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('has no export with a "firmware" condition'),
    )
    expect(exit).toHaveBeenCalledWith(1)
  })
})

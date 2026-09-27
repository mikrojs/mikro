import {execFileSync} from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

// `fw build --flash` runs `mikro flash`, which needs a device: record the call
const flashed = vi.hoisted(() => ({calls: [] as string[][], code: 0}))
vi.mock('../fw/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fw/shared.js')>()),
  flashBuiltImage: (...args: string[]) => {
    flashed.calls.push(args)
    return flashed.code
  },
}))

const {run} = await import('../fw/pack.js')
const {run: runBuild} = await import('../fw/build.js')
const {run: runCheck} = await import('../fw/check.js')

/* `mikro fw pack`, `build` and `check` against a fake idf.py that writes a
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
 *  empty, or with $FAKE_IDF_NONAME). Its features are wifi, ble and i2s, less
 *  what the -C project's sdkconfig.defaults switches off. */
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
    'features=\'"wifi", "ble", "i2s"\'',
    'if [ -n "$project" ] && grep -q "^CONFIG_BT_ENABLED=n" "$project/sdkconfig.defaults" 2>/dev/null; then features=$(printf "%s" "$features" | sed \'s/, "ble"//\'); fi',
    'if [ -n "$project" ] && grep -q "^CONFIG_MIKROJS_WIFI=n" "$project/sdkconfig.defaults" 2>/dev/null; then features=$(printf "%s" "$features" | sed \'s/"wifi", //\'); fi',
    '[ -n "$FAKE_IDF_EXIT" ] && exit "$FAKE_IDF_EXIT"',
    `mkdir -p "$dir" && cp -R "${template}/." "$dir"`,
    'if [ -n "$name" ]; then field="\\"name\\": \\"$name\\", "; fi',
    `printf '{%s"chip": "esp32c6", "version": "${pkg.version}", "features": [%s]}\\n' "$field" "$features" > "$dir/firmware.json"`,
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
  exports: {'.': {firmware: './dist-fw/full/firmware.json'}},
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
      './t-display': {firmware: './dist-fw/t-display/full/firmware.json'},
      './devkit': {firmware: './dist-fw/devkit/full/firmware.json'},
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
      'acme-devboard-esp32c6+no-ble',
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

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    expect(existsSync(pathlib.join(app, '.mikro', 'build-fw', 'flasher_args.json'))).toBe(true)
    // The name `mikro flash --from` looks for
    expect(entries(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for my-firmware')
  })

  it('names firmware without a name after its chip', async () => {
    vi.stubEnv('FAKE_IDF_NAME', '')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    expect(entries(pathlib.join(app, 'mikro-fw-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(log).toHaveBeenCalledWith('Packed firmware for esp32c6')
  })

  it("packs a board's image as fw build writes it", async () => {
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(existsSync(pathlib.join(board, 'dist-fw', 'full', 'my-firmware.bin'))).toBe(true)
  })

  it('packs each board of a multi-board package, or the one --board names', async () => {
    process.chdir(boards)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    for (const name of ['t-display', 'devkit']) {
      expect(entries(pathlib.join(boards, `mikro-fw-acme-boards-${name}-esp32c6.tar.gz`))).toEqual(
        IMAGE,
      )
    }
    rmSync(pathlib.join(boards, 'mikro-fw-acme-boards-devkit-esp32c6.tar.gz'))

    const out = pathlib.join(root, 'devkit.tar.gz')
    await run({subcommand: 'pack', out, board: 'devkit', parallel: undefined})
    expect(entries(out)).toEqual(IMAGE)
    expect(existsSync(pathlib.join(boards, 'mikro-fw-acme-boards-devkit-esp32c6.tar.gz'))).toBe(
      false,
    )
  })

  it('refuses --out for several boards, and --board outside a board package', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    process.chdir(boards)
    await run({
      subcommand: 'pack',
      out: pathlib.join(root, 'x.tar.gz'),
      board: undefined,
      parallel: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--out names one archive'))

    process.chdir(app)
    await run({subcommand: 'pack', out: undefined, board: 'devkit', parallel: undefined})
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('has no boards.config.ts'))
    expect(exit).toHaveBeenCalledWith(1)
    expect(idfCalls()).toEqual([])
  })

  it('writes to --out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = pathlib.join(root, 'custom.tar.gz')

    await run({subcommand: 'pack', out, board: undefined, parallel: undefined})

    expect(entries(out)).toContain('my-firmware.bin')
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it("stops with idf.py's exit code when the build fails", async () => {
    vi.stubEnv('FAKE_IDF_EXIT', '2')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    // idf.py has printed the failure; a second line would repeat it.
    expect(error).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(2)
    expect(existsSync(pathlib.join(app, 'mikro-fw-my-firmware-esp32c6.tar.gz'))).toBe(false)
  })

  it('prints only the result on stdout in agent mode', async () => {
    agent.mode = true
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

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

describe('mikro fw build', () => {
  it('builds the board from a generated firmware project and writes its image', async () => {
    process.chdir(board)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    expect(
      JSON.parse(readFileSync(pathlib.join(board, 'dist-fw', 'full', 'firmware.json'), 'utf8')),
    ).toMatchObject({name: '@acme/devboard', chip: 'esp32c6'})
    for (const file of IMAGE) {
      expect(existsSync(pathlib.join(board, 'dist-fw', 'full', file))).toBe(true)
    }
    // Only what flashing needs: no .elf, no build tree
    expect(existsSync(pathlib.join(board, 'dist-fw', 'full', 'my-firmware.elf'))).toBe(false)
    expect(log).toHaveBeenCalledWith('Wrote the image of @acme/devboard (esp32c6) to dist-fw/full')

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

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    for (const name of ['t-display', 'devkit']) {
      expect(
        JSON.parse(
          readFileSync(pathlib.join(boards, 'dist-fw', name, 'full', 'firmware.json'), 'utf8'),
        ),
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
    await runBuild({
      subcommand: 'build',
      board: '@acme/boards/devkit',
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(idfCalls()).toHaveLength(1)
    expect(idfCalls()[0]).toContain('build-fw-devkit')
  })

  it('stops before building when the exports do not match the config', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'package.json'), JSON.stringify({...BOARD_PACKAGE, exports: {}}))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'add these to "exports" in package.json (next to any other conditions of the same export):\n' +
          '  ".": {"firmware": "./dist-fw/full/firmware.json"}',
      ),
    )
    expect(exit).toHaveBeenCalledWith(1)
    expect(idfCalls()).toEqual([])
  })

  it('shows what a boards.config.ts looks like when the package has none', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

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
      JSON.stringify({...BOARD_PACKAGE, exports: {'.': {firmware: './.mikro/full/firmware.json'}}}),
    )
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('holds more than the images'))

    // What Finder leaves behind is no reason to stop
    write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG)
    write(pathlib.join(board, 'package.json'), JSON.stringify(BOARD_PACKAGE))
    write(pathlib.join(board, 'dist-fw', '.DS_Store'), '')
    error.mockClear()
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(error).not.toHaveBeenCalled()
    // An image folder with only that in it counts as empty
    rmSync(pathlib.join(board, 'dist-fw', 'full'), {recursive: true})
    write(pathlib.join(board, 'dist-fw', 'full', '.DS_Store'), '')
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: 'full',
      parallel: undefined,
      flash: undefined,
    })
    expect(error).not.toHaveBeenCalled()
    expect(existsSync(pathlib.join(board, 'dist-fw', 'full', 'firmware.json'))).toBe(true)
    rmSync(pathlib.join(board, 'dist-fw'), {recursive: true})

    // A folder with other files in it is not emptied, and nothing builds
    write(pathlib.join(board, 'dist-fw', 'index.js'), 'export {}\n')
    rmSync(idfLog, {force: true})
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('dist-fw holds more than images (index.js)'),
    )
    expect(existsSync(pathlib.join(board, 'dist-fw', 'index.js'))).toBe(true)
    expect(idfCalls()).toEqual([])

    // Nor an image written straight into it, as before images moved to full/
    rmSync(pathlib.join(board, 'dist-fw', 'index.js'))
    write(pathlib.join(board, 'dist-fw', 'firmware.json'), '{}')
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('dist-fw holds an image in the layout from before full/'),
    )
    rmSync(pathlib.join(board, 'dist-fw', 'firmware.json'))

    // Nor one with another board's image in it
    write(pathlib.join(board, 'dist-fw', 't-display', 'firmware.json'), '{}')
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
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

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    expect(error).toHaveBeenCalledWith(expect.stringContaining('(name): missing required field'))
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe("a board's other images", () => {
  const withImages = (images: string) =>
    BOARD_CONFIG.replace(`{chip: 'esp32c6'}`, `{chip: 'esp32c6', images: ${images}}`)

  it('builds each in a project of its own and writes it beside the full image', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    const firmwareJson = (image: string) =>
      JSON.parse(readFileSync(pathlib.join(board, 'dist-fw', image, 'firmware.json'), 'utf8'))
    expect(firmwareJson('full')).toMatchObject({features: ['wifi', 'ble', 'i2s']})
    // Each image describes itself; the CLI finds them by their folders
    expect(firmwareJson('no-ble')).toMatchObject({
      name: '@acme/devboard',
      features: ['wifi', 'i2s'],
    })
    for (const file of IMAGE) {
      expect(existsSync(pathlib.join(board, 'dist-fw', 'no-ble', file))).toBe(true)
    }
    expect(
      readFileSync(pathlib.join(board, '.mikro', 'fw+no-ble', 'sdkconfig.defaults'), 'utf8'),
    ).toContain('CONFIG_BT_ENABLED=n')
    expect(idfCalls()[1]).toContain(`-B ${pathlib.join(board, '.mikro', 'build-fw+no-ble')}`)
  })

  it('lists the images for a bare --image without a terminal to ask in', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: '',
      parallel: undefined,
      flash: undefined,
    })

    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('--image needs an image. The images of @acme/devboard: full, no-ble'),
    )
    expect(idfCalls()).toEqual([])
  })

  it('takes the parts of an image name in any order', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false, wifi: false}]'))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: 'no-wifi+no-ble',
      parallel: undefined,
      flash: undefined,
    })

    expect(existsSync(pathlib.join(board, 'dist-fw', 'no-ble+no-wifi', 'firmware.json'))).toBe(true)
  })

  it('builds one image with --image and keeps the others', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    const full = pathlib.join(board, 'dist-fw', 'full', 'firmware.json')
    const before = statSync(full).mtimeMs
    rmSync(idfLog)

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: 'no-ble',
      parallel: undefined,
      flash: undefined,
    })

    expect(idfCalls()).toHaveLength(1)
    expect(idfCalls()[0]).toContain(`-B ${pathlib.join(board, '.mikro', 'build-fw+no-ble')}`)
    expect(statSync(full).mtimeMs).toBe(before)
    for (const file of IMAGE) {
      expect(existsSync(pathlib.join(board, 'dist-fw', 'no-ble', file))).toBe(true)
    }

    // Only into an empty folder, or one with an image of this board
    rmSync(pathlib.join(board, 'dist-fw'), {recursive: true})
    write(pathlib.join(board, 'dist-fw', 'full', 'index.js'), 'export {}\n')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: 'full',
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('holds something other than an image of @acme/devboard'),
    )

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: 'no-wifi',
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('@acme/devboard has no no-wifi image. Its images: full, no-ble'),
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('builds them at once with --parallel, each logging beside its build folder', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: 4,
      flash: undefined,
    })

    expect(idfCalls()).toHaveLength(2)
    for (const build of ['build-fw', 'build-fw+no-ble']) {
      expect(existsSync(pathlib.join(board, '.mikro', `${build}.log`))).toBe(true)
    }
    for (const image of ['full', 'no-ble']) {
      expect(existsSync(pathlib.join(board, 'dist-fw', image, 'firmware.json'))).toBe(true)
    }
    expect(log).toHaveBeenCalledWith('Building 2 images, 2 at a time')
    expect(log).toHaveBeenCalledWith('  built @acme/devboard+no-ble')

    // A failed build names its log and exits with its code
    vi.stubEnv('FAKE_IDF_EXIT', '2')
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: 4,
      flash: undefined,
    })
    expect(log).toHaveBeenCalledWith(
      `  @acme/devboard+no-ble failed with exit code 2, see ${pathlib.join('.mikro', 'build-fw+no-ble.log')}`,
    )
    expect(exit).toHaveBeenCalledWith(2)
    // The last images stay until new ones are built
    for (const image of ['full', 'no-ble']) {
      expect(existsSync(pathlib.join(board, 'dist-fw', image, 'firmware.json'))).toBe(true)
    }
  })

  it('builds them at once with --parallel before packing each', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: 4})

    expect(log).toHaveBeenCalledWith('Building 2 images, 2 at a time')
    expect(existsSync(pathlib.join(board, '.mikro', 'build-fw+no-ble.log'))).toBe(true)
    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6+no-ble.tar.gz'))).toEqual(
      IMAGE,
    )

    // Custom firmware has one build
    process.chdir(app)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: 4})
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('--parallel builds a board'))
  })

  it('builds the images of every board from one queue, --parallel at a time', async () => {
    process.chdir(boards)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: 4,
      flash: undefined,
    })

    expect(log).toHaveBeenCalledWith('Building 2 images, 2 at a time')
    for (const name of ['t-display', 'devkit']) {
      expect(log).toHaveBeenCalledWith(`  built @acme/boards/${name}`)
      expect(existsSync(pathlib.join(boards, 'dist-fw', name, 'full', 'firmware.json'))).toBe(true)
    }

    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: 1,
      flash: undefined,
    })
    expect(log).toHaveBeenCalledWith('Building 2 images, 1 at a time')
  })

  it('lists the boards for a bare --board without a terminal to ask in', async () => {
    process.chdir(boards)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    rmSync(idfLog, {force: true})

    await runBuild({
      subcommand: 'build',
      board: '',
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })

    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '--board needs a board. The boards in boards.config.ts:\n' +
          '  @acme/boards/t-display (esp32c6)\n  @acme/boards/devkit (esp32c6)',
      ),
    )
    expect(idfCalls()).toEqual([])
  })

  it('flashes the one image it built with --flash', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const build = (image: string | undefined) =>
      runBuild({subcommand: 'build', board: undefined, image, parallel: undefined, flash: true})
    flashed.calls = []

    // As mikro flash picks it: by its features
    await build('no-ble')
    await build('full')
    expect(flashed.calls).toEqual([
      [board, '@acme/devboard', 'wifi,i2s'],
      [board, '@acme/devboard', 'full'],
    ])

    // Only one image, known before anything builds
    rmSync(idfLog, {force: true})
    await build(undefined)
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "--flash flashes one image: pick one of @acme/devboard's with --image (full, no-ble)",
      ),
    )
    process.chdir(boards)
    await build('full')
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining('--flash flashes one image: pick the board with --board'),
    )
    expect(idfCalls()).toEqual([])

    // A failed flash fails the command with its code
    process.chdir(board)
    flashed.code = 3
    await build('full')
    expect(exit).toHaveBeenLastCalledWith(3)
    flashed.code = 0
  })

  it('packs each, the others with their name as a suffix', async () => {
    process.chdir(board)
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await run({subcommand: 'pack', out: undefined, board: undefined, parallel: undefined})

    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6.tar.gz'))).toEqual(IMAGE)
    expect(entries(pathlib.join(board, 'mikro-fw-acme-devboard-esp32c6+no-ble.tar.gz'))).toEqual(
      IMAGE,
    )
  })

  it('refuses an image with the full image features, and images the config no longer has', async () => {
    process.chdir(board)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // ble is in the full image already
    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: true}]'))
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'the ble image has the same features as the full image (wifi, ble, i2s); leave it out of "images"',
      ),
    )

    write(pathlib.join(board, 'boards.config.ts'), withImages('[{ble: false}]'))
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG)
    await runCheck({subcommand: 'check'})
    expect(error).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'the other images built are no-ble, but boards.config.ts has none; run `mikro fw build`',
      ),
    )
  })
})

describe('mikro fw check', () => {
  it("lists a package's boards when nothing is wrong", async () => {
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/@acme\/devboard: @acme\/devboard \(esp32c6, .*\) in dist-fw\/full$/),
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

  it('fails on an image built for another board than boards.config.ts now names', async () => {
    process.chdir(board)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runBuild({
      subcommand: 'build',
      board: undefined,
      image: undefined,
      parallel: undefined,
      flash: undefined,
    })
    write(pathlib.join(board, 'boards.config.ts'), BOARD_CONFIG.replace('esp32c6', 'esp32s3'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    await runCheck({subcommand: 'check'})

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'the image is @acme/devboard for esp32c6, but boards.config.ts has @acme/devboard for esp32s3',
      ),
    )
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
        'the "firmware" condition of "." is "./image/firmware.json", but boards.config.ts puts the image at "./dist-fw/full/firmware.json"',
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

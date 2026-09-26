import {execFileSync, spawnSync} from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, isAbsolute, join} from 'node:path'

import {afterAll, expect, test} from 'vitest'

import {resolveFirmwareInputs} from '../inputs.ts'

/* Configure minimal consumer projects against project.cmake with plain CMake
 * (no ESP-IDF) and assert what reaches the build: which components land in
 * EXTRA_COMPONENT_DIRS, and the healing of frozen partition paths. Resolution runs from
 * the CONSUMER's directory (CMAKE_SOURCE_DIR), not this package's — while
 * include()d, CMAKE_CURRENT_LIST_DIR is @mikrojs/firmware inside node_modules. */

function hasCmake() {
  try {
    execFileSync('cmake', ['--version'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/** The package root: this file is in src/__test__/. */
const packageRoot = join(import.meta.dirname, '..', '..')
const projectCmake = join(packageRoot, 'project.cmake')
const fixtureDir = mkdtempSync(join(tmpdir(), 'mik-fw-cmake-'))

afterAll(() => {
  rmSync(fixtureDir, {recursive: true, force: true})
})

function write(file: string, content: string) {
  mkdirSync(dirname(file), {recursive: true})
  writeFileSync(file, content)
}

/** How the docs have a project find project.cmake: the package's bin, which
 *  npx runs wherever the package manager installed the package. */
const FIND_PROJECT_CMAKE = [
  'execute_process(',
  '    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32',
  '    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}',
  '    OUTPUT_VARIABLE _MIK_CMAKE_PATH',
  '    OUTPUT_STRIP_TRAILING_WHITESPACE',
  '    COMMAND_ERROR_IS_FATAL ANY',
  ')',
  'include(${_MIK_CMAKE_PATH})',
]

/** A consumer project; `lines` go before the include (set(MIKROJS_NATIVE_MODULES ...)). */
function makeProject(
  name: string,
  {
    lines = [],
    include = [`include("${projectCmake}")`],
  }: {lines?: string[]; include?: string[]} = {},
) {
  const dir = join(fixtureDir, name)
  write(
    join(dir, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.22)',
      // Stand in for the variables ESP-IDF defines before project.cmake runs
      'set(IDF_VERSION_MAJOR 6)',
      'set(IDF_VERSION_MINOR 1)',
      'set(IDF_VERSION_PATCH 0)',
      'set(IDF_TARGET esp32s3)',
      'project(fixture NONE)',
      ...lines,
      ...include,
      'message(STATUS "TEST_EXTRA_COMPONENT_DIRS=${EXTRA_COMPONENT_DIRS}")',
      '',
    ].join('\n'),
  )
  return dir
}

interface ConfigureOptions {
  args?: string[]
  env?: Record<string, string>
  buildDir?: string
}

/** The TEST_<name>=<value> lines the configure printed, by name. */
function configure(
  dir: string,
  {args = [], env = {}, buildDir = join(dir, 'build')}: ConfigureOptions = {},
): Record<string, string> {
  const out = execFileSync('cmake', ['-S', dir, '-B', buildDir, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env},
    stdio: 'pipe',
  })
  const vars: Record<string, string> = {}
  for (const [, name = '', value = ''] of out.matchAll(/TEST_(\w+)=(.*)/g)) vars[name] = value
  return vars
}

/** A package with one native module, `<name>/<module>`, installed in the project. */
function installFakeNativePackage(dir: string, name = 'fake-native', module = 'fx') {
  const packageDir = join(dir, 'node_modules', name)
  write(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      exports: {
        [`./${module}`]: {types: `./${module}/${module}.d.ts`, native: `./${module}/${module}.cpp`},
      },
    }),
  )
  write(join(packageDir, `${module}/${module}.cpp`), '// registers the module\n')
  write(join(packageDir, `${module}/${module}.d.ts`), `export declare const ${module}: number\n`)
  write(join(packageDir, `${module}/CMakeLists.txt`), 'idf_component_register()\n')
  return packageDir
}

test('resolution is empty for projects without a package.json', async () => {
  // On-device test apps (esp32/test, the firmware package's test/) configure
  // through project.cmake without a package.json of their own (their firmware
  // name comes from the package.json above them)
  const emptyDir = join(fixtureDir, 'no-package-json')
  mkdirSync(emptyDir)
  expect(await resolveFirmwareInputs(emptyDir)).toEqual({
    components: '',
    nativeModules: '',
    configureDepends: '',
  })
})

const component = join(packageRoot, 'components', 'mikrojs')
const {version} = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version: string
}

/** The firmware.json the component wrote into the build directory. */
function firmwareJson(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'build', 'firmware.json'), 'utf8'))
}

/** Configure the mikrojs component in a project at `dir` the way ESP-IDF does
 *  after project.cmake, with ESP-IDF's commands stubbed and a stand-in for
 *  quickjs.cmake (which would patch QuickJS and build qjsc). `lines` go before
 *  the include (set(MIKROJS_BOARD_NAME ...)). */
function configureComponent(dir: string, lines: string[] = []) {
  const stub = join(dir, 'stub.c')
  write(stub, '')
  write(
    join(dir, 'quickjs-stub.cmake'),
    `set(QUICKJS_SOURCES "${stub}")\nset(QJSC_EXECUTABLE "${stub}")\n`,
  )
  write(
    join(dir, 'CMakeLists.txt'),
    [
      'cmake_minimum_required(VERSION 3.22)',
      'set(IDF_VERSION_MAJOR 6)',
      'set(IDF_VERSION_MINOR 1)',
      'set(IDF_VERSION_PATCH 0)',
      'set(IDF_TARGET esp32c6)',
      'project(fixture C)',
      ...lines,
      `include("${projectCmake}")`,
      'message(STATUS "TEST_QUICKJS_CMAKE=${MIK_QUICKJS_CMAKE}")',
      `set(MIK_QUICKJS_CMAKE "${join(dir, 'quickjs-stub.cmake')}")`,
      'set(CONFIG_MIKROJS_WIFI 1)',
      'macro(idf_component_register)',
      '  set(COMPONENT_LIB mikrojs_lib)',
      `  add_library(mikrojs_lib STATIC "${stub}")`,
      'endmacro()',
      // The symbol map hook attaches to <project>.elf
      'function(idf_build_get_property var property)',
      '  set(${var} fixture PARENT_SCOPE)',
      'endfunction()',
      `add_library(fixture.elf STATIC "${stub}")`,
      `add_subdirectory("${component}" mikrojs)`,
      'get_target_property(definitions mikrojs_lib COMPILE_DEFINITIONS)',
      'message(STATUS "TEST_DEFINITIONS=${definitions}")',
      '',
    ].join('\n'),
  )
  return configure(dir)
}

test.skipIf(!hasCmake())(
  'the component compiles in the firmware version, the project name and the features',
  () => {
    const dir = join(fixtureDir, 'component-named')
    write(
      join(dir, 'package.json'),
      JSON.stringify({name: 'acme-sensor-fw', description: 'ACME sensor node'}),
    )
    const vars = configureComponent(dir)
    expect(vars.DEFINITIONS).toContain(`MIK_FW_VERSION="${version}"`)
    expect(vars.DEFINITIONS).toContain('MIK_BOARD_NAME="acme-sensor-fw"')
    expect(vars.DEFINITIONS).toContain('MIK_FW_FEATURES="wifi,i2s"')
    expect(existsSync(vars.QUICKJS_CMAKE ?? '')).toBe(true)
    // firmware.json next to flasher_args.json: what the image is, for tools
    // that read it without a device
    expect(firmwareJson(dir)).toEqual({
      name: 'acme-sensor-fw',
      description: 'ACME sensor node',
      chip: 'esp32c6',
      version,
    })
  },
  30_000,
)

test.skipIf(!hasCmake())(
  "a firmware folder without a package.json takes the name of the app it's in",
  () => {
    const app = join(fixtureDir, 'component-app')
    write(join(app, 'package.json'), JSON.stringify({name: 'acme-app'}))
    const vars = configureComponent(join(app, 'firmware'))
    expect(vars.DEFINITIONS).toContain('MIK_BOARD_NAME="acme-app"')
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'without a package.json, or a name in it, the firmware has no name',
  () => {
    // No package.json at or above the project: the device omits the fw identity
    const bare = configureComponent(join(fixtureDir, 'component-bare'))
    expect(bare.DEFINITIONS).toContain('MIK_FW_VERSION=')
    expect(bare.DEFINITIONS).not.toContain('MIK_BOARD_NAME')
    expect(firmwareJson(join(fixtureDir, 'component-bare'))).toEqual({chip: 'esp32c6', version})

    const unnamed = join(fixtureDir, 'component-unnamed')
    write(join(unnamed, 'package.json'), JSON.stringify({private: true}))
    expect(configureComponent(unnamed).DEFINITIONS).not.toContain('MIK_BOARD_NAME')
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'MIKROJS_BOARD_NAME and MIKROJS_BOARD_DESCRIPTION override the package.json',
  () => {
    const dir = join(fixtureDir, 'component-board')
    write(join(dir, 'package.json'), JSON.stringify({name: '@acme/boards', description: 'x'}))
    const vars = configureComponent(dir, [
      'set(MIKROJS_BOARD_NAME "@acme/boards/t-display")',
      'set(MIKROJS_BOARD_DESCRIPTION "LILYGO T-Display, 1.14\\" \\\\ ST7789")',
    ])
    expect(vars.DEFINITIONS).toContain('MIK_BOARD_NAME="@acme/boards/t-display"')
    // A description is free text, escaped for JSON
    expect(firmwareJson(dir)).toEqual({
      name: '@acme/boards/t-display',
      description: 'LILYGO T-Display, 1.14" \\ ST7789',
      chip: 'esp32c6',
      version,
    })
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a board name the device and a registry cannot take fails to configure',
  () => {
    const long = `@acme/${'x'.repeat(60)}`
    for (const [label, name] of [
      ['uppercase', 'Acme-Board'],
      ['too-long', long],
      ['nested', '@acme/boards/t-display/v2'],
    ] as const) {
      const dir = join(fixtureDir, `component-bad-name-${label}`)
      expect(() => configureComponent(dir, [`set(MIKROJS_BOARD_NAME "${name}")`]), label).toThrow(
        /the\s+board\s+name\s+is/,
      )
    }
  },
  30_000,
)

test.skipIf(!hasCmake())(
  "the component's requirements pass runs without project.cmake",
  () => {
    // ESP-IDF first includes each component's CMakeLists.txt from a separate
    // script-mode CMake run, where idf_component_register records REQUIRES and
    // returns. None of project.cmake's variables are set there.
    const script = join(fixtureDir, 'requirements-pass.cmake')
    write(
      script,
      [
        'macro(idf_component_register)',
        '  cmake_parse_arguments(_ "" "" "SRCS;INCLUDE_DIRS;REQUIRES" ${ARGN})',
        '  message(STATUS "TEST_REQUIRES=${__REQUIRES}")',
        '  return()',
        'endmacro()',
        'function(collect_requirements)',
        `  include("${join(component, 'CMakeLists.txt')}")`,
        'endfunction()',
        'set(CMAKE_BUILD_EARLY_EXPANSION 1)',
        'collect_requirements()',
        '',
      ].join('\n'),
    )
    const {status, stdout, stderr} = spawnSync('cmake', ['-P', script], {encoding: 'utf8'})
    // A clean stderr: include() of an unset path would only warn
    expect({status, stderr}).toEqual({status: 0, stderr: ''})
    expect(stdout).toMatch(/TEST_REQUIRES=.*\besp_wifi\b/)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a project finds project.cmake through the package bin, also when the package is hoisted',
  () => {
    // Installed at the workspace root, as npm and yarn workspaces hoist it,
    // with its bin linked the way package managers link bins
    const workspace = join(fixtureDir, 'hoisted')
    mkdirSync(join(workspace, 'node_modules/@mikrojs'), {recursive: true})
    mkdirSync(join(workspace, 'node_modules/.bin'))
    symlinkSync(packageRoot, join(workspace, 'node_modules/@mikrojs/firmware'))
    symlinkSync(
      '../@mikrojs/firmware/bin/mikro-fw.js',
      join(workspace, 'node_modules/.bin/mikro-fw'),
    )
    const dir = makeProject('hoisted/firmware', {include: FIND_PROJECT_CMAKE})
    expect(configure(dir).EXTRA_COMPONENT_DIRS).toContain(
      join(realpathSync(packageRoot), 'components'),
    )
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'declared native modules land in EXTRA_COMPONENT_DIRS; installed but undeclared ones do not',
  () => {
    const declared = makeProject('native-declared', {
      lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")'],
    })
    installFakeNativePackage(declared)
    const vars = configure(declared)
    // Suffix match: resolution reports real paths (/private/var vs /var on macOS)
    expect(vars.EXTRA_COMPONENT_DIRS).toContain(join('node_modules', 'fake-native', 'fx'))

    const undeclared = makeProject('native-undeclared')
    installFakeNativePackage(undeclared)
    expect(configure(undeclared).EXTRA_COMPONENT_DIRS).not.toContain('fake-native')
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a native module named like an ESP-IDF component fails to configure',
  () => {
    const dir = makeProject('idf-clash', {lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")']})
    installFakeNativePackage(dir)
    // The native module's directory is named fx; so is this IDF component
    const idf = join(fixtureDir, 'fake-idf')
    write(join(idf, 'components/fx/CMakeLists.txt'), '')
    expect(() => configure(dir, {env: {IDF_PATH: idf}})).toThrow(
      /is named\s+"fx",\s+like\s+an\s+ESP-IDF\s+component/,
    )
    expect(() =>
      configure(dir, {buildDir: join(dir, 'build-no-clash'), env: {IDF_PATH: ''}}),
    ).not.toThrow()
  },
  30_000,
)

test.skipIf(!hasCmake())(
  "a native module named like one of the project's components fails to configure",
  () => {
    for (const where of ['components', 'managed_components']) {
      const dir = makeProject(`own-clash-${where}`, {
        lines: ['set(MIKROJS_NATIVE_MODULES "fake-native/fx")'],
      })
      installFakeNativePackage(dir)
      write(join(dir, where, 'fx/CMakeLists.txt'), '')
      expect(() => configure(dir, {env: {IDF_PATH: ''}}), where).toThrow(
        /is named\s+"fx",\s+like\s+the\s+project's\s+component/,
      )
    }
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'MIKROJS_NATIVE_MODULES precedence is -D, then environment, then set()',
  () => {
    const dir = makeProject('native-precedence', {
      lines: ['set(MIKROJS_NATIVE_MODULES "n-set/nset")'],
    })
    installFakeNativePackage(dir, 'n-set', 'nset')
    installFakeNativePackage(dir, 'n-env', 'nenv')
    installFakeNativePackage(dir, 'n-cache', 'ncache')
    const components = (options: ConfigureOptions) => {
      const dirs = configure(dir, options).EXTRA_COMPONENT_DIRS ?? ''
      return ['nset', 'nenv', 'ncache'].filter((name) => dirs.includes(`/${name}`))
    }
    expect(components({buildDir: join(dir, 'build-set')})).toEqual(['nset'])
    expect(
      components({buildDir: join(dir, 'build-env'), env: {MIKROJS_NATIVE_MODULES: 'n-env/nenv'}}),
    ).toEqual(['nenv'])
    expect(
      components({
        buildDir: join(dir, 'build-cache'),
        args: ['-DMIKROJS_NATIVE_MODULES=n-cache/ncache'],
        env: {MIKROJS_NATIVE_MODULES: 'n-env/nenv'},
      }),
    ).toEqual(['ncache'])
  },
  60_000,
)

test.skipIf(!hasCmake())(
  'an unresolvable native module fails to configure with the resolver message',
  () => {
    const dir = makeProject('native-missing', {lines: ['set(MIKROJS_NATIVE_MODULES "nope/fx")']})
    expect(() => configure(dir)).toThrow(/names "nope\/fx", but no package "nope" is installed/)
  },
  30_000,
)

/* Partition table path healing. An sdkconfig created before the
 * build/partitions.csv indirection (or by an older @mikrojs/firmware) froze
 * an absolute store path into CONFIG_PARTITION_TABLE_CUSTOM_FILENAME;
 * sdkconfig wins over defaults fragments, so upgrades broke the build. */

test.skipIf(!hasCmake())(
  'sdkconfig frozen to a path outside the project is repointed, even when that path exists',
  () => {
    const dir = makeProject('heal-stale')
    // The firmware package's own partitions.csv: a realistic frozen store
    // path that still exists on disk, like an older version kept in the store
    const stale = join(packageRoot, 'partitions.csv')
    writeFileSync(
      join(dir, 'sdkconfig'),
      [
        `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${stale}"`,
        `CONFIG_PARTITION_TABLE_FILENAME="${stale}"`,
        '',
      ].join('\n'),
    )

    configure(dir)

    const sdkconfig = readFileSync(join(dir, 'sdkconfig'), 'utf8')
    expect(sdkconfig).toContain('CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="build/partitions.csv"')
    // The derived twin must not keep quoting the stale path either
    expect(sdkconfig).toContain('CONFIG_PARTITION_TABLE_FILENAME="build/partitions.csv"')
    expect(sdkconfig).not.toContain(stale)
    expect(existsSync(join(dir, 'build', 'partitions.csv'))).toBe(true)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'sdkconfig pointing at a file inside the project (menuconfig override) is left alone',
  () => {
    const dir = makeProject('heal-override')
    const before = 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="my-partitions.csv"\n'
    writeFileSync(join(dir, 'sdkconfig'), before)

    configure(dir)

    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toBe(before)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'sdkconfig pointing at the partition table of another build dir in the project is repointed',
  () => {
    // Plain idf.py builds in build/, `mikro idf` in .mikro/build-fw
    const dir = makeProject('heal-other-build')
    const setting = (path: string) => `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="${path}"`
    configure(dir)
    writeFileSync(join(dir, 'sdkconfig'), `${setting('build/partitions.csv')}\n`)

    configure(dir, {buildDir: join(dir, '.mikro', 'build-fw')})
    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toContain(
      setting('.mikro/build-fw/partitions.csv'),
    )

    configure(dir)
    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toContain(setting('build/partitions.csv'))
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'sdkconfig pointing at the partition table of a deleted build dir is repointed',
  () => {
    const dir = makeProject('heal-deleted-build')
    writeFileSync(
      join(dir, 'sdkconfig'),
      'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="old/partitions.csv"\n',
    )

    configure(dir)

    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toContain(
      'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="build/partitions.csv"',
    )
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'sdkconfig pointing at a partitions.csv kept in the project is left alone',
  () => {
    const dir = makeProject('heal-kept-csv')
    write(join(dir, 'tables', 'partitions.csv'), '# Name, Type, SubType, Offset, Size\n')
    const before = 'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="tables/partitions.csv"\n'
    writeFileSync(join(dir, 'sdkconfig'), before)

    configure(dir)

    expect(readFileSync(join(dir, 'sdkconfig'), 'utf8')).toBe(before)
  },
  30_000,
)

test.skipIf(!hasCmake())(
  'a build dir outside the project gets an absolute path and no stray build/ in the source tree',
  () => {
    const dir = makeProject('external-build-src')
    const buildDir = join(fixtureDir, 'external-build-bin')

    configure(dir, {buildDir})

    const fragment = readFileSync(join(buildDir, 'sdkconfig.partitions'), 'utf8')
    const value = fragment.match(/CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="([^"]*)"/)?.[1] ?? ''
    expect(isAbsolute(value)).toBe(true)
    expect(existsSync(value)).toBe(true)
    expect(existsSync(join(dir, 'build'))).toBe(false)
  },
  30_000,
)

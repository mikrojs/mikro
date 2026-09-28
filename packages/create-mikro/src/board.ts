import fs from 'node:fs'
import path from 'node:path'

import type {PackageJson} from 'type-fest'

import {mikroCommand, type PkgManager, runCommand} from './pkg-manager.js'
import {devDependencies} from './templates/_common/dependencies.js'

export interface BoardScaffoldOptions {
  targetDir: string
  /** The package name, which is also the board's name: `my-board` or `@acme/devboard`. */
  packageName: string
  chip: string
  /** The chip as people write it, for the description: `ESP32-C6`. */
  chipLabel: string
  mikroVersion: string
  pkgManager: PkgManager
}

/** A board package with one board at `.`: see docs/develop/creating-boards.md. */
export function scaffoldBoard(options: BoardScaffoldOptions) {
  const {targetDir, packageName, chip, chipLabel, mikroVersion, pkgManager} = options
  const version = `^${mikroVersion}`

  fs.mkdirSync(targetDir, {recursive: true})
  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(targetDir, file), content)

  write(
    'package.json',
    JSON.stringify(
      {
        name: packageName,
        version: '0.1.0',
        description: `A development board with an ${chipLabel}`,
        type: 'module',
        exports: {
          '.': {firmware: './dist-fw/full/firmware.json'},
          './pins': './dist/pins.js',
          './tsconfig': './tsconfig.json',
        },
        // dist-fw is gitignored, so it must be listed to be published
        files: ['dist', 'dist-fw', 'tsconfig.json'],
        scripts: {
          build: 'tsc -p tsconfig.build.json',
          typecheck: 'tsc --noEmit',
          prepack: `${runCommand(pkgManager, 'build')} && mikro fw build`,
        },
        peerDependencies: {mikro: version},
        // `mikro fw build` resolves @mikrojs/firmware from the package
        devDependencies: {
          '@mikrojs/firmware': version,
          mikro: version,
          typescript: devDependencies.typescript,
        },
      } satisfies PackageJson,
      null,
      2,
    ) + '\n',
  )
  write('boards.config.ts', boardsConfig(chip))
  write('pins.ts', pins)
  // No "include": apps extend this preset, and paths in it are relative to the board package
  write('tsconfig.json', `{\n  "extends": "mikro/tsconfig/${chip}-generic"\n}\n`)
  write('tsconfig.build.json', tsconfigBuild)
  write('.gitignore', 'node_modules\ndist\ndist-fw\n.mikro\n')
  write('README.md', readme(packageName, pkgManager))
}

function boardsConfig(chip: string) {
  return `\
import {defineBoards} from 'mikro'

export default defineBoards({
  boards: {
    '.': {
      chip: '${chip}',
      // ESP-IDF settings the board needs, such as its flash size or PSRAM
      // sdkconfig: 'sdkconfig.defaults',
      // The native modules of the board's drivers, by the names apps import
      // nativeModules: ['@acme/drivers/panel'],
    },
  },
})
`
}

const pins = `\
// The board's pin names, as printed on the board, each a GPIO number
export const pins = {
  // D0: 1,
} as const
`

const tsconfigBuild = `\
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "sourceMap": false,
    "outDir": "dist"
  },
  "include": ["pins.ts"]
}
`

function readme(packageName: string, pm: PkgManager) {
  return `\
# ${packageName}

A [Mikro.js](https://mikrojs.dev) board package: firmware for the board, and its pin names for apps.

- \`boards.config.ts\`: the board's chip, ESP-IDF settings and native modules
- \`pins.ts\`: the board's pin names, each a GPIO number

## Build the firmware

Building needs [ESP-IDF](https://mikrojs.dev/develop/custom-firmware#prerequisites).

\`\`\`sh
${pm} install
${mikroCommand(pm, 'fw build --flash')}
\`\`\`

\`mikro fw build\` builds the image into \`dist-fw/\` and checks the package. With \`--flash\` it also flashes the connected board. Publishing runs it too, from the \`prepack\` script.

## Use the board in an app

\`\`\`sh
${pm} add ${packageName}
\`\`\`

\`\`\`ts
import {pins} from '${packageName}/pins'
\`\`\`

\`mikro flash\` in the app flashes this board's firmware. Apps can extend the board's TypeScript preset:

\`\`\`json
{
  "extends": "${packageName}/tsconfig",
  "include": ["./**/*"]
}
\`\`\`

See [Creating Boards](https://mikrojs.dev/develop/creating-boards).
`
}

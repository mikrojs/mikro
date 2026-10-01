import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import * as p from '@clack/prompts'
import {message} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {defineProgram} from '@optique/core/program'
import {run} from '@optique/run'

import {args} from './args.js'
import {scaffoldBoard} from './board.js'
import {projectNameProblem, targetDirProblem} from './folder.js'
import {printLogo} from './logo.js'
import {formatTargetDir, isValidPackageName, packageNameFor, toValidPackageName} from './names.js'
import {detectPkgManager, installCommand, mikroCommand} from './pkg-manager.js'
import {CHIPS, scaffold, TEMPLATES} from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = path.resolve(__dirname, '..', 'src', 'templates')

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string
}

type Chip = (typeof CHIPS)[number]

const CHIP_LABELS: Record<Chip, string> = {
  esp32: 'ESP32',
  esp32c3: 'ESP32-C3',
  esp32c5: 'ESP32-C5',
  esp32c6: 'ESP32-C6',
  esp32s3: 'ESP32-S3',
}

function exitCancelled(): never {
  p.cancel('Cancelled.')
  process.exit(0)
}

// Without a terminal there is no one to answer a prompt, so a script must give
// every answer.
function exitMissing(what: string, how: string): never {
  p.cancel(`No ${what} given. Pass it ${how}.`)
  process.exit(1)
}

/** The folder to create the project in: the argument, or asked for until the
 *  project can go there. */
async function askTargetDir(
  arg: string | undefined,
  placeholder: string,
  idf: boolean,
): Promise<string> {
  const cwd = process.cwd()
  const given = formatTargetDir(arg ?? '')
  if (given) {
    const problem = targetDirProblem(given, cwd, idf)
    if (problem) {
      p.cancel(problem)
      process.exit(1)
    }
    return given
  }
  if (!process.stdin.isTTY) exitMissing('project name', 'as an argument')
  // No name typed here could pass, so say it once instead of at every answer
  if (idf && cwd.includes(' ')) {
    p.cancel(
      `ESP-IDF can't build in a path with spaces: "${cwd}". Run this in a folder without them.`,
    )
    process.exit(1)
  }
  const name = await p.text({
    message: 'Project name',
    placeholder,
    defaultValue: placeholder,
    validate: (value = '') => projectNameProblem(value, placeholder, cwd, idf),
  })
  if (p.isCancel(name)) exitCancelled()
  return formatTargetDir(name) || placeholder
}

function checkChip(chip: string | undefined): asserts chip is Chip | undefined {
  if (chip !== undefined && !(CHIPS as readonly string[]).includes(chip)) {
    p.cancel(`Unknown chip "${chip}". Available chips: ${CHIPS.join(', ')}`)
    process.exit(1)
  }
}

async function askChip(): Promise<Chip> {
  if (!process.stdin.isTTY) exitMissing('chip', 'with --chip')
  const picked = await p.select({
    message: 'Select your ESP32 chip',
    initialValue: 'esp32c6' as const,
    options: CHIPS.map((c) => ({
      label: c === 'esp32c6' ? `${CHIP_LABELS[c]} (default)` : CHIP_LABELS[c],
      value: c,
    })),
  })
  if (p.isCancel(picked)) exitCancelled()
  return picked
}

/** `word` as the shell reads it: as it is when safe, else in single quotes. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`
}

/** Where `targetDir` puts the project and its package name, or exits when the
 *  name can't be made valid. */
async function resolveProject(targetDir: string) {
  const cwd = process.cwd()
  const root = path.resolve(cwd, targetDir)
  const isCwd = root === cwd

  let pkgName = packageNameFor(targetDir, cwd)
  if (!isValidPackageName(pkgName)) {
    const suggested = toValidPackageName(pkgName)
    if (process.stdin.isTTY) {
      const picked = await p.text({
        message: 'Package name',
        placeholder: suggested,
        defaultValue: suggested,
        validate: (value) =>
          isValidPackageName(value || suggested) ? undefined : 'Invalid package.json name',
      })
      if (p.isCancel(picked)) exitCancelled()
      pkgName = picked || suggested
    } else if (suggested) {
      pkgName = suggested
      p.log.info(`Using "${pkgName}" as the package name.`)
    } else {
      p.cancel(`"${pkgName}" can't be turned into a valid package name.`)
      process.exit(1)
    }
  }

  const cd = isCwd ? undefined : `cd ${shellQuote(targetDir)}`
  return {isCwd, pkgName, root, cd}
}

type Config = InferValue<typeof args>

async function createApp(config: Config): Promise<void> {
  const templateNames = TEMPLATES.map((t) => t.name)

  p.intro(`Create a new Mikro.js project (v${pkg.version})`)

  if (config.template !== undefined && !(templateNames as string[]).includes(config.template)) {
    p.cancel(
      `Unknown template "${config.template}". Available templates: ${templateNames.join(', ')}`,
    )
    process.exit(1)
  }

  checkChip(config.chip)

  // The folder first, as it depends on nothing else and may be refused
  const targetDir = await askTargetDir(config.name, 'my-mikrojs-project', config.firmware === true)
  const {isCwd, pkgName, root, cd} = await resolveProject(targetDir)

  let template = config.template
  if (template === undefined) {
    if (!process.stdin.isTTY) exitMissing('template', 'with --template')
    const picked = await p.select({
      message: 'Select a template',
      options: TEMPLATES.map((t) => ({
        label: t.name,
        hint: t.description,
        value: t.name,
      })),
    })
    if (p.isCancel(picked)) exitCancelled()
    template = picked
  }

  // Only a firmware project needs the chip: an app's is detected when it's
  // flashed.
  let chip = config.chip
  if (chip === undefined && config.firmware === true) chip = await askChip()

  const pm = detectPkgManager()

  scaffold({
    targetDir: root,
    template,
    projectName: pkgName,
    mikroVersion: pkg.version,
    templatesDir,
    pkgManager: pm,
    chip,
    firmware: config.firmware ?? false,
  })

  const templateMeta = TEMPLATES.find((t) => t.name === template)
  const steps: string[] = []
  if (cd) steps.push(cd)
  steps.push(installCommand(pm))
  steps.push('# connect your ESP32 via USB')
  if (config.firmware) {
    steps.push(mikroCommand(pm, `idf set-target ${chip}`))
    steps.push(mikroCommand(pm, 'idf build flash'))
  } else {
    steps.push(mikroCommand(pm, 'flash'))
  }
  if (templateMeta?.wifiSetup) {
    steps.push('# set WIFI_SSID and WIFI_PASSPHRASE — see README.md')
  }
  steps.push(mikroCommand(pm, 'dev'))

  p.note(steps.join('\n'), 'Next steps')

  p.outro(isCwd ? 'Project created in current directory.' : `Project created in ${targetDir}/`)
}

async function createBoard(config: Config): Promise<void> {
  p.intro(`Create a new Mikro.js board package (v${pkg.version})`)

  if (config.template !== undefined || config.firmware) {
    p.cancel('--board takes no --template or --firmware: a board package is always firmware.')
    process.exit(1)
  }

  checkChip(config.chip)

  // The folder first, as it depends on nothing else and may be refused
  const targetDir = await askTargetDir(config.name, 'my-board', true)
  const {isCwd, pkgName, root, cd} = await resolveProject(targetDir)

  const chip = config.chip ?? (await askChip())

  const pm = detectPkgManager()

  scaffoldBoard({
    targetDir: root,
    packageName: pkgName,
    chip,
    chipLabel: CHIP_LABELS[chip],
    mikroVersion: pkg.version,
    pkgManager: pm,
  })

  const steps: string[] = []
  if (cd) steps.push(cd)
  steps.push(installCommand(pm))
  steps.push("# name the board's pins in pins.ts, its settings in boards.config.ts")
  steps.push('# connect the board via USB')
  steps.push(mikroCommand(pm, 'fw build --flash'))

  p.note(steps.join('\n'), 'Next steps')

  p.outro(
    isCwd
      ? 'Board package created in current directory.'
      : `Board package created in ${targetDir}/`,
  )
}

const prog = defineProgram({
  parser: args,
  metadata: {
    name: 'create-mikro',
    version: pkg.version,
    author: message`Bjørge Næss <bjoerge@gmail.com>`,
    bugs: message`https://github.com/mikrojs/mikro/issues`,
  },
})

const config = run(prog, {
  help: 'both',
  version: 'both',
  args: process.argv.slice(2),
})

printLogo()

const created = config.board ? createBoard(config) : createApp(config)
created.catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import * as p from '@clack/prompts'
import {message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {argument, option} from '@optique/core/primitives'
import {defineProgram} from '@optique/core/program'
import {string} from '@optique/core/valueparser'
import {run} from '@optique/run'

import {printLogo} from './logo.js'
import {detectPkgManager, installCommand, mikroCommand} from './pkg-manager.js'
import {scaffold, TEMPLATES} from './scaffold.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatesDir = path.resolve(__dirname, '..', 'src', 'templates')

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string
}

const args = object({
  name: optional(argument(string({metavar: 'NAME'}))),
  template: optional(
    option('-t', '--template', string({metavar: 'TEMPLATE'}), {
      description: message`Template to use`,
    }),
  ),
})

const prog = defineProgram({
  parser: args,
  metadata: {
    name: 'create-mikro',
    version: pkg.version,
    author: message`Bjørge Næss <bjoerge@gmail.com>`,
    bugs: message`https://github.com/mikrojs/mikro/issues`,
  },
})

// Turn a human-friendly name like "My Project" into a valid npm
// package / directory name like "my-project". Returns '' if nothing
// usable remains.
function toValidProjectName(input: string): string {
  return input
    .normalize('NFKD') // decompose accents: "Ü" → "U" + combining mark
    .replace(/[\u0300-\u036f]/g, '') // strip the combining marks
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
}

async function main(config: InferValue<typeof args>): Promise<void> {
  const templateNames = TEMPLATES.map((t) => t.name)

  printLogo()

  p.intro(`Create a new Mikro.js project (v${pkg.version})`)

  const projectName =
    config.name ||
    ((await p.text({
      message: 'Project name',
      placeholder: 'my-mikrojs-project',
      defaultValue: 'my-mikrojs-project',
      validate: (value = '') => {
        if (!value.trim()) return 'Project name is required'
        if (value.trim() !== '.' && !toValidProjectName(value)) {
          return 'Project name must contain at least one letter or number'
        }
      },
    })) as string)

  if (p.isCancel(projectName)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  if (config.template && !(templateNames as string[]).includes(config.template)) {
    p.cancel(
      `Unknown template "${config.template}". Available templates: ${templateNames.join(', ')}`,
    )
    process.exit(1)
  }

  const template =
    config.template ||
    ((await p.select({
      message: 'Select a template',
      options: TEMPLATES.map((t) => ({
        label: t.name,
        hint: t.description,
        value: t.name,
      })),
    })) as string)

  if (p.isCancel(template)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const rawName = projectName.trim()
  const isCwd = rawName === '.' || path.resolve(process.cwd(), rawName) === process.cwd()
  const pkgName = toValidProjectName(isCwd ? path.basename(process.cwd()) : rawName)

  // The interactive prompt validates this, but a name passed as a CLI argument
  // skips that check, so guard here too.
  if (!pkgName) {
    p.cancel(`"${rawName}" can't be turned into a valid project name.`)
    process.exit(1)
  }

  const targetDir = isCwd ? process.cwd() : path.resolve(process.cwd(), pkgName)

  if (!isCwd && pkgName !== rawName) {
    const home = os.homedir()
    const displayPath = targetDir.startsWith(home + path.sep)
      ? `~${targetDir.slice(home.length)}`
      : targetDir
    p.log.info(`Using "${pkgName}" as the project name (created in ${displayPath}).`)
  }

  if (isCwd) {
    if (fs.existsSync(path.join(targetDir, 'package.json'))) {
      p.cancel('Current directory already contains a package.json.')
      process.exit(1)
    }
  } else if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    p.cancel(`Directory "${pkgName}" already exists and is not empty.`)
    process.exit(1)
  }

  const pm = detectPkgManager()

  scaffold({
    targetDir,
    template,
    projectName: pkgName,
    mikroVersion: pkg.version,
    templatesDir,
    pkgManager: pm,
  })

  const templateMeta = TEMPLATES.find((t) => t.name === template)
  const steps: string[] = []
  if (!isCwd) steps.push(`cd ${pkgName}`)
  steps.push(installCommand(pm))
  steps.push('# connect your ESP32 via USB')
  steps.push(mikroCommand(pm, 'flash'))
  if (templateMeta?.wifiSetup) {
    steps.push('# set WIFI_SSID and WIFI_PASSPHRASE — see README.md')
  }
  steps.push(mikroCommand(pm, 'dev'))

  p.note(steps.join('\n'), 'Next steps')

  p.outro(isCwd ? 'Project created in current directory.' : `Project created in ${pkgName}/`)
}

const config = run(prog, {
  help: 'both',
  version: 'both',
  args: process.argv.slice(2),
})

main(config).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})

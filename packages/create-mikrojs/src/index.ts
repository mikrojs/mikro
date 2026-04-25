import fs from 'node:fs'
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
import {detectPkgManager, installCommand} from './pkg-manager.js'
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
    name: 'create-mikrojs',
    version: pkg.version,
    author: message`Bjørge Næss <bjoerge@gmail.com>`,
    bugs: message`https://github.com/mikrojs/mikrojs/issues`,
  },
})

async function main(config: InferValue<typeof args>): Promise<void> {
  const templateNames = TEMPLATES.map((t) => t.name)

  printLogo()

  p.intro('Create a new Mikro.js project')

  const projectName =
    config.name ||
    ((await p.text({
      message: 'Project name',
      placeholder: 'my-mikrojs-project',
      defaultValue: 'my-mikrojs-project',
      validate: (value = '') => {
        if (!value.trim()) return 'Project name is required'
        if (/[^a-zA-Z0-9._-]/.test(value)) return 'Project name contains invalid characters'
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

  const typescript = await p.confirm({
    message: 'Use TypeScript?',
    initialValue: true,
  })

  if (p.isCancel(typescript)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const targetDir = path.resolve(process.cwd(), projectName)

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    p.cancel(`Directory "${projectName}" already exists and is not empty.`)
    process.exit(1)
  }

  const pm = detectPkgManager()

  scaffold({
    targetDir,
    template,
    projectName,
    mikrojsVersion: pkg.version,
    typescript,
    templatesDir,
    pkgManager: pm,
  })

  const mikro = pm === 'npm' ? 'npx mikro' : 'pnpm mikro'
  const steps = [`cd ${projectName}`, installCommand(pm), `${mikro} dev`]

  p.note(steps.join('\n'), 'Next steps')

  p.outro(`Project created in ${projectName}/`)
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

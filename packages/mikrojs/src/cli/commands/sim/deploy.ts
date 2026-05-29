/* eslint-disable no-console */
import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {lastValueFrom, tap} from 'rxjs'

import {agentEmit, agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {build} from '../../lib/build.js'
import {collectFiles, loadEnvFiles} from '../../lib/deploy.js'
import {formatDeployEvent} from '../../lib/deployProgress.js'
import {openSim} from '../../lib/openSim.js'
import {parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import {resolveEntry} from '../../lib/resolveEntry.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'

export const args = command(
  'deploy',
  object({
    subcommand: constant('deploy' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.simulator from the project root`,
      }),
    ),
    erase: optional(
      flag('-e', '--erase', {description: message`Erase current app before uploading`}),
    ),
    noRestart: optional(
      flag('--no-restart', {description: message`Do not restart sim after deploy`}),
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
    noBytecode: optional(flag('--no-bytecode', {description: message`Skip bytecode compilation`})),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
  {description: message`One-shot build + deploy to the simulator (no watch)`},
)

interface RunConfig {
  entry?: string
  env?: string
  noAutoEnv?: boolean
  erase?: boolean
  noRestart?: boolean
  noMinify?: boolean
  minifier?: string
  minifyLevel?: string
  noBytecode?: boolean
  json?: boolean
  agent?: boolean
}

export async function run(config: RunConfig): Promise<void> {
  const entry = resolveEntry(config.entry)
  const buildDir = pathlib.join(getMikroDir(), 'build')
  const minify = !config.noMinify
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)
  const bytecode = !config.noBytecode
  const doErase = config.erase === true
  const doRestart = !config.noRestart
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)

  try {
    log('Building…')
    await lastValueFrom(
      build(entry, buildDir, {minify, bytecode, minifier, minifyLevel, env: 'development'}),
      {defaultValue: undefined},
    )

    const files = await collectFiles(buildDir)
    const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0)
    log(`Built ${files.length} file(s), ${totalBytes} bytes total`)

    const envVars = [
      {key: 'MIKRO_ENV', value: 'simulator', secret: false},
      ...(await loadEnvFiles({
        cwd: resolveProjectRoot(),
        mode: 'simulator',
        envFile: config.env,
        noAutoEnv: config.noAutoEnv === true,
      })),
    ]

    log('Connecting to simulator…')
    const {session, transport} = await openSim({startDir: pathlib.dirname(entry)})

    try {
      const last = await lastValueFrom(
        session.deploy({files, envVars, erase: doErase, restart: doRestart}).pipe(
          tap((event) => {
            if (jsonOutput) {
              if (event.type === 'uploading' || event.type === 'checking') {
                agentEmit({
                  type: `deploy_${event.type}`,
                  file: event.file,
                  index: event.index,
                  total: event.total,
                })
              }
              return
            }
            const msg = formatDeployEvent(event)
            if (msg !== null) log(`  ${msg}`)
          }),
        ),
      )
      if (last.type !== 'complete') throw new Error('Deploy did not complete')
    } finally {
      session.close()
      transport.close()
    }

    if (jsonOutput) {
      agentResult(
        'sim deploy',
        {
          device: 'simulator',
          files: files.map((f) => ({path: f.path, size: f.data.length})),
          totalBytes,
        },
        [
          {command: 'mikro sim repl', description: 'Open a REPL on the simulator'},
          {command: 'mikro sim env list', description: 'List simulator env vars'},
        ],
      )
    } else {
      log(`Deployed ${files.length} file(s) to simulator`)
    }
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      if (jsonOutput) {
        agentError('sim deploy', err.message, {
          fix: 'Stop the running sim (Ctrl-C in that terminal), then retry.',
        })
      } else {
        console.error(`Error: ${err.message}`)
      }
      process.exit(1)
    }
    throw err
  }
}

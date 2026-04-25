import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import spinners from 'cli-spinners'
import {Text} from 'ink'
import React from 'react'
import {catchError, defer, EMPTY, exhaustMap, lastValueFrom} from 'rxjs'

import type {Minifier, MinifyLevel} from '../../../_exports/index.js'
import {agentEmit, agentError, agentResult, createAgentStdinReader} from '../../lib/agent.js'
import {build} from '../../lib/build.js'
import {collectFiles, loadEnvFiles} from '../../lib/deploy.js'
import {openSim} from '../../lib/openSim.js'
import {parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import {resolveEntry} from '../../lib/resolveEntry.js'
import {ReplConsole} from '../../lib/serial/ReplConsole.js'
import {createRepl, type ReplHandle} from '../../lib/serial/replStateMachine.js'
import type {ReplSession} from '../../lib/session.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'
import {Spinner} from '../../lib/Spinner.js'
import type {Transport} from '../../lib/transport.js'
import {createWatcher} from '../../lib/watcher.js'

export const args = command(
  'dev',
  object({
    subcommand: constant('dev' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
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
    env: optional(
      option('--env', string({metavar: 'FILE'}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    secrets: optional(
      option('--secrets', string({metavar: 'FILE'}), {
        description: message`Path to .env.secrets file with secrets`,
      }),
    ),
    noEnvFile: optional(
      flag('--no-env-file', {
        description: message`Skip auto-loading of .env and .env.simulator from the project root`,
      }),
    ),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
  {description: message`Watch + build + deploy to simulator with REPL`},
)

interface DevConfig {
  entry?: string
  noMinify?: boolean
  minifier?: string
  minifyLevel?: string
  noBytecode?: boolean
  env?: string
  secrets?: string
  noEnvFile?: boolean
  agent?: boolean
}

export async function run(config: DevConfig): Promise<void> {
  const entry = resolveEntry(config.entry)
  const buildDir = pathlib.join(getMikroDir(), 'build')
  const watchDir = process.cwd()
  const minify = !config.noMinify
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)
  const bytecode = !config.noBytecode

  let session: ReplSession
  let transport: Transport
  try {
    const conn = await openSim({claim: true, startDir: pathlib.dirname(entry)})
    session = conn.session
    transport = conn.transport
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      agentError('sim dev', err.message)
      process.exit(1)
    }
    throw err
  }

  session.messages$.subscribe((event) => {
    switch (event.type) {
      case 'ready':
        agentEmit({type: 'ready', chip: event.chip ?? null, id: event.id ?? null})
        break
      case 'prompt':
      case 'disconnect':
        break
      default:
        if ('text' in event) agentEmit({type: event.type, text: event.text})
        break
    }
  })

  async function doBuildAndDeploy() {
    agentEmit({type: 'status', status: 'building'})
    await lastValueFrom(build(entry, buildDir, {minify, bytecode, minifier, minifyLevel}), {
      defaultValue: undefined,
    })

    const allFiles = await collectFiles(buildDir)
    const envVars = [
      {key: 'MIKRO_ENV', value: 'simulator', secret: false},
      ...(await loadEnvFiles({
        cwd: resolveProjectRoot(),
        mode: 'simulator',
        envFile: config.env,
        secretsFile: config.secrets,
        noEnvFile: config.noEnvFile === true,
      })),
    ]

    agentEmit({type: 'status', status: 'deploying'})
    await lastValueFrom(session.deploy({files: allFiles, envVars, restart: true}))

    agentEmit({type: 'status', status: 'watching'})
  }

  try {
    await doBuildAndDeploy()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    agentError('sim dev', msg, {fix: 'Check entry file and try again'})
    process.exit(1)
  }

  process.on('exit', () => session.close())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  const {changes$, close: closeWatcher} = createWatcher(watchDir)
  changes$
    .pipe(
      exhaustMap(() =>
        defer(() => doBuildAndDeploy()).pipe(
          catchError((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            agentEmit({type: 'status', status: 'error', error: msg})
            return EMPTY
          }),
        ),
      ),
    )
    .subscribe()

  for await (const cmd of createAgentStdinReader()) {
    switch (cmd.type) {
      case 'eval':
        if (typeof cmd.code === 'string') session.eval(cmd.code)
        break
      case 'directive':
        if (typeof cmd.code === 'string') session.directive(cmd.code)
        break
      case 'complete':
        if (typeof cmd.partial === 'string') session.complete(cmd.partial)
        break
      case 'restart':
        session.restart()
        break
      case 'exit':
        session.exit()
        session.close()
        closeWatcher()
        transport.close()
        agentResult('sim dev', null, [])
        process.exit(0)
    }
  }
}

interface DevModeProps {
  entry: string
  minify: boolean
  bytecode: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  envFile?: string
  secretsFile?: string
  noEnvFile?: boolean
}

export default function SimDev(props: {args: DevConfig}) {
  const {args: cfg} = props
  const entry = resolveEntry(cfg.entry)
  return (
    <SimDevMode
      entry={entry}
      minify={!cfg.noMinify}
      bytecode={!cfg.noBytecode}
      minifier={parseMinifier(cfg.minifier)}
      minifyLevel={parseMinifyLevel(cfg.minifyLevel)}
      envFile={cfg.env}
      secretsFile={cfg.secrets}
      noEnvFile={cfg.noEnvFile === true}
    />
  )
}

function SimDevMode(props: DevModeProps) {
  const {entry, minify, bytecode, minifier, minifyLevel, envFile, secretsFile, noEnvFile} = props
  const buildDir = pathlib.join(getMikroDir(), 'build')
  const watchDir = process.cwd()

  const replRef = React.useRef<ReplHandle | null>(null)
  const [repl, setRepl] = React.useState<{
    handle: ReplHandle
    config: ReplSession['config']
  } | null>(null)
  const [error, setError] = React.useState<Error | null>(null)

  React.useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null

    void (async () => {
      let session: ReplSession
      let transport: Transport
      try {
        const conn = await openSim({claim: true, startDir: pathlib.dirname(entry)})
        session = conn.session
        transport = conn.transport
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err : new Error(String(err)))
        return
      }

      async function buildAndDeploy() {
        if (disposed) return
        if (replRef.current) replRef.current.setDisabled(true)
        setError(null)

        const envVars = [
          {key: 'MIKRO_ENV', value: 'simulator', secret: false},
          ...(await loadEnvFiles({
            cwd: resolveProjectRoot(),
            mode: 'simulator',
            envFile,
            secretsFile,
            noEnvFile,
          })),
        ]

        await lastValueFrom(build(entry, buildDir, {minify, bytecode, minifier, minifyLevel}), {
          defaultValue: undefined,
        })
        if (disposed) return

        const allFiles = await collectFiles(buildDir)

        const handle = createRepl({
          session,
          port: 'simulator',
          onEnd: () => process.exit(0),
        })
        handle.state$.subscribe()

        await lastValueFrom(session.deploy({files: allFiles, envVars, restart: true}))
        if (disposed) return

        replRef.current = handle
        if (!disposed) setRepl({handle, config: session.config})
      }

      buildAndDeploy().catch((err) => {
        if (!disposed) setError(err instanceof Error ? err : new Error(String(err)))
      })

      const {changes$, close} = createWatcher(watchDir)
      const sub = changes$
        .pipe(
          exhaustMap(() =>
            defer(() => buildAndDeploy()).pipe(
              catchError((err) => {
                if (!disposed) setError(err instanceof Error ? err : new Error(String(err)))
                return EMPTY
              }),
            ),
          ),
        )
        .subscribe()

      cleanup = () => {
        sub.unsubscribe()
        close()
        session.close()
        transport.close()
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [
    entry,
    buildDir,
    minify,
    bytecode,
    minifier,
    minifyLevel,
    envFile,
    secretsFile,
    noEnvFile,
    watchDir,
  ])

  if (error) {
    return <Text color="red">Error: {error.message}</Text>
  }

  if (!repl) {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Building…
      </Text>
    )
  }

  return <ReplConsole repl={repl.handle} config={repl.config} />
}

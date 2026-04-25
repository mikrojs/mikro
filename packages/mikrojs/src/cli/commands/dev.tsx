import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {useCallback} from 'react'
import {filter, firstValueFrom, map, Subject, type Subscription} from 'rxjs'

import {DevicePicker} from '../components/DevicePicker.js'
import {agentEmit} from '../lib/agent.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {resolveEntry} from '../lib/resolveEntry.js'
import {createDevSession, type DevSessionHandle} from '../lib/serial/devSession.js'
import {
  type InkReplDriverContext,
  type InkReplDriverResult,
  InkReplMode,
} from '../lib/serial/InkReplMode.js'
import {runAgentRepl} from '../lib/serial/runAgentRepl.js'

export const args = command(
  'dev',
  object({
    action: constant('dev'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    port: optional(
      option('-p', '--port', string({metavar: 'PORT'}), {
        description: message`Serial port of device`,
      }),
    ),
    forceDeploy: optional(
      flag('--force-deploy', {description: message`Force full deploy, ignoring cached checksums`}),
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
    noHooks: optional(
      flag('--no-hooks', {
        description: message`Skip mikrojs.predeploy hooks from package.json`,
      }),
    ),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
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
        description: message`Skip auto-loading of .env and .env.development from the project root`,
      }),
    ),
    noWatch: optional(
      flag('--no-watch', {
        description: message`Deploy once, then drop into the REPL without watching for file changes`,
      }),
    ),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
)

type Props = {
  args: InferValue<typeof args>
}

export async function run(config: InferValue<typeof args>) {
  const deploys$ = new Subject<{force: boolean}>()
  let dev: DevSessionHandle | null = null
  let stateSub: Subscription | null = null

  return runAgentRepl(
    {port: config.port},
    {
      command: 'dev',
      onReady: async ({session}) => {
        dev = createDevSession({
          session,
          entry: resolveEntry(config.entry),
          forceDeploy: config.forceDeploy === true,
          minify: !config.noMinify,
          bytecode: !config.noBytecode,
          watch: config.noWatch !== true,
          noHooks: config.noHooks === true,
          minifier: parseMinifier(config.minifier),
          minifyLevel: parseMinifyLevel(config.minifyLevel),
          logLevel: parseLogLevel(config.logLevel),
          envFile: config.env,
          secretsFile: config.secrets,
          noEnvFile: config.noEnvFile === true,
          externalDeploys$: deploys$.asObservable(),
        })

        // Translate DevSessionState transitions into agent NDJSON events.
        // Every distinct status emits exactly once; the state$ shareReplay
        // deduplicates identical re-emissions naturally.
        const idleStatus = config.noWatch === true ? 'idle' : 'watching'
        stateSub = dev.state$.subscribe((state) => {
          switch (state.status.type) {
            case 'checking':
              agentEmit({type: 'status', status: 'checking', command: state.status.command})
              break
            case 'building':
            case 'rebuilding':
              agentEmit({type: 'status', status: 'building'})
              break
            case 'deploying': {
              const event = state.status.event
              if (event.type === 'uploading' || event.type === 'checking') {
                agentEmit({
                  type: `deploy_${event.type}`,
                  file: event.file,
                  index: event.index,
                  total: event.total,
                })
              } else if (event.type === 'connecting') {
                agentEmit({type: 'status', status: 'deploying'})
              }
              break
            }
            case 'watching':
              agentEmit({type: 'status', status: idleStatus})
              break
            case 'error':
              agentEmit({type: 'status', status: 'error', error: state.status.message})
              break
          }
        })

        // Await the first non-building state to detect initial-deploy failure.
        // `watching` means the initial deploy succeeded; `error` means we
        // should exit(1) via the hook contract.
        await firstValueFrom(
          dev.state$.pipe(
            filter((s) => s.status.type === 'watching' || s.status.type === 'error'),
            map((s) => {
              if (s.status.type === 'error') throw new Error(s.status.message)
              return s
            }),
          ),
        )
      },
      onDeploy: (force) => deploys$.next({force}),
      onDispose: () => {
        stateSub?.unsubscribe()
        dev?.close()
      },
      nextActions: [
        {command: 'mikro deploy', description: 'Deploy to device'},
        {command: 'mikro console', description: 'Connect to device console'},
      ],
    },
  )
}

export default function Dev(props: Props) {
  const {port, noMinify, noBytecode, forceDeploy, noWatch, noHooks} = props.args
  const minifier = parseMinifier(props.args.minifier)
  const minifyLevel = parseMinifyLevel(props.args.minifyLevel)
  const logLevel = parseLogLevel(props.args.logLevel)
  const entry = resolveEntry(props.args.entry)

  const driver = useCallback(
    ({session, repl}: InkReplDriverContext): InkReplDriverResult => {
      const dev = createDevSession({
        session,
        repl,
        entry,
        forceDeploy: forceDeploy === true,
        minify: !noMinify,
        bytecode: !noBytecode,
        watch: noWatch !== true,
        noHooks: noHooks === true,
        minifier,
        minifyLevel,
        logLevel,
        envFile: props.args.env,
        secretsFile: props.args.secrets,
        noEnvFile: props.args.noEnvFile === true,
      })
      return {run$: dev.state$, dispose: () => dev.close()}
    },
    [
      entry,
      forceDeploy,
      noMinify,
      noBytecode,
      noWatch,
      noHooks,
      minifier,
      minifyLevel,
      logLevel,
      props.args.env,
      props.args.secrets,
      props.args.noEnvFile,
    ],
  )

  const watch = noWatch !== true

  return (
    <DevicePicker port={port}>
      {(device) => (
        <InkReplMode devicePath={device.path} logLevel={logLevel} driver={driver} watch={watch} />
      )}
    </DevicePicker>
  )
}

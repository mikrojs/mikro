import type {InferValue} from '@optique/core/parser'
import {useCallback} from 'react'
import {filter, firstValueFrom, map, Subject, type Subscription} from 'rxjs'

import {DevicePicker} from '../components/DevicePicker.js'
import {EntryGate} from '../components/EntryGate.js'
import {agentEmit} from '../lib/agent.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {resolveEntry} from '../lib/resolveEntry.js'
import {createDevSession, type DevSessionHandle} from '../lib/serial/devSession.js'
import {FirmwareGate} from '../lib/serial/FirmwareGate.js'
import {
  type InkReplDriverContext,
  type InkReplDriverResult,
  InkReplMode,
} from '../lib/serial/InkReplMode.js'
import {runAgentRepl} from '../lib/serial/runAgentRepl.js'
import type {args} from './dev.args.js'

type Props = {
  args: InferValue<typeof args>
}

export async function run(config: InferValue<typeof args>) {
  // Before the device: a missing entry is worth reporting whether or not one
  // is plugged in, and it is not a connection problem.
  const entry = resolveEntry(config.entry)
  const deploys$ = new Subject<{force: boolean}>()
  let dev: DevSessionHandle | null = null
  let stateSub: Subscription | null = null

  return runAgentRepl(
    {port: config.port, yes: config.yes === true},
    {
      command: 'dev',
      onReady: async ({session}) => {
        dev = createDevSession({
          session,
          entry,
          forceDeploy: config.forceDeploy === true,
          minify: !config.noMinify,
          bytecode: !config.noBytecode,
          watch: config.noWatch !== true,
          noHooks: config.noHooks === true,
          minifier: parseMinifier(config.minifier),
          minifyLevel: parseMinifyLevel(config.minifyLevel),
          logLevel: parseLogLevel(config.logLevel),
          envFile: config.env,
          noAutoEnv: config.noAutoEnv === true,
          externalDeploys$: deploys$.asObservable(),
          onNotice: (text) => agentEmit({type: 'warn', text}),
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
  return (
    <EntryGate entry={props.args.entry}>
      {(entry) => <DevMode args={props.args} entry={entry} />}
    </EntryGate>
  )
}

function DevMode(props: Props & {entry: string}) {
  const {port, noMinify, noBytecode, forceDeploy, noWatch, noHooks, yes} = props.args
  const minifier = parseMinifier(props.args.minifier)
  const minifyLevel = parseMinifyLevel(props.args.minifyLevel)
  const logLevel = parseLogLevel(props.args.logLevel)
  const {entry} = props

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
        noAutoEnv: props.args.noAutoEnv === true,
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
      props.args.noAutoEnv,
    ],
  )

  const watch = noWatch !== true

  return (
    <DevicePicker port={port}>
      {(device) => (
        <FirmwareGate devicePath={device.path} command="dev" yes={yes === true}>
          {(compat) => (
            <InkReplMode
              devicePath={device.path}
              serialNumber={device.serialNumber}
              logLevel={logLevel}
              driver={driver}
              watch={watch}
              compat={compat}
            />
          )}
        </FirmwareGate>
      )}
    </DevicePicker>
  )
}

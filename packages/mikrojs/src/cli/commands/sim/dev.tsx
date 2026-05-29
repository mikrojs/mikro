import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import spinners from 'cli-spinners'
import {Text, useApp, useInput} from 'ink'
import {useCallback, useEffect, useState} from 'react'
import {filter, firstValueFrom, map, Subject, type Subscription} from 'rxjs'

import {
  agentEmit,
  agentError,
  agentResult,
  createAgentStdinReader,
  forwardSessionToAgent,
} from '../../lib/agent.js'
import {openSim} from '../../lib/openSim.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {resolveEntry} from '../../lib/resolveEntry.js'
import {createDevSession, type DevSessionHandle} from '../../lib/serial/devSession.js'
import {InkReplConsole} from '../../lib/serial/InkReplConsole.js'
import {createRepl, type ReplHandle} from '../../lib/serial/replStateMachine.js'
import type {ReplSession} from '../../lib/session.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'
import {Spinner} from '../../lib/Spinner.js'
import type {Transport} from '../../lib/transport.js'

export const args = command(
  'dev',
  object({
    subcommand: constant('dev' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
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
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.simulator from the project root`,
      }),
    ),
    noWatch: optional(
      flag('--no-watch', {
        description: message`Deploy once, then drop into the REPL without watching for file changes`,
      }),
    ),
    agent: optional(flag('--agent', {description: message`NDJSON agent protocol over stdio`})),
  }),
  {description: message`Watch + build + deploy to simulator with REPL`},
)

interface DevConfig {
  entry?: string
  forceDeploy?: boolean
  noMinify?: boolean
  minifier?: string
  minifyLevel?: string
  noBytecode?: boolean
  noHooks?: boolean
  logLevel?: string
  env?: string
  noAutoEnv?: boolean
  noWatch?: boolean
  agent?: boolean
}

/**
 * Resolve the user's CLI args into the shape `createDevSession` expects.
 * `mode: 'simulator'` drives `MIKRO_ENV` and the auto-loaded `.env.simulator`
 * file, distinguishing sim runs from `mikro dev` (which defaults to
 * `'development'`).
 */
function devSessionOptions(config: DevConfig) {
  return {
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
    noAutoEnv: config.noAutoEnv === true,
    mode: 'simulator' as const,
  }
}

// ── Agent mode ─────────────────────────────────────────────────────

export async function run(config: DevConfig): Promise<void> {
  let session: ReplSession
  let transport: Transport
  try {
    const conn = await openSim({
      claim: true,
      startDir: pathlib.dirname(resolveEntry(config.entry)),
    })
    session = conn.session
    transport = conn.transport
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      agentError('sim dev', err.message)
      process.exit(1)
    }
    throw err
  }

  forwardSessionToAgent(session)

  const opts = devSessionOptions(config)
  const deploys$ = new Subject<{force: boolean}>()
  const dev = createDevSession({
    session,
    entry: opts.entry,
    forceDeploy: opts.forceDeploy,
    minify: opts.minify,
    bytecode: opts.bytecode,
    watch: opts.watch,
    noHooks: opts.noHooks,
    minifier: opts.minifier,
    minifyLevel: opts.minifyLevel,
    logLevel: opts.logLevel,
    envFile: opts.envFile,
    noAutoEnv: opts.noAutoEnv,
    externalDeploys$: deploys$.asObservable(),
    mode: opts.mode,
  })

  // Translate DevSessionState transitions into agent NDJSON events. Mirrors
  // mikro dev's run() so consumers (CI, scripts, AI agents) see the same
  // event stream regardless of target.
  const idleStatus = opts.watch ? 'watching' : 'idle'
  let stateSub: Subscription | null = dev.state$.subscribe((state) => {
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

  const dispose = () => {
    stateSub?.unsubscribe()
    stateSub = null
    dev.close()
    try {
      session.close()
    } catch {
      // already closed
    }
    try {
      transport.close()
    } catch {
      // already closed
    }
  }

  process.on('exit', dispose)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  // Await the first non-building state to detect initial-deploy failure.
  // Match mikro dev's contract: error on the initial path is fatal, exits
  // with non-zero so CI/scripts see a failure.
  try {
    await firstValueFrom(
      dev.state$.pipe(
        filter((s) => s.status.type === 'watching' || s.status.type === 'error'),
        map((s) => {
          if (s.status.type === 'error') throw new Error(s.status.message)
          return s
        }),
      ),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    agentError('sim dev', msg, {fix: 'Check entry file and try again'})
    process.exit(1)
  }

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
      case 'deploy':
        deploys$.next({force: cmd.force === true})
        break
      case 'exit':
        session.exit()
        dispose()
        agentResult('sim dev', null, [])
        process.exit(0)
    }
  }

  // stdin closed without explicit 'exit' — clean shutdown.
  dispose()
  agentResult('sim dev', null, [])
  process.exit(0)
}

// ── Ink (TUI) mode ─────────────────────────────────────────────────

interface DevModeProps {
  config: DevConfig
}

export default function SimDev(props: {args: DevConfig}) {
  return <SimDevMode config={props.args} />
}

/**
 * TUI counterpart of `run()`. Connects the simulator session, instantiates
 * `createDevSession` (the same state machine `mikro dev` uses), and renders
 * the REPL once the initial deploy completes.
 *
 * Initial-setup errors (sim subprocess fails to start, first build/deploy
 * fails) are fatal — there's nothing for the watcher to fall back to.
 * Watch-mode rebuild errors stay in the TUI so the user can fix the file
 * and let the watcher retry.
 */
function SimDevMode(props: DevModeProps) {
  const {config} = props
  const opts = devSessionOptions(config)

  // We mount the REPL UI as soon as the sim session+repl handle exist, BEFORE
  // the first deploy completes. This matches the device-side InkReplMode flow
  // and is required for correctness: the REPL state machine's awaitReady$
  // / connectionTimeout$ only fire when `repl.state$` has a subscriber. If
  // the REPL UI doesn't mount until after the first deploy, the state
  // machine never gets to poll CMD_HELLO during the deploy window and
  // ends up timing out the moment it does finally mount (because by then
  // multiple restarts have happened).
  const [conn, setConn] = useState<{
    session: ReplSession
    transport: Transport
    repl: ReplHandle
    dev: DevSessionHandle
  } | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const fatal = useCallback((err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${msg}\n`)
    process.exit(1)
  }, [])

  const handleEnd = useCallback(() => {
    process.stdout.write('\x1b[<u')
    process.exit(0)
  }, [])

  // Ink's `exitOnCtrlC` is disabled at the cli.ts render call; until the REPL
  // is mounted (or while an error screen is showing), nothing else handles
  // input — without this, ctrl-c is a black hole. Matches DevicePicker /
  // InkReplMode / deploy convention (ctrl-c or ctrl-q).
  const {exit: exitInk} = useApp()
  useInput(
    (input, key) => {
      if (key.ctrl && (input === 'c' || input === 'q')) {
        exitInk()
        process.exit(error ? 1 : 0)
      }
    },
    {isActive: !conn},
  )

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null

    void (async () => {
      let session: ReplSession
      let transport: Transport
      try {
        const handle = await openSim({
          claim: true,
          startDir: pathlib.dirname(opts.entry),
        })
        session = handle.session
        transport = handle.transport
      } catch (err) {
        if (!disposed) fatal(err)
        return
      }
      if (disposed) {
        try {
          session.close()
          transport.close()
        } catch {
          // already closed
        }
        return
      }

      const repl = createRepl({
        session,
        port: 'simulator',
        onEnd: handleEnd,
        deployEnabled: true,
      })

      const dev = createDevSession({
        session,
        repl,
        entry: opts.entry,
        forceDeploy: opts.forceDeploy,
        minify: opts.minify,
        bytecode: opts.bytecode,
        watch: opts.watch,
        noHooks: opts.noHooks,
        minifier: opts.minifier,
        minifyLevel: opts.minifyLevel,
        logLevel: opts.logLevel,
        envFile: opts.envFile,
        noAutoEnv: opts.noAutoEnv,
        mode: opts.mode,
      })

      // Mount the REPL UI immediately so the state machine starts polling
      // CMD_HELLO and the `connectionTimeout$` can be cancelled by the first
      // MSG_READY. createDevSession's run is kept alive by the stateSub
      // subscription below; rendering the REPL is purely a UI concern.
      setConn({session, transport, repl, dev})

      const stateSub = dev.state$.subscribe((state) => {
        if (state.status.type === 'error') {
          // Surface in TUI; the watcher can recover by re-running on next
          // file change, so we keep the session alive.
          if (!disposed) setError(new Error(state.status.message))
        } else if (state.status.type === 'watching' || state.status.type === 'deploying') {
          if (!disposed) setError(null)
        }
      })

      cleanup = () => {
        stateSub.unsubscribe()
        dev.close()
        try {
          session.close()
        } catch {
          // already closed
        }
        try {
          transport.close()
        } catch {
          // already closed
        }
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
    // opts is recomputed each render but its values are stable for a given
    // config (which itself is stable for a session). Deps captured so React
    // doesn't complain; effective re-runs only happen on real config change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    opts.entry,
    opts.forceDeploy,
    opts.minify,
    opts.bytecode,
    opts.watch,
    opts.noHooks,
    opts.minifier,
    opts.minifyLevel,
    opts.logLevel,
    opts.envFile,
    opts.noAutoEnv,
  ])

  if (error && !conn) {
    return <Text color="red">Error: {error.message}</Text>
  }

  if (!conn) {
    return (
      <Text>
        <Spinner spinner={spinners.dots} /> Starting simulator…
      </Text>
    )
  }

  return (
    <InkReplConsole
      session={conn.session}
      devicePath="simulator"
      logLevel={opts.logLevel}
      repl={conn.repl}
      watch={opts.watch}
    />
  )
}

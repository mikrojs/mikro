import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {useInput} from 'ink'
import React, {useEffect, useState} from 'react'
import {lastValueFrom, tap} from 'rxjs'

import {DevicePicker} from '../components/DevicePicker.js'
import type {PortInfo} from '../hooks/useDevices.js'
import {agentEmit, agentResult, isAgentMode} from '../lib/agent.js'
import {build} from '../lib/build.js'
import {collectFiles, loadEnvFiles, validateNvsKeys} from '../lib/deploy.js'
import {formatDeployEvent} from '../lib/deployProgress.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {port} from '../lib/portValueParser.js'
import {getMikroDir, resolveProjectRoot} from '../lib/projectRoot.js'
import {resolveEntry} from '../lib/resolveEntry.js'
import {getPredeployCommands, runHooks} from '../lib/runHooks.js'
import {InkReplConsole} from '../lib/serial/InkReplConsole.js'
import {openSession} from '../lib/serial/openSession.js'
import type {ReplSession} from '../lib/session.js'

export const args = command(
  'deploy',
  object({
    action: constant('deploy'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device to deploy to`,
      }),
    ),
    console: optional(
      flag('--console', {
        description: message`Attach console after deploy and restart device`,
      }),
    ),
    erase: optional(
      flag('-e', '--erase', {
        description: message`Erase current app before uploading`,
      }),
    ),
    force: optional(
      flag('-f', '--force', {
        description: message`Force full upload, ignoring cached checksums`,
      }),
    ),
    env: optional(
      option('--env', string({metavar: 'FILE'}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noEnvFile: optional(
      flag('--no-env-file', {
        description: message`Skip auto-loading of .env and .env.production from the project root`,
      }),
    ),
    noRestart: optional(
      flag('--no-restart', {
        description: message`Do not restart device after deploy`,
      }),
    ),
    recover: optional(
      flag('--recover', {
        description: message`Reset the device into safe mode before deploying. Use when the deployed app is crash-looping.`,
      }),
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
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)

type Props = {
  args: InferValue<typeof args>
}

/**
 * Non-Ink deploy: runs as a plain async function. With `--console`, returns
 * the session + devicePath so the caller can attach `InkReplConsole`; the
 * session is intentionally not closed here in that case — the Ink-mode
 * REPL owns it for its lifetime and cleanup happens on `process.exit`.
 */
export async function run(
  config: InferValue<typeof args>,
): Promise<{session: ReplSession; devicePath: string} | null> {
  const entry = resolveEntry(config.entry)
  const buildDir = pathlib.join(getMikroDir(), 'build')
  const doMinify = !config.noMinify
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)
  const logLevel = parseLogLevel(config.logLevel) ?? 'warn'
  const doBytecode = !config.noBytecode
  const doErase = config.erase === true
  const doForce = config.force === true
  const doRestart = !config.noRestart
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  // eslint-disable-next-line no-console
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)

  // Run pre-deploy hooks (tsc, eslint, etc.) declared in package.json.
  if (config.noHooks !== true) {
    const projectRoot = resolveProjectRoot()
    const commands = getPredeployCommands(projectRoot)
    if (commands.length > 0) {
      log(`Running ${commands.length} pre-deploy hook(s)…`)
      await lastValueFrom(
        runHooks(commands, projectRoot).pipe(
          tap((event) => {
            if (event.type === 'start') log(`  $ ${event.command}`)
            else if (event.type === 'stdout' || event.type === 'stderr') {
              process.stderr.write(event.chunk)
            }
          }),
        ),
        {defaultValue: undefined},
      )
    }
  }

  // Build
  log('Building…')
  await lastValueFrom(
    build(entry, buildDir, {
      minify: doMinify,
      bytecode: doBytecode,
      minifier,
      minifyLevel,
      logLevel,
    }),
    {defaultValue: undefined},
  )

  // Collect files
  const files = await collectFiles(buildDir)
  const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0)
  log(`Built ${files.length} file(s), ${totalBytes} bytes total`)

  // Load env vars
  const envVars = [
    {key: 'MIKRO_ENV', value: 'production', secret: false},
    ...(await loadEnvFiles({
      cwd: resolveProjectRoot(),
      mode: 'production',
      envFile: config.env,
      noEnvFile: config.noEnvFile === true,
    })),
  ]
  validateNvsKeys(envVars)
  if (envVars.length > 0) {
    const envCount = envVars.filter((v) => !v.secret).length
    const secretCount = envVars.filter((v) => v.secret).length
    if (envCount > 0) log(`Loaded ${envCount} env variable(s)`)
    if (secretCount > 0) log(`Loaded ${secretCount} secret(s)`)
  }

  // Connect to device
  const handles = await openSession({
    port: config.port,
    recover: config.recover === true,
    onConnecting: (path) => {
      log(`Connecting to ${path}…`)
      if (config.recover) log('Triggering safe mode…')
    },
  })
  const {session, devicePath} = handles

  try {
    const last = await lastValueFrom(
      session
        .deploy({
          files,
          envVars,
          erase: doErase,
          force: doForce,
          restart: doRestart,
        })
        .pipe(
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
    if (!config.console) handles.close()
  }

  if (jsonOutput) {
    agentResult(
      'deploy',
      {
        device: devicePath,
        files: files.map((f) => ({path: f.path, size: f.data.length})),
        totalBytes,
      },
      [
        {command: `mikro console -p ${devicePath}`, description: 'Connect to device console'},
        {command: 'mikro deploy --console', description: 'Deploy and attach console'},
        {command: `mikro env list -p ${devicePath}`, description: 'List device env vars'},
      ],
    )
  } else {
    log(`Deployed ${files.length} file(s) to ${devicePath}`)
  }

  if (config.console) {
    return {session, devicePath}
  }
  return null
}

/**
 * Ink component for deploy with interactive device selection.
 * Handles both plain deploy and --console mode.
 */
export default function Deploy(props: Props) {
  const {args: config} = props

  return (
    <DevicePicker port={config.port}>
      {(device) => <DeployInner config={config} device={device} />}
    </DevicePicker>
  )
}

function DeployInner({config, device}: {config: InferValue<typeof args>; device: PortInfo}) {
  const [session, setSession] = useState<ReplSession | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    run({...config, port: device.path}).then(
      (result) => {
        if (result) setSession(result.session)
        else process.exit(0)
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }, [config, device.path])

  // Ctrl+C / Ctrl+Q while the deploy is still running (no REPL yet).
  useInput(
    (_ch, key) => {
      if (key.ctrl && (_ch === 'c' || _ch === 'q')) process.exit(0)
    },
    {isActive: !session},
  )

  // Exit-on-error as a side effect, not inside render. Calling console.error
  // + process.exit during render triggers React's "nested component updates
  // from render" warning because Ink re-renders in response to stderr writes
  // and the scheduled exit.
  useEffect(() => {
    if (!error) return
    // eslint-disable-next-line no-console
    console.error(`Error: ${error}`)
    process.exit(1)
  }, [error])

  if (error) return null
  if (!session) return null

  return <InkReplConsole session={session} devicePath={device.path} />
}

/* eslint-disable no-console */
import {mkdir, writeFile} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {filter, map, tap} from 'rxjs'

import type {LogLevel} from '../../_exports/index.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {logLevelAllows, parseLogLevel} from '../lib/parseMinifier.js'
import {port} from '../lib/portValueParser.js'
import {openSession} from '../lib/serial/openSession.js'
import type {ReplEvent} from '../lib/session.js'

const portOption = optional(
  option('-p', '--port', port(), {
    description: message`Serial port of device`,
  }),
)

const pullArgs = command(
  'pull',
  objectConstruct({
    subcommand: constant('pull' as const),
    dest: optional(argument(string({metavar: 'DEST'}))),
    port: portOption,
  }),
)

const tailArgs = command(
  'tail',
  objectConstruct({
    subcommand: constant('tail' as const),
    port: portOption,
    restart: optional(flag('-r', '--restart', {description: message`Restart the device first`})),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Drop device output below this level: none, error, warn, info, debug (default: debug)`,
      }),
    ),
  }),
)

const resetArgs = command(
  'reset',
  objectConstruct({
    subcommand: constant('reset' as const),
    port: portOption,
  }),
)

export const args = command(
  'logs',
  objectConstruct({
    action: constant('logs'),
    sub: orConstruct(pullArgs, tailArgs, resetArgs),
  }),
)

/** Mirror of the default in serializeRuntimeConfig — keep in sync. */
const DEFAULT_LOG_DIR = '/appfs/logs'

function formatTailEvent(event: ReplEvent, logLevel: LogLevel): string | null {
  switch (event.type) {
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
      return logLevelAllows(logLevel, event.type) ? event.text : null
    case 'eval_error':
      return event.text
    case 'raw':
      return event.text.trim().length > 0 ? event.text : null
    default:
      return null
  }
}

async function runTail(sub: {
  port: string | undefined
  restart: true | undefined
  logLevel: string | undefined
}): Promise<void> {
  const logLevel = parseLogLevel(sub.logLevel) ?? 'debug'
  // Diagnostics: read the device's output even if its firmware version is
  // out of range — pulling logs off a mismatched unit is the whole point.
  const handles = await openSession({port: sub.port, compat: 'best-effort'})

  if (sub.restart) {
    handles.session.restart()
  }

  handles.session.messages$
    .pipe(
      map((event) => formatTailEvent(event, logLevel)),
      filter((line): line is string => line !== null),
      tap((line) => process.stdout.write(line + '\n')),
    )
    .subscribe()

  process.on('exit', () => handles.close())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  await new Promise(() => {})
}

async function runPull(sub: {dest: string | undefined; port: string | undefined}): Promise<void> {
  const {dest, port} = sub

  // Logs are pulled from a deployed device, which was built in production
  // mode — resolve the same env override so logFile.dir matches what's on flash.
  const mikroConfig = await loadMikroConfig(process.cwd(), 'production')
  const logFile = mikroConfig?.logFile
  if (!logFile) {
    console.error(
      `No file logging configured. Add \`logFile: true\` (or \`logFile: {…}\`) to mikro.config.ts.`,
    )
    process.exit(1)
  }
  const logDir = logFile === true ? DEFAULT_LOG_DIR : (logFile.dir ?? DEFAULT_LOG_DIR)
  const mainPath = `${logDir}/log.txt`
  const rotatedPath = `${mainPath}.1`

  // Best-effort: a deployed unit on older firmware should still surrender
  // its logs (see runTail).
  const handles = await openSession({port, compat: 'best-effort'})
  try {
    if (dest === undefined) {
      /* Stream to stdout. Pull older rotated generation first so the dump
       * is chronological, then the current file. Don't write status to
       * stdout — that would corrupt the log output for downstream
       * consumers (less/grep/etc.). */
      try {
        const rotated = await handles.session.fsGet(rotatedPath)
        process.stdout.write(rotated)
      } catch {
        // No rotated file — fall through to current.
      }
      const main = await handles.session.fsGet(mainPath)
      process.stdout.write(main)
      return
    }

    await mkdir(dest, {recursive: true})
    const mainBody = await handles.session.fsGet(mainPath)
    const mainOut = pathlib.join(dest, 'log.txt')
    await writeFile(mainOut, mainBody)
    console.log(`${mainOut}\t${mainBody.length} bytes`)

    /* Rotated generation, if present. The device returns an open-failed
     * error when it doesn't exist — treat that as "nothing to pull". */
    try {
      const rotatedBody = await handles.session.fsGet(rotatedPath)
      const rotatedOut = pathlib.join(dest, 'log.txt.1')
      await writeFile(rotatedOut, rotatedBody)
      console.log(`${rotatedOut}\t${rotatedBody.length} bytes`)
    } catch {
      // No rotated file — done.
    }
  } finally {
    handles.close()
  }
}

async function runReset(sub: {port: string | undefined}): Promise<void> {
  // A deployed unit was built in production mode; resolve the same env
  // override so we gate on the same logFile config the device was flashed with.
  const mikroConfig = await loadMikroConfig(process.cwd(), 'production')
  if (!mikroConfig?.logFile) {
    console.error(
      `No file logging configured. Add \`logFile: true\` (or \`logFile: {…}\`) to mikro.config.ts.`,
    )
    process.exit(1)
  }

  // Best-effort: a deployed unit on older firmware should still accept the
  // reset (see runTail/runPull).
  const handles = await openSession({port: sub.port, compat: 'best-effort'})
  try {
    await handles.session.logsReset()
    console.log('Logs cleared')
  } finally {
    handles.close()
  }
}

export async function run(config: InferValue<typeof args>): Promise<void> {
  if (config.sub.subcommand === 'tail') {
    await runTail(config.sub)
  } else if (config.sub.subcommand === 'pull') {
    await runPull(config.sub)
  } else if (config.sub.subcommand === 'reset') {
    await runReset(config.sub)
  }
}

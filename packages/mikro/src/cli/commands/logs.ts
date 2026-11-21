/* eslint-disable no-console */
import {mkdir, writeFile} from 'node:fs/promises'
import * as pathlib from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'

import type {InferValue} from '@optique/core/parser'
import {filter, lastValueFrom, map, takeWhile, tap} from 'rxjs'

import type {LogLevel} from '../../_exports/index.js'
import {DeviceNotFoundError} from '../lib/deploy.js'
import {deviceLabel} from '../lib/deviceLabel.js'
import {deviceDisplayName} from '../lib/deviceName.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {logLevelAllows, parseLogLevel} from '../lib/parseMinifier.js'
import {openSession, type SessionHandles} from '../lib/serial/openSession.js'
import type {ReplEvent} from '../lib/session.js'
import {PortOpenError} from '../lib/transport.js'
import {TROUBLESHOOTING_URL} from '../lib/troubleshooting.js'
import type {args} from './logs.args.js'

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

/** Interval between scans for the device while the tail waits for it. */
const PORT_SCAN_INTERVAL_MS = 100
/** How long a connected port may refuse to open before the tail gives up. A
 * port can be listed a moment before the OS lets a program open it. */
const PORT_OPEN_GRACE_MS = 2000
/** How long the tail waits for its first connection before it links to the
 * troubleshooting page. */
const TROUBLESHOOTING_HINT_MS = 10_000

/** Opens a session with the device, waiting until it is connected. Status goes
 * to stderr, so a piped tail holds device output only. */
async function openWhenConnected(
  port: string | undefined,
  /** Names the device in the status lines. */
  label: string | undefined,
  /** Other devices already reported, so each is reported once per run. */
  reported: Set<string>,
  /** Link to the troubleshooting page if the wait is long. */
  hint: boolean,
): Promise<SessionHandles> {
  let announced = false
  let openDeadline: number | undefined
  let hintAt = hint ? Date.now() + TROUBLESHOOTING_HINT_MS : Infinity
  for (;;) {
    try {
      const handles = await openSession({port, compat: 'best-effort'})
      if (announced) {
        const device = {path: handles.devicePath, serialNumber: handles.serialNumber}
        process.stderr.write(`Connected to ${deviceLabel(device)} on ${device.path}\n`)
      }
      return handles
    } catch (err) {
      if (err instanceof DeviceNotFoundError) {
        openDeadline = undefined
        if (!announced) {
          announced = true
          process.stderr.write(`Waiting for ${label ?? 'a device'}…\n`)
        }
        // A connected device that is not the one named shows a mistyped --port.
        for (const device of err.devices) {
          const key = device.serialNumber ?? device.path
          if (reported.has(key)) continue
          reported.add(key)
          process.stderr.write(`Found another device: ${deviceLabel(device)} on ${device.path}\n`)
        }
        if (Date.now() >= hintAt) {
          hintAt = Infinity
          process.stderr.write(
            `Still waiting for ${label ?? 'a device'}. See ${TROUBLESHOOTING_URL} for help.\n`,
          )
        }
      } else if (err instanceof PortOpenError) {
        openDeadline ??= Date.now() + PORT_OPEN_GRACE_MS
        if (Date.now() > openDeadline) throw err
      } else {
        throw err
      }
    }
    await sleep(PORT_SCAN_INTERVAL_MS)
  }
}

async function runTail(sub: {
  port: string | undefined
  restart: true | undefined
  logLevel: string | undefined
}): Promise<void> {
  const logLevel = parseLogLevel(sub.logLevel) ?? 'debug'
  let handles: SessionHandles | undefined
  let restart = sub.restart
  let port = sub.port
  let label = sub.port
  let connected = false
  const reported = new Set<string>()

  process.on('exit', () => handles?.close())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  // Runs until interrupted. A device that is not connected, or that disconnects,
  // is waited for: one in deep sleep on its USB port is gone until it wakes.
  for (;;) {
    // Diagnostics: read the device's output even if its firmware version is
    // out of range — pulling logs off a mismatched unit is the whole point.
    handles = await openWhenConnected(port, label, reported, !connected)
    connected = true

    // Stay on this device from here on: by its serial number, since another
    // board can take its port, or be the only one connected while it sleeps.
    if (handles.serialNumber !== undefined) {
      port = handles.serialNumber
      label = deviceDisplayName(handles.serialNumber)
    }

    if (restart) {
      restart = undefined
      handles.session.restart()
    }

    await lastValueFrom(
      handles.session.messages$.pipe(
        tap((event) => {
          if (event.type === 'disconnect' && event.error !== undefined) {
            process.stderr.write(`The device disconnected: ${event.error}\n`)
          }
        }),
        takeWhile((event) => event.type !== 'disconnect'),
        map((event) => formatTailEvent(event, logLevel)),
        filter((line): line is string => line !== null),
        tap((line) => process.stdout.write(line + '\n')),
      ),
      {defaultValue: undefined},
    )
    handles.close()
  }
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

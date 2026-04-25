import * as readline from 'node:readline/promises'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import figures from 'figures'
import {filter, firstValueFrom} from 'rxjs'
import {SerialPort} from 'serialport'

import {BAUD_RATE, resolvePort} from '../lib/deploy.js'
import {triggerSafeMode} from '../lib/recover.js'
import {connectRepl, type ReplSession} from '../lib/session.js'
import {createSerialTransport} from '../lib/transport.js'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

export const args = command(
  'clean',
  object({
    action: constant('clean'),
    port: optional(
      option('-p', '--port', string({metavar: 'PORT'}), {
        description: message`Serial port of device`,
      }),
    ),
    full: optional(
      flag('--full', {
        description: message`Remove all files and environment variables (not just the deployed app)`,
      }),
    ),
    recover: optional(
      flag('--recover', {
        description: message`Reset the device into safe mode before cleaning. Use when the deployed app is crash-looping.`,
      }),
    ),
    yes: optional(
      flag('-y', '--yes', {
        description: message`Skip confirmation prompt`,
      }),
    ),
  }),
  {description: message`Remove deployed app from device`},
)

export async function run(config: InferValue<typeof args>): Promise<void> {
  const isFull = config.full === true
  const skipConfirm = config.yes === true
  const doRecover = config.recover === true
  await cleanDevice(config.port, isFull, skipConfirm, doRecover)
}

async function cleanDevice(
  portOption: string | undefined,
  full: boolean,
  skipConfirm: boolean,
  recover: boolean,
): Promise<void> {
  if (full && !skipConfirm) {
    const confirmed = await confirm(
      'This will delete all files and environment variables on the device.',
    )
    if (!confirmed) return
  }

  const devicePath = await resolvePort(portOption)
  log(dim(`Connecting to ${devicePath}…`))

  const serial = new SerialPort({path: devicePath, baudRate: BAUD_RATE, autoOpen: false})
  await new Promise<void>((resolve, reject) => {
    serial.open((err) => (err ? reject(err) : resolve()))
  })
  // IMPORTANT: create the session BEFORE triggerSafeMode so connectRepl's
  // eager subscription is listening when the post-reset MSG_READY arrives.
  // If we reverse the order, the bytes from the device's boot phase reach
  // node-serialport before any listener exists and get dropped on the floor.
  const transport = createSerialTransport(serial)
  const session = connectRepl(transport)
  if (recover) {
    log(dim('Triggering safe mode…'))
    await triggerSafeMode(serial)
  }

  try {
    if (full) {
      await cleanDeviceFull(session)
    } else {
      await cleanDeviceApp(session)
    }

    log(`${green(figures.tick)} Device restarted`)
  } catch (err) {
    log(`${red(figures.cross)} ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  } finally {
    session.close()
    serial.close()
  }
}

async function cleanDeviceApp(session: ReplSession): Promise<void> {
  // Direct ERASE + DONE (no empty deploy staging, no .checksums stub)
  await session.eraseApp({restart: true})
  log(`${green(figures.tick)} Removed deployed app`)
}

async function cleanDeviceFull(session: ReplSession): Promise<void> {
  // First, clear env vars via config API
  const entries = await session.config.list()
  for (const entry of entries) {
    await session.config.delete(entry.key)
  }
  log(`${green(figures.tick)} Cleared environment variables`)

  // Delete non-/app files via eval (since /app is read-only from JS).
  // Uses dynamic import() because the REPL evaluates as global script, not module.
  await evalAndWait(
    session,
    `(async () => {
    const {unlink, readDir, rmdir, stat} = await import('mikrojs/fs')
    function safeName(name) {
      return name && !name.includes('/') && name !== '.' && name !== '..'
    }
    function rmrf(path) {
      const s = stat(path)
      if (!s.ok) return
      if (s.value.isDirectory) {
        const entries = readDir(path)
        if (entries.ok) {
          for (const entry of entries.value) {
            if (safeName(entry.name)) rmrf(path + '/' + entry.name)
          }
        }
        rmdir(path)
      } else {
        unlink(path)
      }
    }
    const root = readDir('/')
    if (root.ok) {
      for (const entry of root.value) {
        if (safeName(entry.name) && entry.name !== 'app') {
          rmrf('/' + entry.name)
        }
      }
    }
  })()`,
  )
  log(`${green(figures.tick)} Removed all files`)

  // Erase the read-only /app directory + restart
  await session.eraseApp({restart: true})
}

/** Eval JS on device and wait for the result (or error) indicating completion */
async function evalAndWait(session: ReplSession, code: string): Promise<void> {
  const done = firstValueFrom(
    session.messages$.pipe(filter((e) => e.type === 'result' || e.type === 'eval_error')),
  )
  session.eval(code)
  await done
}

async function confirm(msg: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log(red('Error: --full requires confirmation. Use -y to skip in non-interactive mode.'))
    process.exit(1)
  }
  const rl = readline.createInterface({input: process.stdin, output: process.stderr})
  try {
    log(`${yellow(figures.warning)} ${msg}`)
    const answer = await rl.question('Continue? (y/N) ')
    return answer.toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

// eslint-disable-next-line no-console
const log = (msg: string) => console.error(msg)

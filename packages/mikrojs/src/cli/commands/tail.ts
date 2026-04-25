import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import type {LogLevel} from '../../_exports/index.js'
import {logLevelAllows, parseLogLevel} from '../lib/parseMinifier.js'
import {openSession} from '../lib/serial/openSession.js'
import type {ReplEvent} from '../lib/session.js'

export const args = command(
  'tail',
  object({
    action: constant('tail'),
    port: optional(
      option('-p', '--port', string({metavar: 'PORT'}), {
        description: message`Serial port to connect to, example: /dev/cu.usbmodem101`,
      }),
    ),
    restart: optional(flag('-r', '--restart', {description: message`Restart the device first`})),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Drop device output below this level: none, error, warn, info, debug (default: debug)`,
      }),
    ),
  }),
)

function formatEvent(event: ReplEvent, logLevel: LogLevel): string | null {
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

export async function run(config: InferValue<typeof args>) {
  const logLevel = parseLogLevel(config.logLevel) ?? 'debug'
  const handles = await openSession({port: config.port})

  if (config.restart) {
    handles.session.restart()
  }

  handles.session.messages$.subscribe((event) => {
    const line = formatEvent(event, logLevel)
    if (line !== null) {
      process.stdout.write(line + '\n')
    }
  })

  process.on('exit', () => handles.close())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  await new Promise(() => {})
}

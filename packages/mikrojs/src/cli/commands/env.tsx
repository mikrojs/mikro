/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {useCallback, useMemo, useState} from 'react'
import {catchError, map, of, shareReplay} from 'rxjs'

import {DevicePicker} from '../components/DevicePicker.js'
import {EnvEditor} from '../components/EnvEditor.js'
import {agentError, agentResult, isAgentMode} from '../lib/agent.js'
import {openSession} from '../lib/serial/openSession.js'
import {connectRepl, type ReplSession} from '../lib/session.js'
import {createSerialTransport, openSerial} from '../lib/transport.js'
import {useObservable} from '../lib/useObservable.js'

const portOption = optional(
  option('-p', '--port', string({metavar: 'PORT'}), {
    description: message`Serial port of device`,
  }),
)

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))

const listArgs = command(
  'list',
  objectConstruct({
    subcommand: constant('list' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  objectConstruct({
    subcommand: constant('set' as const),
    secret: optional(
      flag('--secret', {
        description: message`Mark value as a secret (write-only, never displayed)`,
      }),
    ),
    key: argument(string({metavar: 'KEY'})),
    value: optional(argument(string({metavar: 'VALUE'}))),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const deleteArgs = command(
  'delete',
  objectConstruct({
    subcommand: constant('delete' as const),
    key: argument(string({metavar: 'KEY'})),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const uiArgs = command(
  'ui',
  objectConstruct({
    subcommand: constant('ui' as const),
    port: portOption,
  }),
)

export const args = command(
  'env',
  objectConstruct({
    action: constant('env'),
    sub: orConstruct(listArgs, setArgs, deleteArgs, uiArgs),
  }),
)

/** Enable Secure Keyboard Entry (prevents other apps from intercepting keystrokes) */
function setSecureKeyboardEntry(enabled: boolean) {
  // iTerm2 proprietary escape sequence
  process.stdout.write(`\x1b]1337;SetSecureKeyboardEntry=${enabled ? 1 : 0}\x07`)
}

/** Read a secret value from stdin without echoing */
async function readSecretValue(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  setSecureKeyboardEntry(true)
  return new Promise<string>((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)

    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      setSecureKeyboardEntry(false)
    }

    let buf = ''
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString()
      if (ch === '\r' || ch === '\n') {
        process.stdout.write('\n')
        cleanup()
        resolve(buf)
      } else if (ch === '\x7f' || ch === '\b') {
        buf = buf.slice(0, -1)
      } else if (ch === '\x03') {
        cleanup()
        resolve('')
      } else {
        buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function withSession<T>(
  portArg: string | undefined,
  fn: (session: ReplSession) => Promise<T>,
): Promise<T> {
  const handles = await openSession({port: portArg})
  try {
    return await fn(handles.session)
  } finally {
    handles.close()
  }
}

export async function run(config: InferValue<typeof args>) {
  const {sub} = config

  if (sub.subcommand === 'ui') return

  const jsonOutput = sub.json === true || isAgentMode(sub.agent)

  switch (sub.subcommand) {
    case 'list': {
      await withSession(sub.port, async (session) => {
        const entries = await session.config.list()

        if (jsonOutput) {
          agentResult(
            'env list',
            entries.map((e) => ({
              key: e.key,
              value: e.secret ? undefined : e.value,
              secret: e.secret,
            })),
            [
              {command: 'mikro env set <KEY> <VALUE>', description: 'Set an env variable'},
              {command: 'mikro env delete <KEY>', description: 'Delete an env variable'},
            ],
          )
          return
        }

        if (entries.length === 0) {
          console.log('No env variables configured')
          return
        }

        const envEntries = entries.filter((e) => !e.secret)
        const secretEntries = entries.filter((e) => e.secret)

        if (envEntries.length > 0) {
          const maxKeyLen = Math.max(...envEntries.map((e) => e.key.length))
          for (const e of envEntries) {
            console.log(`${e.key.padEnd(maxKeyLen)}  ${e.value}`)
          }
        }
        if (secretEntries.length > 0) {
          for (const e of secretEntries) {
            console.log(`${e.key}  ********`)
          }
        }
      })
      break
    }

    case 'set': {
      const {key, secret: isSecret} = sub
      if (Buffer.byteLength(key, 'utf-8') > 15) {
        if (jsonOutput) {
          agentError('env set', `Key "${key}" exceeds NVS 15-char limit`, {
            fix: 'Use a key with 15 or fewer characters',
          })
        } else {
          console.error(`Error: key "${key}" exceeds NVS 15-char limit`)
        }
        process.exit(1)
      }

      let value: string
      if (isSecret) {
        if (jsonOutput) {
          agentError('env set', 'Cannot use --secret with --json (no interactive input)', {
            fix: 'Provide the value directly: mikro env set <KEY> <VALUE>',
          })
          process.exit(1)
        }
        value = await readSecretValue(`Enter value for ${key}: `)
        if (!value) {
          console.error('Cancelled')
          process.exit(1)
        }
      } else {
        if (!sub.value) {
          if (jsonOutput) {
            agentError('env set', 'Missing VALUE', {
              fix: 'Provide a value: mikro env set <KEY> <VALUE>',
            })
          } else {
            console.error('Error: missing VALUE (use --secret for hidden input)')
          }
          process.exit(1)
        }
        value = sub.value
      }

      await withSession(sub.port, async (session) => {
        await session.config.set(key, value, isSecret === true)
        if (jsonOutput) {
          agentResult('env set', {key}, [
            {command: 'mikro env list', description: 'List all env variables'},
          ])
        } else if (isSecret) {
          console.log(`Set secret ${key}`)
        } else {
          console.log(`Set ${key}=${value}`)
        }
      })
      break
    }

    case 'delete': {
      const {key} = sub

      await withSession(sub.port, async (session) => {
        const entries = await session.config.list()
        const entry = entries.find((e) => e.key === key)
        if (!entry) {
          if (jsonOutput) {
            agentError('env delete', `Not found: ${key}`, {
              fix: 'Run mikro env list to see available keys',
              next_actions: [{command: 'mikro env list', description: 'List all env variables'}],
            })
          } else {
            console.error(`Not found: ${key}`)
          }
          process.exit(1)
        }

        await session.config.delete(key)
        if (jsonOutput) {
          agentResult('env delete', {key}, [
            {command: 'mikro env list', description: 'List all env variables'},
          ])
        } else {
          console.log(`Deleted ${key}`)
        }
      })
      break
    }
  }

  process.exit(0)
}

// ── Ink component for `mikro env ui` ──────────────────────────

type Props = {
  args: InferValue<typeof args>
}

export default function EnvCmd(props: Props) {
  const {args: config} = props
  const port = config.sub.subcommand === 'ui' ? config.sub.port : undefined

  return (
    <DevicePicker port={port}>{(device) => <EnvUiSession devicePath={device.path} />}</DevicePicker>
  )
}

const BAUD_RATE_UI = 115200

function EnvUiSession({devicePath}: {devicePath: string}) {
  const [didEnd, setDidEnd] = useState(false)

  const handleEnd = useCallback(() => {
    process.stdout.write('\x1b[<u')
    setDidEnd(true)
  }, [])

  const config$ = useMemo(
    () =>
      openSerial(devicePath, BAUD_RATE_UI).pipe(
        map((serial) => {
          const transport = createSerialTransport(serial)
          const session = connectRepl(transport)
          return session.config
        }),
        catchError(() => of(null)),
        shareReplay({bufferSize: 1, refCount: true}),
      ),
    [devicePath],
  )

  const config = useObservable(config$, null)

  if (didEnd) return null
  if (!config) return null
  return <EnvEditor config={config} onClose={handleEnd} />
}

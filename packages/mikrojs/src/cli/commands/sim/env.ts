/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {openSim} from '../../lib/openSim.js'
import {readSecretValue} from '../../lib/secretInput.js'
import type {ReplSession} from '../../lib/session.js'
import {SimAlreadyRunningError} from '../../lib/simPid.js'

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))

const listArgs = command(
  'list',
  objectConstruct({
    envSubcommand: constant('list' as const),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const getArgs = command(
  'get',
  objectConstruct({
    envSubcommand: constant('get' as const),
    key: argument(string({metavar: 'KEY'})),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  objectConstruct({
    envSubcommand: constant('set' as const),
    noSecret: optional(
      flag('--no-secret', {
        description: message`Pass VALUE as an argument and store it as non-secret (visible in 'env list')`,
      }),
    ),
    key: argument(string({metavar: 'KEY'})),
    value: optional(argument(string({metavar: 'VALUE'}))),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const deleteArgs = command(
  'delete',
  objectConstruct({
    envSubcommand: constant('delete' as const),
    key: argument(string({metavar: 'KEY'})),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

export const args = command(
  'env',
  objectConstruct({
    subcommand: constant('env' as const),
    envSub: orConstruct(listArgs, getArgs, setArgs, deleteArgs),
  }),
  {description: message`Manage environment variables stored in the simulator`},
)

type EnvSub = InferValue<typeof args>['envSub']

async function withSimSession<T>(fn: (session: ReplSession) => Promise<T>): Promise<T> {
  const {session, transport} = await openSim()
  try {
    return await fn(session)
  } finally {
    session.close()
    transport.close()
  }
}

export async function run(config: {envSub: EnvSub}): Promise<void> {
  const sub = config.envSub
  const jsonOutput = sub.json === true || isAgentMode(sub.agent)

  try {
    switch (sub.envSubcommand) {
      case 'list': {
        await withSimSession(async (session) => {
          const entries = await session.config.list()
          if (jsonOutput) {
            agentResult(
              'sim env list',
              entries.map((e) => ({
                key: e.key,
                value: e.secret ? undefined : e.value,
                secret: e.secret,
              })),
              [
                {command: 'mikro sim env set <KEY> <VALUE>', description: 'Set an env variable'},
                {command: 'mikro sim env delete <KEY>', description: 'Delete an env variable'},
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
            for (const e of envEntries) console.log(`${e.key.padEnd(maxKeyLen)}  ${e.value}`)
          }
          for (const e of secretEntries) console.log(`${e.key}  ********`)
        })
        break
      }
      case 'get': {
        await withSimSession(async (session) => {
          const entries = await session.config.list()
          const entry = entries.find((e) => e.key === sub.key)
          if (!entry) {
            if (jsonOutput) {
              agentError('sim env get', `Not found: ${sub.key}`, {
                fix: 'Run mikro sim env list to see available keys',
              })
            } else {
              console.error(`Not found: ${sub.key}`)
            }
            process.exit(1)
          }
          if (jsonOutput) {
            agentResult('sim env get', {
              key: entry.key,
              value: entry.secret ? undefined : entry.value,
              secret: entry.secret,
            })
          } else if (entry.secret) {
            console.log('********')
          } else {
            console.log(entry.value)
          }
        })
        break
      }
      case 'set': {
        const {key, noSecret} = sub
        if (Buffer.byteLength(key, 'utf-8') > 15) {
          if (jsonOutput) {
            agentError('sim env set', `Key "${key}" exceeds NVS 15-char limit`, {
              fix: 'Use a key with 15 or fewer characters',
            })
          } else {
            console.error(`Error: key "${key}" exceeds NVS 15-char limit`)
          }
          process.exit(1)
        }

        const isSecret = noSecret !== true
        let value: string

        if (isSecret) {
          if (sub.value !== undefined) {
            if (jsonOutput) {
              agentError(
                'sim env set',
                'Pass VALUE only with --no-secret. For secrets, omit VALUE to enter it via hidden prompt.',
                {fix: 'Run: mikro sim env set <KEY>  (then enter the value when prompted)'},
              )
            } else {
              console.error(
                'Error: pass VALUE only with --no-secret. For secrets, omit VALUE to enter it via hidden prompt.',
              )
            }
            process.exit(1)
          }
          if (jsonOutput) {
            agentError(
              'sim env set',
              'Cannot read a secret value in --json mode (no interactive input)',
              {fix: 'Run interactively, or pass --no-secret with VALUE for non-secret values'},
            )
            process.exit(1)
          }
          value = await readSecretValue(`Enter value for ${key}: `)
          if (!value) {
            console.error('Cancelled')
            process.exit(1)
          }
        } else {
          if (sub.value === undefined) {
            if (jsonOutput) {
              agentError('sim env set', '--no-secret requires a VALUE', {
                fix: 'Provide a value: mikro sim env set <KEY> <VALUE> --no-secret',
              })
            } else {
              console.error('Error: --no-secret requires a VALUE')
            }
            process.exit(1)
          }
          value = sub.value
        }

        await withSimSession(async (session) => {
          await session.config.set(key, value, isSecret)
          if (jsonOutput) {
            agentResult('sim env set', {key, secret: isSecret}, [
              {command: 'mikro sim env list', description: 'List all env variables'},
            ])
          } else if (isSecret) {
            console.log(`Set ${key}`)
          } else {
            console.log(`Set ${key}=${value}`)
          }
        })
        break
      }
      case 'delete': {
        const {key} = sub
        await withSimSession(async (session) => {
          const entries = await session.config.list()
          const entry = entries.find((e) => e.key === key)
          if (!entry) {
            if (jsonOutput) {
              agentError('sim env delete', `Not found: ${key}`, {
                fix: 'Run mikro sim env list to see available keys',
              })
            } else {
              console.error(`Not found: ${key}`)
            }
            process.exit(1)
          }
          await session.config.delete(key)
          if (jsonOutput) {
            agentResult('sim env delete', {key}, [
              {command: 'mikro sim env list', description: 'List all env variables'},
            ])
          } else {
            console.log(`Deleted ${key}`)
          }
        })
        break
      }
    }
  } catch (err) {
    if (err instanceof SimAlreadyRunningError) {
      if (jsonOutput) {
        agentError('sim env', err.message, {
          fix: 'Stop the running sim (Ctrl-C in that terminal), then retry.',
        })
      } else {
        console.error(`Error: ${err.message}`)
      }
      process.exit(1)
    }
    throw err
  }

  process.exit(0)
}

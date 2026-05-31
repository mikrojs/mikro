/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object, or} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {SerialPort} from 'serialport'

import {agentError, agentResult, isAgentMode} from '../lib/agent.js'
import {
  deviceAliasesFilePath,
  matchPortToken,
  readDeviceAliases,
  removeDeviceAlias,
  setDeviceAlias,
} from '../lib/deviceAliases.js'
import {getCachedDeviceId} from '../lib/deviceCache.js'
import {deviceIdFromSerial} from '../lib/deviceId.js'
import {port} from '../lib/portValueParser.js'
import {suggestDeviceName} from '../lib/suggestName.js'

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))

const listArgs = command(
  'list',
  object({
    subcommand: constant('list' as const),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  object({
    subcommand: constant('set' as const),
    // Optional: with no NAME we suggest a color-animal name from the device id.
    name: optional(argument(string({metavar: 'NAME'}))),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Device to name (path, serial, or existing alias). Defaults to the only connected device.`,
      }),
    ),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const rmArgs = command(
  'rm',
  object({
    subcommand: constant('rm' as const),
    name: argument(string({metavar: 'NAME'})),
    json: jsonFlag,
    agent: agentFlag,
  }),
)

export const args = command(
  'alias',
  object({
    action: constant('alias'),
    // Optional so bare `mikro alias` works; it defaults to `list` below.
    sub: optional(or(listArgs, setArgs, rmArgs)),
  }),
  {description: message`Give connected devices readable names`},
)

async function connectedDevices() {
  return (await SerialPort.list()).filter((p) => p.serialNumber)
}

export async function run(config: InferValue<typeof args>) {
  const sub = config.sub ?? {subcommand: 'list' as const, json: undefined, agent: undefined}
  const jsonOutput = sub.json === true || isAgentMode(sub.agent)

  switch (sub.subcommand) {
    case 'list': {
      const aliases = readDeviceAliases()
      const connected = await connectedDevices()
      const entries = Object.entries(aliases).map(([serialNumber, name]) => {
        const device = connected.find((d) => d.serialNumber === serialNumber)
        return {name, serialNumber, connected: Boolean(device), path: device?.path}
      })

      if (jsonOutput) {
        agentResult('alias list', entries, [
          {command: 'mikro alias set <NAME>', description: 'Name the connected device'},
          {command: 'mikro alias rm <NAME>', description: 'Remove an alias'},
        ])
        return
      }

      if (entries.length === 0) {
        console.log('No device aliases. Add one with: mikro alias set <port> <name>')
        console.log(`Stored in ${deviceAliasesFilePath()}`)
        return
      }

      const maxName = Math.max(...entries.map((e) => e.name.length))
      for (const e of entries) {
        const where = e.connected ? e.path : 'not connected'
        console.log(`${e.name.padEnd(maxName)}  ${e.serialNumber}  ${where}`)
      }
      return
    }

    case 'set': {
      const connected = await connectedDevices()
      let serialNumber: string

      if (sub.port) {
        const device = matchPortToken(connected, sub.port)
        // A path with no matching device: can't learn its serial, so refuse.
        if (!device && sub.port.includes('/')) {
          const msg = `Device not found: ${sub.port}`
          if (jsonOutput) {
            agentError('alias set', msg, {fix: 'Run mikro ls to see connected devices'})
          } else {
            console.error(`Error: ${msg}`)
          }
          process.exit(1)
        }
        serialNumber = device?.serialNumber ?? sub.port
      } else {
        // No --port: name the only connected device.
        if (connected.length === 0) {
          const msg = 'No device connected'
          if (jsonOutput) {
            agentError('alias set', msg, {fix: 'Connect a device, or pass --port <serial>'})
          } else {
            console.error(`Error: ${msg}. Connect a device, or pass --port <serial>.`)
          }
          process.exit(1)
        }
        if (connected.length > 1) {
          const msg = 'Multiple devices connected'
          if (jsonOutput) {
            agentError('alias set', msg, {fix: 'Pass --port to choose one (see mikro ls)'})
          } else {
            console.error(`Error: ${msg}. Pass --port to choose one:`)
            for (const d of connected) {
              console.error(`  ${d.path} (${d.manufacturer ?? ''} ${d.serialNumber ?? ''})`)
            }
          }
          process.exit(1)
        }
        serialNumber = connected[0]!.serialNumber!
      }

      // No NAME given: suggest a stable color-animal name from the device id.
      const name =
        sub.name ??
        suggestDeviceName(
          deviceIdFromSerial(serialNumber) ?? getCachedDeviceId(serialNumber) ?? serialNumber,
        )

      const result = setDeviceAlias(serialNumber, name)
      if (!result.ok) {
        if (jsonOutput) agentError('alias set', result.error)
        else console.error(`Error: ${result.error}`)
        process.exit(1)
      }

      if (jsonOutput) {
        agentResult('alias set', {name, serialNumber}, [
          {command: 'mikro alias list', description: 'List device aliases'},
        ])
      } else {
        console.log(`Aliased ${serialNumber} as "${name}"`)
      }
      return
    }

    case 'rm': {
      const result = removeDeviceAlias(sub.name)
      if (!result.ok) {
        if (jsonOutput) {
          agentError('alias rm', result.error, {
            next_actions: [{command: 'mikro alias list', description: 'List device aliases'}],
          })
        } else {
          console.error(`Error: ${result.error}`)
        }
        process.exit(1)
      }

      if (jsonOutput) {
        agentResult('alias rm', {name: sub.name}, [
          {command: 'mikro alias list', description: 'List device aliases'},
        ])
      } else {
        console.log(`Removed alias "${sub.name}"`)
      }
      return
    }
  }
}

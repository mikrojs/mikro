/* eslint-disable no-console */
import {command, constant, message, optional} from '@optique/core'
import {object, or} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {firstValueFrom} from 'rxjs'

import {agentError, agentResult, isAgentMode} from '../lib/agent.js'
import {rememberDeviceForPort} from '../lib/deviceCache.js'
import {
  deviceGeneratedName,
  encodeDeviceName,
  NAME_KV,
  validateDeviceName,
} from '../lib/deviceName.js'
import {describeError} from '../lib/errorMessage.js'
import {port} from '../lib/portValueParser.js'
import {openSession} from '../lib/serial/openSession.js'

const jsonFlag = optional(flag('--json', {description: message`Output as JSON`}))
const agentFlag = optional(flag('--agent', {description: message`Output as JSON (agent mode)`}))
const portOption = optional(
  option('-p', '--port', port(), {
    description: message`Device to act on (path, serial, or name). Defaults to the only connected device.`,
  }),
)

const showArgs = command(
  'show',
  object({
    subcommand: constant('show' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const setArgs = command(
  'set',
  object({
    subcommand: constant('set' as const),
    // Optional: with no NAME we materialize the one derived from the device id.
    name: optional(argument(string({metavar: 'NAME'}))),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

const unsetArgs = command(
  'unset',
  object({
    subcommand: constant('unset' as const),
    port: portOption,
    json: jsonFlag,
    agent: agentFlag,
  }),
)

export const args = command(
  'name',
  object({
    action: constant('name'),
    // Optional so bare `mikro name` works; it defaults to `show` below.
    sub: optional(or(showArgs, setArgs, unsetArgs)),
  }),
  {description: message`Show or set the connected device's name`},
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const sub = config.sub ?? {
    subcommand: 'show' as const,
    port: undefined,
    json: undefined,
    agent: undefined,
  }
  const jsonOutput = sub.json === true || isAgentMode(sub.agent)
  const label = `name ${sub.subcommand}`
  // Set once the port is open. process.exit skips the `finally` that would
  // close it, so fail() has to release it itself; close() is idempotent, so the
  // finally running first is harmless.
  let session: {close(): void} | undefined
  const fail = (msg: string, fix?: string): never => {
    session?.close()
    if (jsonOutput) agentError(label, msg, fix === undefined ? undefined : {fix})
    else console.error(`Error: ${msg}`)
    process.exit(1)
  }

  // Validate before opening the port so a bad name fails without touching the
  // device. An omitted NAME is resolved from the device id below.
  const requested = sub.subcommand === 'set' ? sub.name?.trim() : undefined
  if (requested !== undefined) {
    const check = validateDeviceName(requested)
    if (!check.ok) fail(check.error)
  }

  try {
    const handles = await openSession({port: sub.port, compat: 'enforce'})
    session = handles
    try {
      // The handshake is the only way to read the device's current name and
      // revision — the kv protocol is write-only.
      const ready = await firstValueFrom(handles.session.awaitReady$())
      const suggestion = deviceGeneratedName(undefined, ready.id)
      const identifier = ready.id ?? '(unknown)'
      const current = ready.name
      const rev = ready.nameRev ?? 0

      if (sub.subcommand === 'show') {
        if (jsonOutput) {
          agentResult(label, {name: current, identifier, suggestion, nameRev: rev}, [
            {command: 'mikro name set', description: 'Name this device'},
          ])
        } else if (current === undefined) {
          console.log(`No name set; this device is ${identifier}`)
          if (suggestion !== undefined) {
            console.log(`Run \`mikro name set\` to call it ${suggestion}.`)
          }
        } else {
          console.log(current)
        }
        return
      }

      if (sub.subcommand === 'set') {
        // Refuse to derive over a name stored in an unreadable form: rev 0 / no
        // name is indistinguishable from never-named, so a derived write at
        // rev 1 would clobber a real name and still lose to a registry holding a
        // higher revision. An explicit NAME is a deliberate choice and lands;
        // only the derived fallback is refused, the same as enroll and postFlash.
        if (ready.nameCorrupt === true && requested === undefined) {
          return fail(
            'This device has a name stored in an unreadable form, so a derived name would overwrite it',
            'Pass a NAME to set one explicitly',
          )
        }
        // No NAME given: materialize the id-derived suggestion. Deriving on
        // demand for display would make the name a function of the CLI version,
        // but storing it here pins it for good.
        const target = requested ?? suggestion
        if (target === undefined) {
          return fail('This device reported no id to derive a name from; pass a NAME')
        }
        await handles.session.kv.set(NAME_KV, encodeDeviceName({rev: rev + 1, name: target}), 'sys')
        await rememberDeviceForPort(handles.devicePath, {
          deviceId: ready.id ?? undefined,
          name: target,
        })
        if (jsonOutput) agentResult(label, {name: target, nameRev: rev + 1})
        else console.log(`Named this device "${target}"`)
        return
      }

      // unset: clearing is a deliberate write like any other, so it bumps the
      // revision and propagates instead of the old name resurrecting.
      if (current === undefined) {
        if (jsonOutput) agentResult(label, {name: undefined, identifier, nameRev: rev})
        else console.log(`No name set; this device is ${identifier}`)
        return
      }
      // A set, not a delete: the revision has to survive so the clear wins the
      // next sync instead of the registry's older name resurrecting.
      await handles.session.kv.set(NAME_KV, encodeDeviceName({rev: rev + 1}), 'sys')
      // name: null is the point of `unset`: clear the cached name too.
      await rememberDeviceForPort(handles.devicePath, {
        deviceId: ready.id ?? undefined,
        name: null,
      })
      if (jsonOutput) agentResult(label, {name: undefined, identifier, nameRev: rev + 1})
      else console.log(`Unset the name; this device is now ${identifier}`)
    } finally {
      handles.close()
    }
  } catch (err) {
    fail(describeError(err))
  }
}

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {firstValueFrom} from 'rxjs'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {rememberDeviceForPort} from '../../lib/deviceCache.js'
import {
  deviceGeneratedName,
  encodeDeviceName,
  NAME_KV,
  validateDeviceName,
} from '../../lib/deviceName.js'
import {CREDENTIAL_KV, enrollDevice, REGISTRY_KV, remintCredential} from '../../lib/enroll.js'
import {describeError} from '../../lib/errorMessage.js'
import {port} from '../../lib/portValueParser.js'
import {readProjectApp} from '../../lib/projectApp.js'
import {
  requireRegistryToken,
  requireRegistryUrl,
  resolveRegistryConnection,
} from '../../lib/registryConfig.js'
import {openSession} from '../../lib/serial/openSession.js'

export const args = command(
  'enroll',
  object({
    subcommand: constant('enroll' as const),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (default: .mikro/registry.json)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry API token (default: MIKRO_OTA_TOKEN or .mikro/registry.json)`,
      }),
    ),
    name: optional(
      option('--name', string({metavar: 'NAME'}), {
        description: message`Name for the device (default: derived from its device id)`,
      }),
    ),
    channel: optional(
      option('--channel', string({metavar: 'CHANNEL'}), {
        description: message`Update channel the device follows (e.g. beta, stable); default main`,
      }),
    ),
    reEnroll: optional(
      flag('--re-enroll', {
        description: message`Mint a fresh credential when the device is already enrolled (the old one stops working immediately)`,
      }),
    ),
    credential: optional(
      option('--credential', string({metavar: 'SECRET'}), {
        description: message`Write an externally minted credential to the device; the registry is not contacted`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
  {description: message`Enroll the connected device with an update registry`},
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  // Set once the port is open. process.exit skips the `finally` that would
  // close it, so fail() has to release it itself; close() is idempotent, so the
  // finally running first is harmless.
  let session: {close(): void} | undefined
  const fail = (msg: string, fix?: string): never => {
    session?.close()
    if (jsonOutput) {
      agentError('ota enroll', msg, fix === undefined ? undefined : {fix})
    } else {
      // eslint-disable-next-line no-console
      console.error(`Error: ${msg}`)
    }
    process.exit(1)
  }

  const providedCredential = config.credential?.trim()
  if (providedCredential === '') {
    fail('--credential must not be empty')
  }

  // Validate before touching the device so a bad name fails without leaving a
  // half-provisioned board.
  if (config.name !== undefined) {
    const check = validateDeviceName(config.name.trim())
    if (!check.ok) fail(check.error)
  }

  try {
    // Resolve the connection before opening the port so a missing url/token
    // fails fast. The url is needed in both flows: the device stores it next
    // to the credential (the pair is what check-ins run against).
    const connection = resolveRegistryConnection({registry: config.registry, token: config.token})
    const registry = requireRegistryUrl(connection)
    const token = providedCredential === undefined ? requireRegistryToken(connection) : undefined

    const handles = await openSession({port: config.port, compat: 'enforce'})
    session = handles
    try {
      const ready = await firstValueFrom(handles.session.awaitReady$())
      const deviceId = ready.id
      if (deviceId === null) {
        return fail('The device did not report a device id; update its firmware and retry')
      }

      // Unreadable stored bytes look identical to never-named (rev 0, no name)
      // but are not: the real revision is unknown, so deriving a name and
      // writing it at rev 1 would overwrite a name that is really set and still
      // lose to a registry holding a higher revision. An explicit --name is a
      // deliberate choice and still lands, exactly as `mikro name set` does;
      // only the derived fallback is refused.
      if (ready.nameCorrupt === true && config.name === undefined) {
        return fail(
          'This device has a name stored in an unreadable form, so enrolling would overwrite it',
          'Pass --name, or set one explicitly with `mikro name set <name>`',
        )
      }

      // An enrolled device always carries a concrete name, so the registry and
      // the CLI show the same string instead of each deriving its own from the
      // id. An explicit --name wins; otherwise keep whatever the device already
      // has (re-enrolling must not clobber a deliberate name) and only fall
      // back to materializing the derived default.
      const name = config.name?.trim() ?? ready.name ?? deviceGeneratedName(undefined, deviceId)
      if (name === undefined) {
        return fail('Could not derive a name for this device; pass --name')
      }

      let credential = providedCredential
      let reEnrolled = false

      if (credential === undefined) {
        // Sending the app binds the device to it at enrollment, so it can never
        // be offered another app's build.
        const app = readProjectApp()
        const outcome = await enrollDevice(
          {
            registry,
            deviceId,
            name,
            ...(app === undefined ? {} : {app}),
            ...(config.channel === undefined ? {} : {channel: config.channel}),
          },
          token!,
        )
        if (outcome.status === 'already-enrolled') {
          if (config.reEnroll !== true) {
            return fail(
              `Device ${deviceId} is already enrolled with this registry`,
              'Pass --re-enroll to mint a fresh credential (the old one stops working immediately)',
            )
          }
          credential = await remintCredential({registry, deviceId}, token!)
          reEnrolled = true
        } else {
          credential = outcome.credential
        }
      }

      // Registry url + credential are provisioning state, written as a pair:
      // they live in the mik.sys store, which deploys and nvsStorage.clear()
      // never touch, and the app reads them via ota.registry()/ota.bearer().
      await handles.session.kv.set(REGISTRY_KV, registry, 'sys')
      await handles.session.kv.set(CREDENTIAL_KV, credential, 'sys')

      // Skipped when the device already carries this name, so re-enrolling
      // doesn't bump the revision and win a sync it shouldn't.
      if (name !== ready.name) {
        await handles.session.kv.set(
          NAME_KV,
          encodeDeviceName({rev: (ready.nameRev ?? 0) + 1, name}),
          'sys',
        )
      }

      // Every other path that writes a name updates the cache with it; without
      // this, `mikro ls` and `-p <name>` keep resolving the old identity until
      // some later command happens to handshake.
      await rememberDeviceForPort(handles.devicePath, {
        chip: ready.chip ?? undefined,
        deviceId,
        name,
      })

      const provisioned = providedCredential !== undefined
      if (jsonOutput) {
        agentResult('ota enroll', {
          deviceId,
          name,
          registry,
          chip: ready.chip,
          firmware: ready.version,
          port: handles.devicePath,
          reEnrolled,
          provisioned,
        })
      } else {
        const verb = reEnrolled ? 'Re-enrolled' : provisioned ? 'Provisioned' : 'Enrolled'
        // eslint-disable-next-line no-console
        console.log(`${verb} ${name} (${deviceId}) with ${registry}`)
        // eslint-disable-next-line no-console
        console.log(`  port      ${handles.devicePath}`)
        // eslint-disable-next-line no-console
        console.log(
          `  chip      ${ready.chip ?? 'unknown'} (firmware ${ready.version ?? 'unknown'})`,
        )
        // eslint-disable-next-line no-console
        console.log(`  name      ${name}`)
        // eslint-disable-next-line no-console
        console.log('The device authenticates with the registry on its next check-in.')
      }
    } finally {
      handles.close()
    }
  } catch (err) {
    fail(describeError(err))
  }
}

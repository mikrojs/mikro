import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {describeError} from '../../lib/errorMessage.js'
import {releaseBuild} from '../../lib/otaPublish.js'
import {readProjectApp} from '../../lib/projectApp.js'
import {
  requireRegistryToken,
  requireRegistryUrl,
  resolveRegistryConnection,
} from '../../lib/registryConfig.js'

export const args = command(
  'release',
  object({
    subcommand: constant('release' as const),
    version: argument(string({metavar: 'VERSION'})),
    channel: argument(string({metavar: 'CHANNEL'})),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (default: .mikro/registry.json)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry auth token (default: MIKRO_OTA_TOKEN or .mikro/registry.json)`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
  {description: message`Point a channel at an already-pushed build`},
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  try {
    const connection = resolveRegistryConnection({registry: config.registry, token: config.token})
    const registry = requireRegistryUrl(connection)
    const token = requireRegistryToken(connection)

    const app = readProjectApp()
    if (app === undefined) {
      throw new Error('Cannot release: package.json has no app name')
    }

    const {released} = await releaseBuild(
      {registry, app, version: config.version, channel: config.channel},
      token,
    )

    if (jsonOutput) {
      agentResult('ota release', {app, version: config.version, channel: config.channel, released})
    } else {
      // eslint-disable-next-line no-console
      console.log(`Released ${app}@${config.version} to ${config.channel}`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('ota release', describeError(err))
    } else {
      // The error object, not a string: Node renders the cause chain, which is
      // where a failed release's actual reason lives.
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

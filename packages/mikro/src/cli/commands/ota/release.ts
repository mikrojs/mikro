import type {InferValue} from '@optique/core/parser'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {releaseBuild} from '../../lib/otaPublish.js'
import {readProjectApp} from '../../lib/projectApp.js'
import {
  requireRegistryToken,
  requireRegistryUrl,
  resolveRegistryConnection,
} from '../../lib/registryConfig.js'
import type {args} from './release.args.js'

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  try {
    const connection = resolveRegistryConnection({registry: config.registry, token: config.token})
    const registry = requireRegistryUrl(connection)
    const token = requireRegistryToken(connection)

    const app = readProjectApp()
    if (app === undefined) {
      throw new UserError('Cannot release: package.json has no app name')
    }

    const {released, warnings} = await releaseBuild(
      {registry, app, version: config.version, channel: config.channel},
      token,
    )

    if (jsonOutput) {
      agentResult('ota release', {
        app,
        version: config.version,
        channel: config.channel,
        released,
        warnings,
      })
    } else {
      // eslint-disable-next-line no-console
      console.log(`Released ${app}@${config.version} to ${config.channel}`)
      // eslint-disable-next-line no-console
      console.log(`  registry  ${registry}`)
      // eslint-disable-next-line no-console
      for (const warning of warnings) console.log(`  warning: ${warning}`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('ota release', describeError(err))
    } else if (err instanceof UserError) {
      // eslint-disable-next-line no-console
      console.error(`Error: ${describeError(err)}`)
    } else {
      // The error object, not a string: Node renders the cause chain, which is
      // where a failed release's actual reason lives.
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

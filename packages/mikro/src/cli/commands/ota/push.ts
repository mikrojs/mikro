import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {stat} from 'fs/promises'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {describeError} from '../../lib/errorMessage.js'
import {readManifestFromTarball, sha256File} from '../../lib/ota.js'
import {publishBuild, type PublishInput} from '../../lib/otaPublish.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {
  requireRegistryToken,
  requireRegistryUrl,
  resolveRegistryConnection,
} from '../../lib/registryConfig.js'
import {packProject} from './pack.js'

export const args = command(
  'push',
  object({
    subcommand: constant('push' as const),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (default: .mikro/registry.json)`,
      }),
    ),
    tarball: optional(
      option('--tarball', path({metavar: 'FILE', mustExist: true, type: 'file'}), {
        description: message`Push a pre-packed .tgz instead of building the current project`,
      }),
    ),
    release: optional(
      option('--release', string({metavar: 'CHANNEL'}), {
        description: message`Also release the build to this channel (e.g. beta, stable); omit to store without serving`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry auth token (default: MIKRO_OTA_TOKEN or .mikro/registry.json)`,
      }),
    ),
    note: optional(
      option('--note', string({metavar: 'TEXT'}), {
        description: message`Free-text note stored with the build (e.g. what changed)`,
      }),
    ),
    create: optional(
      flag('--create', {
        description: message`Create the app on first publish instead of failing on an unknown app`,
      }),
    ),
    snapshot: optional(
      flag('--snapshot', {
        description: message`Derive a unique version from git state (<version>-snapshot.g<sha>) so iteration doesn't need a package.json bump`,
      }),
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
  }),
  {description: message`Build, pack, and upload an app build to a registry`},
)

type Args = InferValue<typeof args>

export async function run(config: Args, jsonFlag = false): Promise<void> {
  const jsonOutput = jsonFlag || isAgentMode()
  // eslint-disable-next-line no-console
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)
  try {
    const connection = resolveRegistryConnection({registry: config.registry, token: config.token})
    const registry = requireRegistryUrl(connection)
    const token = requireRegistryToken(connection)

    let buildPath: string
    let input: PublishInput
    if (config.tarball) {
      if (config.snapshot) {
        throw new Error(
          '--snapshot has no effect with --tarball: the version is baked into the packed build. Pack with --snapshot instead.',
        )
      }
      buildPath = config.tarball
      const [manifest, checksum, info] = await Promise.all([
        readManifestFromTarball(buildPath),
        sha256File(buildPath),
        stat(buildPath),
      ])
      input = {
        registry,
        checksum,
        size: info.size,
        manifest,
        note: config.note,
        create: config.create,
        // Absent --release stores the build without serving it to anyone.
        channel: config.release,
      }
    } else {
      const artifact = await packProject({
        log,
        minify: !config.noMinify,
        minifier: parseMinifier(config.minifier),
        minifyLevel: parseMinifyLevel(config.minifyLevel),
        logLevel: parseLogLevel(config.logLevel),
        snapshot: config.snapshot,
      })
      buildPath = artifact.outPath
      input = {
        registry,
        checksum: artifact.checksum,
        size: artifact.size,
        manifest: artifact.manifest,
        note: config.note,
        create: config.create,
        channel: config.release,
      }
    }

    log(`Pushing ${buildPath} to ${registry}…`)
    await publishBuild(input, buildPath, token)

    // The channel it was released to, or null when stored without serving. Named
    // `channel` (not `released`) so the field means a channel name everywhere;
    // `released` is only ever a build count, on `mikro ota release`.
    const channel = config.release ?? null
    if (jsonOutput) {
      agentResult('ota push', {
        registry,
        version: input.manifest.version,
        checksum: input.checksum,
        size: input.size,
        channel,
      })
    } else {
      // Show the version: with --snapshot it is derived, so this is the only
      // place the user sees what was actually pushed.
      if (channel !== null) {
        // eslint-disable-next-line no-console
        console.log(`Pushed ${input.manifest.version} and released to ${channel}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `Pushed ${input.manifest.version} (stored, not released; run 'mikro ota release ${input.manifest.version} <channel>')`,
        )
      }
      // eslint-disable-next-line no-console
      console.log(`  checksum  ${input.checksum}`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('ota push', describeError(err))
    } else {
      // The error object, not a string: Node renders the cause chain, which is
      // where a failed upload's actual reason lives.
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

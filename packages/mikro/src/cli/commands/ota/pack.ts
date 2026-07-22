import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import {readFile} from 'fs/promises'
import {lastValueFrom} from 'rxjs'

import type {LogLevel, Minifier, MinifyLevel} from '../../../_exports/index.js'
import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {build} from '../../lib/build.js'
import {describeError} from '../../lib/errorMessage.js'
import {
  finalizeBuild,
  type PackArtifact,
  readBytecodeVersion,
  resolveFirmwareVersion,
} from '../../lib/ota.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../../lib/parseMinifier.js'
import {getMikroDir, resolveProjectRoot} from '../../lib/projectRoot.js'
import {resolveEntry} from '../../lib/resolveEntry.js'

export const args = command(
  'pack',
  object({
    subcommand: constant('pack' as const),
    out: optional(
      option('--out', path({metavar: 'FILE', allowCreate: true, type: 'file'}), {
        description: message`Output path for the build (default: app-<version>.tgz)`,
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
  {description: message`Pack the current project into a deployable OTA build`},
)

type Args = InferValue<typeof args>

async function readProjectVersion(projectRoot: string): Promise<string> {
  const pkg = JSON.parse(await readFile(pathlib.join(projectRoot, 'package.json'), 'utf-8')) as {
    version?: string
  }
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

/** The project name identifies the OTA app and is required (no default): the
 * registry scopes updates by app, so a build with no name can't be targeted. */
async function readProjectName(projectRoot: string): Promise<string> {
  const pkg = JSON.parse(await readFile(pathlib.join(projectRoot, 'package.json'), 'utf-8')) as {
    name?: string
  }
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
    throw new Error('Cannot publish: package.json has no "name" — it identifies the OTA app.')
  }
  return pkg.name
}

/**
 * Build the current project to bytecode and pack it into an OTA `.tgz`.
 * Shared by `mikro ota pack` and `mikro ota publish` (when no build is given).
 */
export async function packProject(options: {
  out?: string
  entry?: string
  log?: (msg: string) => void
  /** Build-shaping options (default: minified, esbuild, all console kept).
   *  Bytecode is always on: an OTA build must be loadable as `.bjs`. */
  minify?: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  logLevel?: LogLevel
}): Promise<PackArtifact> {
  const log = options.log ?? (() => {})
  const projectRoot = resolveProjectRoot()
  const entry = resolveEntry(options.entry)
  const buildDir = pathlib.join(getMikroDir(), 'ota-build')

  log('Building…')
  await lastValueFrom(
    build(entry, buildDir, {
      minify: options.minify ?? true,
      bytecode: true,
      minifier: options.minifier,
      minifyLevel: options.minifyLevel,
      // Default to 'warn', exactly as `mikro deploy` does. Without it the shared
      // builder falls back to 'debug', so a published build keeps every console
      // call while the deployed one strips them: two different builds, two
      // different checksums, and a device can never recognise the fleet build as
      // the one it is already running.
      logLevel: options.logLevel ?? 'warn',
      env: 'production',
    }),
    {defaultValue: undefined},
  )

  const [app, firmwareVersion, bytecodeVersion, version] = await Promise.all([
    readProjectName(projectRoot),
    resolveFirmwareVersion(projectRoot),
    readBytecodeVersion(buildDir),
    readProjectVersion(projectRoot),
  ])

  const outPath = options.out ?? pathlib.join(getMikroDir(), `app-${version}.tgz`)
  log('Packing…')
  return finalizeBuild(buildDir, outPath, {app, version, firmwareVersion, bytecodeVersion})
}

export async function run(config: Args, jsonFlag = false): Promise<void> {
  const jsonOutput = jsonFlag || isAgentMode()
  // eslint-disable-next-line no-console
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)
  try {
    const artifact = await packProject({
      out: config.out,
      log,
      minify: !config.noMinify,
      minifier: parseMinifier(config.minifier),
      minifyLevel: parseMinifyLevel(config.minifyLevel),
      logLevel: parseLogLevel(config.logLevel),
    })
    if (jsonOutput) {
      agentResult('ota pack', {
        path: artifact.outPath,
        checksum: artifact.checksum,
        size: artifact.size,
        app: artifact.manifest.app,
        firmwareVersion: artifact.manifest.firmwareVersion,
        bytecodeVersion: artifact.manifest.bytecodeVersion,
      })
    } else {
      // eslint-disable-next-line no-console
      console.log(artifact.outPath)
      // eslint-disable-next-line no-console
      console.log(`  checksum  ${artifact.checksum}`)
      // eslint-disable-next-line no-console
      console.log(`  size      ${artifact.size} bytes`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('ota pack', describeError(err))
    } else {
      // The error object, not a string: Node renders the cause chain, which is
      // where the actionable detail lives.
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

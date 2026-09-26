import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

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
        description: message`Derive a unique version from the build time (<version>-snapshot.<ts>) so iteration doesn't need a package.json bump`,
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

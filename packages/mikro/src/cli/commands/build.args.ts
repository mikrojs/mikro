import {command, constant, message, object, optional} from '@optique/core'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'

export const args = command(
  'build',
  object({
    action: constant('build'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    outDir: optional(
      option('-o', '--out-dir', path({metavar: 'DIR', allowCreate: true, type: 'directory'}), {
        description: message`Output directory (default: .mikro/build in the project root)`,
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
    noBytecode: optional(flag('--no-bytecode', {description: message`Skip bytecode compilation`})),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)

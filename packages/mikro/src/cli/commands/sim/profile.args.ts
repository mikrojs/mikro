import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, flag, option} from '@optique/core/primitives'
import {integer, string} from '@optique/core/valueparser'
import {path} from '@optique/run'

export const args = command(
  'profile',
  object({
    subcommand: constant('profile' as const),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    memLimit: optional(
      option('--mem-limit', string({metavar: 'BYTES'}), {
        description: message`QuickJS heap ceiling for the profile run (default: 32M). Supports K/M/G suffixes.`,
      }),
    ),
    memoryBudget: optional(
      option('--memory-budget', integer({metavar: 'KB'}), {
        description: message`Memory budget in KB for highlighting rows over budget`,
      }),
    ),
    chip: optional(
      option('--chip', string({metavar: 'NAME'}), {
        description: message`Chip preset for --memory-budget (e.g. esp32c6)`,
      }),
    ),
    top: optional(
      option('--top', integer({metavar: 'N'}), {
        description: message`Show only the N largest modules`,
      }),
    ),
    sort: optional(
      option('--sort', string({metavar: 'KEY'}), {
        description: message`Sort by "size" (default) or "order"`,
      }),
    ),
    minBytes: optional(
      option('--min-bytes', integer({metavar: 'N'}), {
        description: message`Hide modules smaller than N bytes`,
      }),
    ),
    includeNative: optional(
      flag('--include-native', {
        description: message`Include native:* runtime modules in the output (excluded by default)`,
      }),
    ),
    includeBuiltins: optional(
      flag('--include-builtins', {
        description: message`Include mikro/* built-in modules in the output (excluded by default)`,
      }),
    ),
    onlyNative: optional(
      flag('--only-native', {
        description: message`Show only native:* modules (whitelist; overrides --include-*)`,
      }),
    ),
    onlyBuiltins: optional(
      flag('--only-builtins', {
        description: message`Show only mikro/* built-ins (whitelist; overrides --include-*)`,
      }),
    ),
    bundle: optional(
      flag('--bundle', {
        description: message`Enable bundling even if mikro.config.ts disables it`,
      }),
    ),
    noBundle: optional(
      flag('--no-bundle', {
        description: message`Disable bundling even if mikro.config.ts enables it`,
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
    json: optional(flag('--json', {description: message`Output as JSON`})),
    env: optional(
      option('--env-file', path({metavar: 'FILE', type: 'file', mustExist: true}), {
        description: message`Path to .env file with environment variables`,
      }),
    ),
    noAutoEnv: optional(
      flag('--no-auto-env', {
        description: message`Skip auto-loading of .env and .env.development from the project root`,
      }),
    ),
  }),
  {description: message`Profile per-module QuickJS heap usage in the simulator`},
)

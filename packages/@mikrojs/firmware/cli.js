#!/usr/bin/env node
/**
 * mikro-fw: what a firmware build asks of Node.
 *
 *   mikro-fw cmake-path <family>
 *     Prints the path of the family's CMake entry point (project.cmake for
 *     esp32). A firmware project's CMakeLists.txt runs it with
 *     `npx --no --package=@mikrojs/firmware -- mikro-fw`, which finds the
 *     package wherever the package manager installed it.
 *
 *   mikro-fw inputs <dir> [--native-modules=<a;b>]
 *     Prints one JSON object: the declared native modules (see inputs.js),
 *     plus where the mikrojs component finds QuickJS (`quickjsCmake`) and the
 *     portable runtime (`native`). resolve.cmake runs it with `node`, since it
 *     knows this file's path.
 */
import {join} from 'node:path'

import {command, constant, message, optional, or} from '@optique/core'
import {object} from '@optique/core/constructs'
import {defineProgram} from '@optique/core/program'
import {argument, option} from '@optique/core/primitives'
import {choice, string} from '@optique/core/valueparser'
import {run} from '@optique/run'

import pkg from './package.json' with {type: 'json'}

const cmakePath = command(
  'cmake-path',
  object({
    command: constant('cmake-path'),
    family: argument(choice(['esp32'], {metavar: 'FAMILY'}), {
      description: message`The chip family the firmware project builds for.`,
    }),
  }),
  {description: message`Print the path of the family's CMake entry point.`},
)

const inputs = command(
  'inputs',
  object({
    command: constant('inputs'),
    projectDir: argument(string({metavar: 'DIR'}), {
      description: message`The firmware project's directory.`,
    }),
    nativeModules: optional(
      option('--native-modules', string({metavar: 'A;B'}), {
        description: message`The native modules to compile in, separated by ;.`,
      }),
    ),
  }),
  {description: message`Resolve the native modules and package paths a build needs, as JSON.`},
)

const config = run(
  defineProgram({
    parser: or(cmakePath, inputs),
    metadata: {name: Object.keys(pkg.bin)[0], version: pkg.version},
  }),
  {help: 'both'},
)

if (config.command === 'cmake-path') {
  process.stdout.write(join(import.meta.dirname, 'project.cmake'))
} else {
  const {resolveFirmwareInputs} = await import('./inputs.js')
  const quickjs = await import('@mikrojs/quickjs')
  const native = await import('@mikrojs/native/cmake')
  const nativeModules = (config.nativeModules ?? '').split(';').filter(Boolean)
  try {
    process.stdout.write(
      JSON.stringify({
        ...(await resolveFirmwareInputs(config.projectDir, {nativeModules})),
        quickjsCmake: quickjs.cmakePath,
        native: {
          include: native.includePath,
          src: native.srcPath,
          runtime: native.runtimePath,
          scripts: native.scriptsPath,
          bytecodeCmake: native.bytecodeCmakePath,
        },
      }),
    )
  } catch (e) {
    // Manifest errors are complete messages for the CMake FATAL_ERROR; anything
    // else is a bug worth a stack trace.
    process.stderr.write(e.name === 'ManifestError' ? `${e.message}\n` : `${e.stack}\n`)
    process.exit(1)
  }
}

/**
 * mikro-fw: what a firmware build asks of Node.
 *
 *   mikro-fw inputs <dir> [--native-modules=<a;b>]
 *     Prints one JSON object: the declared native modules (see inputs.ts),
 *     plus where the mikrojs component finds QuickJS (`quickjsCmake`) and the
 *     portable runtime (`native`). resolve.cmake runs it with `node`, since it
 *     knows the package's path.
 */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import * as native from '@mikrojs/native/cmake'
import * as quickjs from '@mikrojs/quickjs'
import {command, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import {argument, option} from '@optique/core/primitives'
import {defineProgram} from '@optique/core/program'
import {string} from '@optique/core/valueparser'
import {run} from '@optique/run'

import {resolveFirmwareInputs} from './inputs.ts'

/** The package root: src/ or dist/ is one level down. */
const packageRoot = join(import.meta.dirname, '..')

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version: string
}

const inputs = command(
  'inputs',
  object({
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
    parser: inputs,
    metadata: {name: 'mikro-fw', version: pkg.version},
  }),
  {help: 'both'},
)

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
  const error = e as Error
  process.stderr.write(error.name === 'ManifestError' ? `${error.message}\n` : `${error.stack}\n`)
  process.exit(1)
}

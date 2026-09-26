import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {path} from '@optique/run'
import {stat} from 'fs/promises'
import {create as tarCreate} from 'tar'

import {agentError, agentResult, isAgentMode} from '../../lib/agent.js'
import {displayPath} from '../../lib/displayPath.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {readFlasherArgs} from '../../lib/esptool.js'
import {formatSize} from '../../lib/formatSize.js'
import {sha256File} from '../../lib/ota.js'
import {firmwareBuildDir, runIdf} from '../idf.js'

export const args = command(
  'pack',
  object({
    subcommand: constant('pack' as const),
    out: optional(
      option('--out', path({metavar: 'FILE', allowCreate: true, type: 'file'}), {
        description: message`Output path for the archive (default: ./mikrojs-firmware-<chip>.tar.gz)`,
      }),
    ),
  }),
  {description: message`Build the firmware project and pack it for mikro flash --from`},
)

type Args = InferValue<typeof args>

/** The build packed as `mikro flash --from` reads it: flasher_args.json and the
 *  files it flashes, at their paths in the build directory. */
async function packFirmware(buildDir: string, out: string | undefined) {
  const flasherArgs = await readFlasherArgs(buildDir)
  const files = flasherArgs.files.map((file) => pathlib.relative(buildDir, file.filename))
  // Default to the working directory, like `mikro ota pack`, under the name
  // `mikro flash --from` looks for in a release.
  const outPath = out ?? pathlib.resolve(`mikrojs-firmware-${flasherArgs.chip}.tar.gz`)
  await tarCreate({file: outPath, cwd: buildDir, gzip: {level: 9}, portable: true, noMtime: true}, [
    'flasher_args.json',
    ...files,
  ])
  const [checksum, info] = await Promise.all([sha256File(outPath), stat(outPath)])
  return {outPath, chip: flasherArgs.chip, checksum, size: info.size}
}

export async function run(config: Args): Promise<void> {
  const jsonOutput = isAgentMode()
  try {
    const buildDir = firmwareBuildDir(process.cwd())
    // In agent mode stdout carries only the result, so idf.py's output goes to stderr.
    const code = runIdf(['-B', buildDir, 'build'], jsonOutput ? ['inherit', 2, 2] : 'inherit')
    if (code !== 0) {
      // idf.py, or runIdf when it found neither idf.py nor eim, has said what went wrong.
      if (jsonOutput) agentError('fw pack', `idf.py build exited with code ${code}`)
      return process.exit(code)
    }
    const artifact = await packFirmware(buildDir, config.out)
    if (jsonOutput) {
      agentResult('fw pack', {
        path: artifact.outPath,
        chip: artifact.chip,
        checksum: artifact.checksum,
        size: artifact.size,
      })
    } else {
      // eslint-disable-next-line no-console
      console.log(`Packed firmware for ${artifact.chip}`)
      // eslint-disable-next-line no-console
      console.log(`  file      ${displayPath(artifact.outPath)}`)
      // eslint-disable-next-line no-console
      console.log(`  checksum  ${artifact.checksum}`)
      // eslint-disable-next-line no-console
      console.log(`  size      ${formatSize(artifact.size)}`)
    }
  } catch (err) {
    if (jsonOutput) {
      agentError('fw pack', describeError(err))
    } else if (err instanceof UserError) {
      // eslint-disable-next-line no-console
      console.error(`Error: ${describeError(err)}`)
    } else {
      // eslint-disable-next-line no-console
      console.error('Error:', err)
    }
    process.exit(1)
  }
}

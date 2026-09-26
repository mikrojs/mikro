import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {archiveName} from '@mikrojs/firmware/boards'
import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {option} from '@optique/core/primitives'
import {path} from '@optique/run'
import {stat} from 'fs/promises'
import {create as tarCreate} from 'tar'

import {agentResult, isAgentMode} from '../../lib/agent.js'
import {displayPath} from '../../lib/displayPath.js'
import {UserError} from '../../lib/errorMessage.js'
import {readFlasherArgs} from '../../lib/esptool.js'
import {formatSize} from '../../lib/formatSize.js'
import {imageFiles, ownBoardExport} from '../../lib/fwImage.js'
import {sha256File} from '../../lib/ota.js'
import {prepackBoard} from './prepack.js'
import {buildFirmware, failFw} from './shared.js'

export const args = command(
  'pack',
  object({
    subcommand: constant('pack' as const),
    out: optional(
      option('--out', path({metavar: 'FILE', allowCreate: true, type: 'file'}), {
        description: message`Output path for the archive (default: ./mikro-fw-<name>-<chip>.tar.gz)`,
      }),
    ),
  }),
  {description: message`Build the firmware project and pack it for mikro flash --from`},
)

type Args = InferValue<typeof args>

/** The name the build gave the firmware, from the firmware.json it writes next
 *  to flasher_args.json; undefined when it has none (or an older
 *  @mikrojs/firmware wrote no firmware.json). */
async function builtName(buildDir: string): Promise<string | undefined> {
  const file = pathlib.join(buildDir, 'firmware.json')
  if (!existsSync(file)) return undefined
  let json: {name?: unknown}
  try {
    json = JSON.parse(await readFile(file, 'utf8')) as typeof json
  } catch (e) {
    throw new UserError(`${file} is not valid JSON: ${(e as Error).message}`)
  }
  const {name} = json
  return typeof name === 'string' ? name : undefined
}

/** The image in `dir` packed as `mikro flash --from` reads it: flasher_args.json,
 *  the files it flashes at their paths, and firmware.json. */
async function packImage(dir: string, name: string | undefined, out: string | undefined) {
  const [flasherArgs, files] = await Promise.all([readFlasherArgs(dir), imageFiles(dir)])
  // Default to the working directory, like `mikro ota pack`, under the name
  // `mikro flash --from` looks for in a release: the firmware's and the chip's.
  const outPath = out ?? pathlib.resolve(`${archiveName(name, flasherArgs.chip)}.tar.gz`)
  await tarCreate({file: outPath, cwd: dir, gzip: {level: 9}, portable: true, noMtime: true}, files)
  const [checksum, info] = await Promise.all([sha256File(outPath), stat(outPath)])
  return {outPath, chip: flasherArgs.chip, name, checksum, size: info.size}
}

export async function run(config: Args): Promise<void> {
  const jsonOutput = isAgentMode()
  try {
    const projectDir = process.cwd()
    let dir: string
    let name: string | undefined
    // A board package's firmware project packs its image, as `fw prepack`
    // writes it, so the archive and the published package hold the same files.
    if (ownBoardExport(projectDir)) {
      const board = await prepackBoard(projectDir, 'fw pack', jsonOutput)
      if (board === undefined) return
      dir = board.dir
      name = board.name
    } else {
      const buildDir = buildFirmware(projectDir, 'fw pack', jsonOutput)
      if (buildDir === undefined) return
      dir = buildDir
      name = await builtName(buildDir)
    }
    const artifact = await packImage(dir, name, config.out)
    if (jsonOutput) {
      agentResult('fw pack', {
        path: artifact.outPath,
        chip: artifact.chip,
        name: artifact.name,
        checksum: artifact.checksum,
        size: artifact.size,
      })
    } else {
      // eslint-disable-next-line no-console
      console.log(`Packed firmware for ${artifact.name ?? artifact.chip}`)
      // eslint-disable-next-line no-console
      console.log(`  file      ${displayPath(artifact.outPath)}`)
      // eslint-disable-next-line no-console
      console.log(`  checksum  ${artifact.checksum}`)
      // eslint-disable-next-line no-console
      console.log(`  size      ${formatSize(artifact.size)}`)
    }
  } catch (err) {
    failFw('fw pack', err, jsonOutput)
  }
}

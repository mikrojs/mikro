/* eslint-disable no-console */
import {mkdir, writeFile} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {argument, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {openSession} from '../lib/serial/openSession.js'

const portOption = optional(
  option('-p', '--port', string({metavar: 'PORT'}), {
    description: message`Serial port of device`,
  }),
)

const pullArgs = command(
  'pull',
  objectConstruct({
    subcommand: constant('pull' as const),
    dest: optional(argument(string({metavar: 'DEST'}))),
    port: portOption,
  }),
)

export const args = command(
  'logs',
  objectConstruct({
    action: constant('logs'),
    sub: orConstruct(pullArgs),
  }),
)

/** Mirror of the default in serializeRuntimeConfig — keep in sync. */
const DEFAULT_LOG_DIR = '/appfs/logs'

export async function run(config: InferValue<typeof args>): Promise<void> {
  if (config.sub.subcommand !== 'pull') return
  const {dest, port} = config.sub

  const mikroConfig = await loadMikroConfig(process.cwd())
  const logFile = mikroConfig?.logFile
  if (!logFile) {
    console.error(
      `No file logging configured. Add \`logFile: true\` (or \`logFile: {…}\`) to mikro.config.ts.`,
    )
    process.exit(1)
  }
  const logDir = logFile === true ? DEFAULT_LOG_DIR : (logFile.dir ?? DEFAULT_LOG_DIR)
  const mainPath = `${logDir}/log.txt`
  const rotatedPath = `${mainPath}.1`

  const handles = await openSession({port})
  try {
    if (dest === undefined) {
      /* Stream to stdout. Pull older rotated generation first so the dump
       * is chronological, then the current file. Don't write status to
       * stdout — that would corrupt the log output for downstream
       * consumers (less/grep/etc.). */
      try {
        const rotated = await handles.session.fsGet(rotatedPath)
        process.stdout.write(rotated)
      } catch {
        // No rotated file — fall through to current.
      }
      const main = await handles.session.fsGet(mainPath)
      process.stdout.write(main)
      return
    }

    await mkdir(dest, {recursive: true})
    const mainBody = await handles.session.fsGet(mainPath)
    const mainOut = pathlib.join(dest, 'log.txt')
    await writeFile(mainOut, mainBody)
    console.log(`${mainOut}\t${mainBody.length} bytes`)

    /* Rotated generation, if present. The device returns an open-failed
     * error when it doesn't exist — treat that as "nothing to pull". */
    try {
      const rotatedBody = await handles.session.fsGet(rotatedPath)
      const rotatedOut = pathlib.join(dest, 'log.txt.1')
      await writeFile(rotatedOut, rotatedBody)
      console.log(`${rotatedOut}\t${rotatedBody.length} bytes`)
    } catch {
      // No rotated file — done.
    }
  } finally {
    handles.close()
  }
}

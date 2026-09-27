/* eslint-disable no-console */
import * as pathlib from 'node:path'

import type {InferValue} from '@optique/core/parser'
import {firstValueFrom, lastValueFrom} from 'rxjs'

import {agentResult, isAgentMode} from '../lib/agent.js'
import {UserError} from '../lib/errorMessage.js'
import {
  applyBootSnapshot,
  type BootFigures,
  DEFAULT_MEM_RESERVED,
  defaultMemReserved,
} from '../lib/heapSnapshots.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {parseSize} from '../lib/parseSize.js'
import {getMikroDir, resolveProjectRoot} from '../lib/projectRoot.js'
import {openSession} from '../lib/serial/openSession.js'
import type {ReadyEvent} from '../lib/session.js'
import {formatBootLine, formatBytes} from '../lib/testRunner.js'
import {packProject} from './ota/pack.js'
import type {args} from './profile.args.js'

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

const READY_TIMEOUT_MS = 30_000

/**
 * The device sets `mem_limit` from the `memReserved` in the config it booted
 * with, and that config only reaches it through a deploy. Editing
 * mikro.config.ts therefore changes nothing until the app is deployed, and the
 * reading would silently describe the old reserve. Comparing the two makes that
 * visible instead.
 */
function readFigures(ready: ReadyEvent): BootFigures {
  if (ready.heapFree === undefined || ready.systemFree === undefined) {
    throw new UserError(
      'This firmware does not report its memory figures in the ready handshake. Rebuild and flash the firmware, then try again.',
    )
  }
  return {
    heapFree: ready.heapFree,
    systemFree: ready.systemFree,
    memReserved: ready.memReserved ?? DEFAULT_MEM_RESERVED,
  }
}

/** Returns true when the caller should deploy and re-read. */
async function confirmDeploy(
  detail: string,
  jsonOutput: boolean,
  log: (msg: string) => void,
): Promise<boolean> {
  const msg = `Stale config: ${detail}. Run \`mikro deploy\` first.`
  if (jsonOutput || !process.stdin.isTTY) {
    if (jsonOutput) agentResult('profile', {error: msg})
    else log(msg)
    return false
  }
  console.error(`  ${yellow(`\u26a0 Stale config: ${detail}.`)}`)
  const {createInterface} = await import('node:readline')
  const rl = createInterface({input: process.stdin, output: process.stderr})
  // A full deploy, not a config-only one: mikro.config.json only reaches the
  // device inside an app build, so this replaces the app exactly as
  // `mikro deploy` would.
  const answer = await new Promise<string>((resolve) => {
    rl.question('    Deploy this project now, replacing the app on the device? (y/N) ', resolve)
  })
  rl.close()
  if (answer.toLowerCase() === 'y') return true
  log('    Nothing recorded.')
  return false
}

/** A missing config is the firmware's default reserve, which depends on its
 *  features; a broken one throws rather than quietly comparing the device
 *  against a default. */
async function projectMemReserved(root: string, features: string[] | undefined): Promise<number> {
  const config = await loadMikroConfig(root, 'production')
  return typeof config?.memReserved === 'number' ? config.memReserved : defaultMemReserved(features)
}

export async function run(config: InferValue<typeof args>): Promise<void> {
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  const log = jsonOutput ? () => {} : (msg: string) => console.error(msg)

  let tolerance: number | undefined
  if (config.heapTolerance !== undefined) {
    try {
      tolerance = parseSize(config.heapTolerance)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (jsonOutput) agentResult('profile', {error: msg})
      else log(msg)
      process.exit(1)
    }
  }

  const root = resolveProjectRoot()
  const handles = await openSession({
    port: config.port,
    onConnecting: (path) => log(`Connecting to ${path}`),
  })

  let chip: string
  let measured: BootFigures
  try {
    // The device announced itself at boot, long before this connection, so
    // the handshake has to be driven. awaitReady$ polls CMD_HELLO; plain
    // ready$ would wait for an announcement that already came and went.
    // Not `{fresh: true}`: the figures are captured once at boot, so a cached
    // ready carries the same values.
    const ready = await firstValueFrom(handles.session.awaitReady$(READY_TIMEOUT_MS))
    chip = ready.chip ?? 'unknown'
    measured = readFigures(ready)

    // The device set `mem_limit` from the config it booted with, and that only
    // reaches it through a deploy. A local edit to mikro.config.ts changes
    // nothing until then, so the reading would quietly describe the old
    // reserve. Offer to fix it rather than record something misleading.
    const wanted = await projectMemReserved(root, ready.features)
    if (measured.memReserved !== wanted) {
      const detail = `device booted with memReserved ${formatBytes(measured.memReserved)}, project config says ${formatBytes(wanted)}`
      if (!(await confirmDeploy(detail, jsonOutput, log))) {
        handles.close()
        process.exit(1)
      }
      log('Deploying the project')
      const artifact = await packProject({out: pathlib.join(getMikroDir(), 'deploy.tgz'), log})
      await lastValueFrom(
        handles.session.deployBuild(artifact.outPath, artifact.checksum, {
          envVars: [{key: 'MIKRO_ENV', value: 'production', secret: false}],
          restart: true,
        }),
      )
      measured = readFigures(await firstValueFrom(handles.session.awaitReady$(READY_TIMEOUT_MS)))
    }
    handles.close()
  } catch (err) {
    // process.exit skips finally, so close before reporting rather than after.
    handles.close()
    const msg = err instanceof Error ? err.message : String(err)
    if (jsonOutput) agentResult('profile', {error: msg})
    else log(msg)
    process.exit(1)
  }

  // Reporting is the default: a test run already records this figure from the
  // handshake it does anyway, so profile writing unprompted would let a one-off
  // read overwrite what the suite committed.
  const {action, stored} = applyBootSnapshot(root, chip, measured, {
    seed: config.write === true,
    update: config.write === true,
    tolerance,
  })

  if (jsonOutput) {
    agentResult('profile', {chip, ...measured, stored: stored ?? measured, action})
    if (action === 'exceeded') process.exit(1)
    return
  }

  console.error(`  ${formatBootLine({chip, measured, stored, action}, '--write')}`)
  if (action === 'exceeded') process.exit(1)
}

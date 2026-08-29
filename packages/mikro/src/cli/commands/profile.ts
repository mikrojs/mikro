/* eslint-disable no-console */
import * as pathlib from 'node:path'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {firstValueFrom, lastValueFrom} from 'rxjs'

import {agentResult, isAgentMode} from '../lib/agent.js'
import {
  type BootFigures,
  classifyBootSnapshot,
  heapTolerance,
  readBootSnapshot,
  writeBootSnapshot,
} from '../lib/heapSnapshots.js'
import {loadMikroConfig} from '../lib/loadMikroConfig.js'
import {parseSize} from '../lib/parseSize.js'
import {port} from '../lib/portValueParser.js'
import {getMikroDir, resolveProjectRoot} from '../lib/projectRoot.js'
import {openSession} from '../lib/serial/openSession.js'
import type {ReadyEvent} from '../lib/session.js'
import {formatBytes} from '../lib/testRunner.js'
import {packProject} from './ota/pack.js'

export const args = command(
  'profile',
  object({
    action: constant('profile'),
    port: optional(option('-p', '--port', port(), {description: message`Serial port of device`})),
    updateHeap: optional(
      flag('-u', '--update-heap', {
        description: message`Overwrite the committed boot snapshot (__heap_snapshots__/<chip>.json) with this run's reading. Drift under the tolerance is left alone.`,
      }),
    ),
    heapTolerance: optional(
      option('--heap-tolerance', string({metavar: 'SIZE'}), {
        description: message`Heap drift below which the snapshot is neither flagged nor rewritten (default: max(256, 1% of stored)). Accepts a K/M suffix.`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`NDJSON agent mode`})),
  }),
  {
    description: message`Report the memory a device leaves for an app: the JS budget before \`mem_limit\` throws, and the free system heap, both as they stood before the app was evaluated. Records them as the boot snapshot.`,
  },
)

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const READY_TIMEOUT_MS = 30_000

/** Matches the firmware fallback in mik_app_config.cpp. */
const DEFAULT_MEM_RESERVED = 64 * 1024

/**
 * The device sets `mem_limit` from the `memReserved` in the config it booted
 * with, and that config only reaches it through a deploy. Editing
 * mikro.config.ts therefore changes nothing until the app is deployed, and the
 * reading would silently describe the old reserve. Comparing the two makes that
 * visible instead.
 */
function readFigures(ready: ReadyEvent): BootFigures {
  if (ready.heapFree === undefined || ready.systemFree === undefined) {
    throw new Error(
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

/** A missing config is the default reserve; a broken one throws rather than
 *  quietly comparing the device against 64KB. */
async function projectMemReserved(root: string): Promise<number> {
  const config = await loadMikroConfig(root, 'production')
  return typeof config?.memReserved === 'number' ? config.memReserved : DEFAULT_MEM_RESERVED
}

type BootAction = 'created' | 'ok' | 'exceeded' | 'updated' | 'stale'

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
    // The device only sends MSG_READY in reply to CMD_HELLO, so the handshake
    // has to be driven. awaitReady$ polls it; plain ready$ would wait forever.
    // Not `{fresh: true}`: the figures are captured once at first attach, so a
    // cached ready carries the same values.
    const ready = await firstValueFrom(handles.session.awaitReady$(READY_TIMEOUT_MS))
    chip = ready.chip ?? 'unknown'
    measured = readFigures(ready)

    // The device set `mem_limit` from the config it booted with, and that only
    // reaches it through a deploy. A local edit to mikro.config.ts changes
    // nothing until then, so the reading would quietly describe the old
    // reserve. Offer to fix it rather than record something misleading.
    const wanted = await projectMemReserved(root)
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

  const stored = readBootSnapshot(root, chip)

  let action: BootAction
  if (stored === undefined) {
    writeBootSnapshot(root, chip, measured)
    action = 'created'
  } else {
    // Either ceiling can bind first, so a regression in either one counts.
    const verdicts = (['heapFree', 'systemFree'] as const).map((k) =>
      classifyBootSnapshot(measured[k], stored[k], heapTolerance(stored[k], tolerance)),
    )
    const moved = verdicts.some((v) => v !== 'ok')
    if (config.updateHeap === true) {
      action = moved ? 'updated' : 'ok'
      if (moved) writeBootSnapshot(root, chip, measured)
    } else {
      action = verdicts.includes('exceeded') ? 'exceeded' : moved ? 'stale' : 'ok'
    }
  }

  if (jsonOutput) {
    agentResult('profile', {chip, ...measured, stored: stored ?? measured, action})
    if (action === 'exceeded') process.exit(1)
    return
  }

  render(chip, measured, stored, action)
  if (action === 'exceeded') process.exit(1)
}

/**
 * One segment per ceiling:
 *
 *   esp32c6  js 218KB → 221KB (+3KB)   system 249.1KB → 252.4KB (+3.3KB)
 *
 * More free is the win here, so the colours invert relative to the
 * retained-heap diff `mikro test` prints.
 */
function figure(label: string, now: number, before: number | undefined): string {
  const value = formatBytes(now)
  if (before === undefined || before === now) return `${label} ${value}`
  const change = now - before
  const delta = change > 0 ? green(`+${formatBytes(change)}`) : red(formatBytes(change))
  return `${label} ${dim(`${formatBytes(before)} → ${value} (`)}${delta}${dim(')')}`
}

function render(
  chip: string,
  measured: BootFigures,
  stored: BootFigures | undefined,
  action: BootAction,
): void {
  const body = `${figure('js', measured.heapFree, stored?.heapFree)}   ${figure(
    'system',
    measured.systemFree,
    stored?.systemFree,
  )}`
  const suffix =
    action === 'created'
      ? dim(' (wrote boot snapshot)')
      : action === 'exceeded'
        ? yellow(' ⚠ less than the stored figure. Re-run with -u to accept.')
        : action === 'stale'
          ? dim(' (re-run with -u to record it)')
          : ''
  console.error(`  ${chip}  ${body}${suffix}`)
}

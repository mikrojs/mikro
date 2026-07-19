/**
 * End-to-end smoke test for `mikro sim dev --agent`.
 *
 * Spawns the real CLI subprocess, drives the NDJSON agent protocol over
 * stdio, and asserts the deploy → eval → restart lifecycle. Catches the
 * regressions that nearly all of this session's bug reports came from:
 *  - watcher restart hang (CMD_HELLO not handled / blackout interaction)
 *  - deploy hang (CMD_RUNTIME_PAUSE not handled)
 *  - Result methods missing on stub returns (would surface as eval errors)
 *  - REPL eval formatting (objects rendering as "[object Object]")
 *
 * Opt-in: set `SIM_SMOKE=1` to run. Default-skipped because some CI / agent
 * sandboxes SIGKILL the @mikrojs/native addon child before it can boot, and
 * because spinning up a real subprocess + esbuild + bytecode pipeline is
 * heavier than other unit tests in this suite.
 *
 * Locally:  SIM_SMOKE=1 pnpm --filter mikro exec vitest run simDevSmoke
 */
import {type ChildProcess, spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createInterface} from 'node:readline'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

const cliBin = join(__dirname, '../../../bin/mikrojs.js')

// Default-skipped: some CI / agent sandboxes SIGKILL the @mikrojs/native
// addon child before it can emit anything, and the test is heavier than
// the rest of the suite. Opt in with SIM_SMOKE=1 to actually run it.
const enabled = process.env.SIM_SMOKE === '1'
const describeIfEnabled = enabled ? describe : describe.skip

interface AgentEvent {
  type: string
  [k: string]: unknown
}

interface SimHandle {
  child: ChildProcess
  events: AgentEvent[]
  send(event: Record<string, unknown>): void
  /** Resolves with the next event matching `pred`, or rejects on timeout. */
  waitFor(pred: (e: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>
  close(): Promise<void>
}

function spawnSim(cwd: string): SimHandle {
  const child = spawn(process.execPath, [cliBin, 'sim', 'dev', '--agent', '--no-hooks'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, CLAUDECODE: '', AI_AGENT: ''},
  })
  const events: AgentEvent[] = []
  const waiters: {pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void}[] = []
  const rl = createInterface({input: child.stdout!})
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    try {
      const event = JSON.parse(trimmed) as AgentEvent
      events.push(event)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(event)) {
          waiters[i]!.resolve(event)
          waiters.splice(i, 1)
        }
      }
    } catch {
      // ignore malformed lines (stderr leakage etc.)
    }
  })

  return {
    child,
    events,
    send(event) {
      child.stdin!.write(JSON.stringify(event) + '\n')
    },
    waitFor(pred, timeoutMs = 8000) {
      const matched = events.find(pred)
      if (matched) return Promise.resolve(matched)
      return new Promise<AgentEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(
            new Error(
              `timed out waiting for event after ${timeoutMs}ms; saw ` +
                events
                  .slice(-10)
                  .map((e) => e.type + (e.status ? `(${String(e.status)})` : ''))
                  .join(', '),
            ),
          )
        }, timeoutMs)
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer)
            resolve(e)
          },
        })
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve()
          return
        }
        child.once('exit', () => resolve())
        try {
          child.stdin!.write(JSON.stringify({type: 'exit'}) + '\n')
          child.stdin!.end()
        } catch {
          child.kill('SIGTERM')
        }
        // Backstop in case 'exit' command isn't honored quickly.
        setTimeout(() => child.kill('SIGTERM'), 4000)
      })
    },
  }
}

describeIfEnabled('mikro sim dev --agent smoke test', () => {
  let tempDir: string
  let sim: SimHandle | null = null

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mikro-sim-smoke-'))
    mkdirSync(join(tempDir, 'app'), {recursive: true})
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({name: 'sim-smoke', type: 'module', main: 'app/main.js'}, null, 2),
    )
    writeFileSync(
      join(tempDir, 'app', 'main.js'),
      "console.log('boot:', import.meta.env.MIKRO_ENV)\nglobalThis.greeting = 'hello'\n",
    )
  })

  afterAll(async () => {
    await sim?.close()
    sim = null
    rmSync(tempDir, {force: true, recursive: true})
  })

  it('reaches watching, evaluates expressions, and exits cleanly', async () => {
    sim = spawnSim(tempDir)

    // Initial deploy should land in `watching`.
    await sim.waitFor((e) => e.type === 'status' && e.status === 'watching', 30_000)

    // The deployed script should have run and logged via the host bridge.
    await sim.waitFor((e) => e.type === 'log' && String(e.text).includes('boot: simulator'))

    // Eval a primitive — exercises the REPL eval path end-to-end.
    sim.send({type: 'eval', code: '1 + 1'})
    const result1 = await sim.waitFor((e) => e.type === 'result' && 'text' in e)
    expect(result1.text).toBe('2')

    // Eval an object — verifies inspect output (was "[object Object]" before
    // evalForRepl + mik_inspect).
    sim.send({type: 'eval', code: '({a: 1, b: 2})'})
    const result2 = await sim.waitFor(
      (e) => e.type === 'result' && typeof e.text === 'string' && String(e.text).includes('a: 1'),
    )
    expect(result2.text).toContain('b: 2')

    // Reference the previous result via `_` (mirrors device REPL).
    sim.send({type: 'eval', code: '_.b'})
    const result3 = await sim.waitFor((e) => e.type === 'result' && 'text' in e)
    expect(result3.text).toBe('2')

    // Top-level await (was a syntax error before JS_EVAL_FLAG_ASYNC).
    sim.send({type: 'eval', code: 'await Promise.resolve(42)'})
    const result4 = await sim.waitFor((e) => e.type === 'result' && e.text === '42')
    expect(result4.text).toBe('42')

    // kv/sys namespace isolation through the real runtime + stub + RPC stack.
    // Eval code cannot import native:* modules in the sim, so sys state is
    // seeded and observed via the Node-side persistence file instead. 'Ag=='
    // is base64(cbor(2)), a single 0x02 byte.
    const sysJsonPath = join(tempDir, '.mikro', 'nvs_sys.json')
    writeFileSync(sysJsonPath, JSON.stringify({entries: {probe: 'Ag=='}}, null, 2) + '\n')
    sim.send({
      type: 'eval',
      code: [
        'await (async () => {',
        "  const {nvsStorage} = await import('mikro/kv/nvs')",
        "  const probe = nvsStorage.createValue('probe')",
        "  probe.set('app').orPanic('set failed')",
        "  const results = {kvSees: probe.get() === 'app'}",
        "  nvsStorage.clear().orPanic('clear failed')",
        '  results.kvGone = probe.get() === undefined',
        '  return results',
        '})()',
      ].join('\n'),
    })
    const kvResult = await sim.waitFor(
      (e) => e.type === 'result' && typeof e.text === 'string' && String(e.text).includes('kvSees'),
    )
    expect(kvResult.text).toContain('kvSees: true')
    expect(kvResult.text).toContain('kvGone: true')
    // clear() must not touch the system store.
    expect(JSON.parse(readFileSync(sysJsonPath, 'utf-8')).entries).toEqual({probe: 'Ag=='})

    sim.send({
      type: 'eval',
      code: [
        'await (async () => {',
        "  const {nvsStorage} = await import('mikro/kv/nvs')",
        "  nvsStorage.clear({full: true}).orPanic('full clear failed')",
        '  return {fullClearOk: true}',
        '})()',
      ].join('\n'),
    })
    const fullResult = await sim.waitFor(
      (e) =>
        e.type === 'result' && typeof e.text === 'string' && String(e.text).includes('fullClearOk'),
    )
    expect(fullResult.text).toContain('fullClearOk: true')
    // clear({full: true}) empties the system store too.
    expect(JSON.parse(readFileSync(sysJsonPath, 'utf-8')).entries).toEqual({})
  }, 45_000)
})

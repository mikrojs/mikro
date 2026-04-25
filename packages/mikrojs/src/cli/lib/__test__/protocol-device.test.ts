/**
 * On-device protocol integration tests.
 *
 * Requires a physical device connected via USB serial.
 * Skipped by default. Run with:
 *
 *   DEVICE_PORT=/dev/tty.usbmodem1101 pnpm vitest run src/cli/lib/__test__/protocol-device.test.ts
 *
 * Or auto-detect port:
 *
 *   DEVICE_TEST=1 pnpm vitest run src/cli/lib/__test__/protocol-device.test.ts
 */

import {filter, firstValueFrom, lastValueFrom, take, timeout, toArray} from 'rxjs'
import {SerialPort} from 'serialport'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {connectRepl, type ReplEvent, type ReplSession} from '../session.js'
import {createSerialTransport, type Transport} from '../transport.js'

const DEVICE_PORT = process.env['DEVICE_PORT']
const DEVICE_TEST = process.env['DEVICE_TEST'] === '1' || !!DEVICE_PORT
const BAUD = 115200
const READY_TIMEOUT = 5_000
const TIMEOUT = 2_000

async function resolvePort(): Promise<string> {
  if (DEVICE_PORT) return DEVICE_PORT
  const devices = (await SerialPort.list()).filter((p) => p.serialNumber)
  if (devices.length !== 1) {
    throw new Error(
      devices.length === 0
        ? 'No serial device found'
        : `Multiple devices, set DEVICE_PORT: ${devices.map((d) => d.path).join(', ')}`,
    )
  }
  return devices[0]!.path
}

/** Event type map for type-safe waitFor */
type EventByType = {[E in ReplEvent as E['type']]: E}

/** Wait for a specific event type from the session */
function waitFor<T extends keyof EventByType>(
  session: ReplSession,
  type: T,
  predicate?: (e: EventByType[T]) => boolean,
  ms = TIMEOUT,
): Promise<EventByType[T]> {
  return firstValueFrom(
    session.messages$.pipe(
      filter(
        (e): e is EventByType[T] =>
          e.type === type && (!predicate || predicate(e as EventByType[T])),
      ),
      timeout(ms),
    ),
  )
}

/** Send eval, wait for non-empty result */
async function evalResult(session: ReplSession, code: string): Promise<string> {
  session.eval(code)
  const result = await waitFor(session, 'result', (e) => e.text.length > 0)
  return result.text
}

/** Send eval that produces side-effect output, drain the trailing empty result */
async function evalSideEffect<T extends 'log' | 'warn' | 'error'>(
  session: ReplSession,
  code: string,
  outputType: T,
  predicate?: (e: EventByType[T]) => boolean,
): Promise<EventByType[T]> {
  session.eval(code)
  const output = await waitFor(session, outputType, predicate)
  await waitFor(session, 'result')
  return output
}

describe.skipIf(!DEVICE_TEST)('protocol (on-device)', () => {
  let serial: SerialPort
  let transport: Transport
  let session: ReplSession

  beforeAll(async () => {
    const port = await resolvePort()
    serial = new SerialPort({path: port, baudRate: BAUD, autoOpen: false})
    await new Promise<void>((resolve, reject) => {
      serial.open((err) => (err ? reject(err) : resolve()))
    })
    transport = createSerialTransport(serial)
    session = connectRepl(transport)
    session.messages$.subscribe()

    // Restart to get a clean MSG_READY
    session.restart()
    await firstValueFrom(session.awaitReady$(READY_TIMEOUT))

    // Deploy a minimal test app
    await lastValueFrom(
      session.deploy({
        files: [
          {path: '/app/main.js', data: Buffer.from('globalThis.__testMarker = 42\n')},
          {path: '/app/package.json', data: Buffer.from(JSON.stringify({main: './main.js'}))},
        ],
        force: true,
        restart: true,
      }),
    )

    // Wait for reboot with test app
    await firstValueFrom(session.awaitReady$(READY_TIMEOUT))
  }, 30_000)

  afterAll(() => {
    session?.close()
    if (serial?.isOpen) serial.close()
  })

  // ── Eval ──────────────────────────────────────────────────────

  it('deployed test app ran', async () => {
    expect(await evalResult(session, 'globalThis.__testMarker')).toBe('42')
  })

  it('eval returns number result', async () => {
    expect(await evalResult(session, '1 + 2')).toBe('3')
  })

  it('eval returns string result', async () => {
    expect(await evalResult(session, "'hello'")).toContain('hello')
  })

  it('eval syntax error returns eval_error', async () => {
    session.eval('function(')
    const err = await waitFor(session, 'eval_error')
    expect(err.text).toContain('SyntaxError')
  })

  it('eval with 2-byte unicode', async () => {
    const text = await evalResult(session, "'héllo wörld'")
    expect(text).toContain('héllo')
    expect(text).toContain('wörld')
  })

  it('eval with 4-byte unicode (emoji)', async () => {
    const text = await evalResult(session, "'🌍'")
    expect(text).toContain('🌍')
  })

  it('eval with newlines in string', async () => {
    expect(await evalResult(session, "'a\\nb\\nc'.split('\\n').length")).toBe('3')
  })

  it('eval with large string payload', async () => {
    expect(await evalResult(session, "'x'.repeat(10000).length")).toBe('10000')
  })

  it('rapid-fire evals return correct results in order', async () => {
    session.eval('5 + 5')
    session.eval("'abc'")
    session.eval('1 === 1')

    const r1 = await waitFor(session, 'result')
    const r2 = await waitFor(session, 'result')
    const r3 = await waitFor(session, 'result')
    expect(r1.text).toBe('10')
    expect(r2.text).toBe("'abc'")
    expect(r3.text).toBe('true')
  })

  // ── Console output ────────────────────────────────────────────

  it('console.log produces MSG_LOG', async () => {
    const log = await evalSideEffect(session, "console.log('log-test')", 'log', (e) =>
      e.text.includes('log-test'),
    )
    expect(log.text).toContain('log-test')
  })

  it('console.warn produces MSG_WARN', async () => {
    const warn = await evalSideEffect(session, "console.warn('warn-test')", 'warn', (e) =>
      e.text.includes('warn-test'),
    )
    expect(warn.text).toContain('warn-test')
  })

  it('console.error produces MSG_ERROR', async () => {
    const err = await evalSideEffect(session, "console.error('error-test')", 'error', (e) =>
      e.text.includes('error-test'),
    )
    expect(err.text).toContain('error-test')
  })

  it('console.log with emoji (4-byte UTF-8)', async () => {
    const log = await evalSideEffect(session, "console.log('🌍')", 'log')
    expect(log.text).toBe('🌍')
  })

  it('multiple console.log preserves order', async () => {
    const logsPromise = firstValueFrom(
      session.messages$.pipe(
        filter((e): e is EventByType['log'] => e.type === 'log'),
        take(3),
        toArray(),
        timeout(TIMEOUT),
      ),
    )
    session.eval("console.log('A'); console.log('B'); console.log('C')")
    const logs = await logsPromise
    expect(logs.map((l) => l.text)).toEqual(['A', 'B', 'C'])
    await waitFor(session, 'result') // drain
  })

  // ── Directive ─────────────────────────────────────────────────

  it('directive .mem returns heap info', async () => {
    session.directive('.mem')
    const info = await waitFor(session, 'info', (e) => e.text.includes('Heap'))
    expect(info.text).toContain('Heap')
  })

  // ── Completions ───────────────────────────────────────────────

  it('tab completion returns results', async () => {
    session.complete('consol')
    const c = await waitFor(session, 'completions')
    expect(c.result.items.some((i: string) => i.includes('console'))).toBe(true)
  })

  // ── Deploy ────────────────────────────────────────────────────

  it('deploy single file', async () => {
    const last = await lastValueFrom(
      session.deploy({
        files: [{path: '/app/test.txt', data: Buffer.from('hello')}],
        force: true,
        restart: false,
      }),
    )
    expect(last.type).toBe('complete')
    if (last.type === 'complete') {
      expect(last.deployed).toBe(true)
      expect(last.stats.put).toBe(1)
    }
  })

  it('deploy large file (4KB)', async () => {
    const last = await lastValueFrom(
      session.deploy({
        files: [{path: '/app/large.bin', data: Buffer.alloc(4096, 0x42)}],
        force: true,
        restart: false,
      }),
    )
    expect(last.type).toBe('complete')
    if (last.type === 'complete') expect(last.deployed).toBe(true)
  })

  it('deploy with env vars', async () => {
    await lastValueFrom(
      session.deploy({
        files: [{path: '/app/env.txt', data: Buffer.from('x')}],
        envVars: [
          {key: 'TEST_VAR', value: 'hello', secret: false},
          {key: 'TEST_SEC', value: 'shhh', secret: true},
        ],
        force: true,
        restart: false,
      }),
    )

    const entries = await session.config.list()
    expect(entries.find((e) => e.key === 'TEST_VAR')?.value).toBe('hello')
    expect(entries.find((e) => e.key === 'TEST_SEC')?.secret).toBe(true)

    await session.config.delete('TEST_VAR')
    await session.config.delete('TEST_SEC')
  })

  it('incremental deploy with no changes aborts', async () => {
    const file = {path: '/app/same.txt', data: Buffer.from('same')}
    await lastValueFrom(session.deploy({files: [file], force: true, restart: false}))
    const last = await lastValueFrom(session.deploy({files: [file], force: false, restart: false}))
    expect(last.type).toBe('complete')
    if (last.type === 'complete') {
      expect(last.deployed).toBe(false)
      expect(last.stats.kept).toBeGreaterThanOrEqual(1)
    }
  })

  it('eval works after deploy without restart', async () => {
    await lastValueFrom(
      session.deploy({
        files: [{path: '/app/x.txt', data: Buffer.from('x')}],
        force: true,
        restart: false,
      }),
    )
    expect(await evalResult(session, '100 + 200')).toBe('300')
  })

  // ── Config ────────────────────────────────────────────────────

  it('config set + list + delete', async () => {
    await session.config.set('CFG_KEY', 'cfg_val', false)
    const entries = await session.config.list()
    expect(entries.find((e) => e.key === 'CFG_KEY')?.value).toBe('cfg_val')

    await session.config.delete('CFG_KEY')
    const after = await session.config.list()
    expect(after.some((e) => e.key === 'CFG_KEY')).toBe(false)
  })

  it('config secret value is hidden in list', async () => {
    await session.config.set('SEC_KEY', 'hidden', true)
    const entries = await session.config.list()
    const entry = entries.find((e) => e.key === 'SEC_KEY')
    expect(entry?.secret).toBe(true)
    expect(entry?.value).toBe('')
    await session.config.delete('SEC_KEY')
  })

  // ── Recovery from crashing app ─────────────────────────────────

  it('deploy after crashing app', async () => {
    // Deploy an app that crashes on startup
    await lastValueFrom(
      session.deploy({
        files: [
          {path: '/app/main.js', data: Buffer.from('throw new Error("crash on boot")\n')},
          {path: '/app/package.json', data: Buffer.from(JSON.stringify({main: './main.js'}))},
        ],
        force: true,
        restart: true,
      }),
    )

    // Wait for device to come back up (it enters REPL despite the crash)
    await firstValueFrom(session.awaitReady$(READY_TIMEOUT))

    // Deploy a working app over the crashed one
    const last = await lastValueFrom(
      session.deploy({
        files: [
          {path: '/app/main.js', data: Buffer.from('globalThis.__recovered = true\n')},
          {path: '/app/package.json', data: Buffer.from(JSON.stringify({main: './main.js'}))},
        ],
        force: true,
        restart: true,
      }),
    )
    expect(last.type).toBe('complete')
    if (last.type === 'complete') expect(last.deployed).toBe(true)

    // Wait for reboot with working app
    await firstValueFrom(session.awaitReady$(READY_TIMEOUT))
    expect(await evalResult(session, 'globalThis.__recovered')).toBe('true')
  }, 30_000)

  // ── Restart / reconnect ───────────────────────────────────────

  it('restart and reconnect', async () => {
    session.restart()
    const ready = await firstValueFrom(session.awaitReady$(READY_TIMEOUT))
    expect(ready.chip).toBeTruthy()
  })

  it('eval works after restart', async () => {
    expect(await evalResult(session, '7 * 7')).toBe('49')
  })

  it('double restart', async () => {
    session.restart()
    await firstValueFrom(session.awaitReady$(READY_TIMEOUT))
    session.restart()
    const ready = await firstValueFrom(session.awaitReady$(READY_TIMEOUT))
    expect(ready.chip).toBeTruthy()
  })

  it('eval works after double restart', async () => {
    expect(await evalResult(session, '3 + 4')).toBe('7')
  })
})

/* eslint-disable no-console */
import {gc, memoryUsage, MonotonicTimestamp} from 'mikrojs/sys'
import {pendingCount as pendingHttpCount} from 'native:http'
import {activeTimers} from 'native:sys'

import type {ErrResult, OkResult, Result} from '../result/types.js'
import type {Assert, TestFn, TestOptions} from './types.js'

interface TestCase {
  name: string
  fn: TestFn
  skip: boolean
  only: boolean
  todo: boolean
  timeout?: number
}

interface Suite {
  name: string
  tests: TestCase[]
  skip: boolean
  only: boolean
  todo: boolean
  beforeAll?: TestFn
  afterAll?: TestFn
  beforeEach: TestFn[]
  afterEach: TestFn[]
}

const suites: Suite[] = []
let currentSuite: Suite | null = null
let heapBaseline = 0

/**
 * Recapture the heap baseline. Called by the harness after each suite's
 * beforeAll resolves so warmup allocations (module loads, fetch/TLS
 * lazy-init, wifi connection) don't count toward heapDelta. A microtask
 * yield before the gc lets the beforeAll async frame's locals become
 * collectible — otherwise the baseline would be inflated by vars that
 * were still pinned by the suspended closure when beforeAll resolved,
 * and heapAfter would come in lower than baseline (negative delta).
 */
async function captureHeapBaseline(): Promise<void> {
  await Promise.resolve()
  gc()
  heapBaseline = memoryUsage().heapUsed
}

function newSuite(name: string, flags: {skip?: boolean; only?: boolean; todo?: boolean}): Suite {
  return {
    name,
    tests: [],
    skip: flags.skip ?? false,
    only: flags.only ?? false,
    todo: flags.todo ?? false,
    beforeEach: [],
    afterEach: [],
  }
}

function runSuiteFn(suite: Suite, fn: () => void): void {
  suites.push(suite)
  const prev = currentSuite
  currentSuite = suite
  fn()
  currentSuite = prev
}

// --- name interpolation for .each ---

function interpolateName(template: string, value: unknown, index: number): string {
  let name = template.replaceAll('%#', String(index))
  name = name.replaceAll('%s', String(value))
  if (typeof value === 'object' && value !== null) {
    name = name.replaceAll('%o', JSON.stringify(value))
  }
  return name
}

// --- describe ---

type EachDescribeFn = <T>(
  cases: T[],
) => (name: string, fn: (value: T, index: number) => void) => void

function _describe(name: string, fn: () => void): void {
  runSuiteFn(newSuite(name, {}), fn)
}

_describe.skip = function (name: string, fn: () => void): void {
  runSuiteFn(newSuite(name, {skip: true}), fn)
}

_describe.only = function (name: string, fn: () => void): void {
  runSuiteFn(newSuite(name, {only: true}), fn)
}

_describe.todo = function (name: string, fn: () => void): void {
  runSuiteFn(newSuite(name, {todo: true}), fn)
}

_describe.fixme = function (name: string, fn: () => void): void {
  runSuiteFn(newSuite(name, {skip: true}), fn)
}

_describe.skipIf = function (condition: unknown) {
  return condition ? _describe.skip : _describe
}

_describe.runIf = function (condition: unknown) {
  return condition ? _describe : _describe.skip
}

function describeEach(
  variant: (name: string, fn: () => void) => void,
): <T>(cases: T[]) => (name: string, fn: (value: T, index: number) => void) => void {
  return function <T>(cases: T[]) {
    return function (nameTemplate: string, fn: (value: T, index: number) => void): void {
      cases.forEach((value, index) => {
        variant(interpolateName(nameTemplate, value, index), () => fn(value, index))
      })
    }
  }
}

_describe.each = describeEach(_describe) as EachDescribeFn
;(_describe.skip as any).each = describeEach(_describe.skip) as EachDescribeFn
;(_describe.only as any).each = describeEach(_describe.only) as EachDescribeFn
;(_describe.todo as any).each = describeEach(_describe.todo) as EachDescribeFn
;(_describe.fixme as any).each = describeEach(_describe.fixme) as EachDescribeFn

export const describe = _describe as typeof _describe & {
  skip: typeof _describe.skip & {each: EachDescribeFn}
  only: typeof _describe.only & {each: EachDescribeFn}
  todo: typeof _describe.todo & {each: EachDescribeFn}
  fixme: typeof _describe.fixme & {each: EachDescribeFn}
  skipIf: (condition: unknown) => typeof _describe & {each: EachDescribeFn}
  runIf: (condition: unknown) => typeof _describe & {each: EachDescribeFn}
  each: EachDescribeFn
}

// --- test ---

type EachTestFn = <T>(
  cases: T[],
) => (name: string, fn: (value: T, index: number) => void | Promise<void>) => void

function pushTest(
  where: string,
  name: string,
  fn: TestFn,
  flags: {skip?: boolean; only?: boolean; todo?: boolean},
  options?: TestOptions,
): void {
  if (!currentSuite) throw new Error(`${where}() must be inside describe()`)
  currentSuite.tests.push({
    name,
    fn,
    skip: flags.skip ?? false,
    only: flags.only ?? false,
    todo: flags.todo ?? false,
    timeout: options?.timeout,
  })
}

function _test(name: string, fn: TestFn, options?: TestOptions): void {
  pushTest('test', name, fn, {}, options)
}

_test.skip = function (name: string, fn: TestFn, options?: TestOptions): void {
  pushTest('test.skip', name, fn, {skip: true}, options)
}

_test.only = function (name: string, fn: TestFn, options?: TestOptions): void {
  pushTest('test.only', name, fn, {only: true}, options)
}

_test.fixme = function (name: string, fn: TestFn, options?: TestOptions): void {
  pushTest('test.fixme', name, fn, {skip: true}, options)
}

_test.skipIf = function (condition: unknown) {
  return condition ? _test.skip : _test
}

_test.runIf = function (condition: unknown) {
  return condition ? _test : _test.skip
}

_test.todo = function (name: string): void {
  pushTest('test.todo', name, () => {}, {todo: true})
}

function testEach(
  variant: (name: string, fn: TestFn) => void,
): <T>(
  cases: T[],
) => (name: string, fn: (value: T, index: number) => void | Promise<void>) => void {
  return function <T>(cases: T[]) {
    return function (
      nameTemplate: string,
      fn: (value: T, index: number) => void | Promise<void>,
    ): void {
      cases.forEach((value, index) => {
        variant(interpolateName(nameTemplate, value, index), () => fn(value, index))
      })
    }
  }
}

_test.each = testEach(_test) as EachTestFn
;(_test.skip as any).each = testEach(_test.skip) as EachTestFn
;(_test.only as any).each = testEach(_test.only) as EachTestFn
;(_test.fixme as any).each = testEach(_test.fixme) as EachTestFn

export const test = _test as typeof _test & {
  skip: typeof _test.skip & {each: EachTestFn}
  only: typeof _test.only & {each: EachTestFn}
  fixme: typeof _test.fixme & {each: EachTestFn}
  skipIf: (condition: unknown) => typeof _test & {each: EachTestFn}
  runIf: (condition: unknown) => typeof _test & {each: EachTestFn}
  todo: (name: string) => void
  each: EachTestFn
}

// --- hooks ---

export function beforeAll(fn: TestFn): void {
  if (!currentSuite) throw new Error('beforeAll() must be inside describe()')
  currentSuite.beforeAll = fn
}

export function afterAll(fn: TestFn): void {
  if (!currentSuite) throw new Error('afterAll() must be inside describe()')
  currentSuite.afterAll = fn
}

export function beforeEach(fn: TestFn): void {
  if (!currentSuite) throw new Error('beforeEach() must be inside describe()')
  currentSuite.beforeEach.push(fn)
}

export function afterEach(fn: TestFn): void {
  if (!currentSuite) throw new Error('afterEach() must be inside describe()')
  currentSuite.afterEach.push(fn)
}

// --- assertions ---

function fmt(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (v instanceof Uint8Array) return `Uint8Array[${v.join(', ')}]`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

class AssertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertError'
  }
}

function fail(message: string | undefined, detail: string): never {
  throw new AssertError(message ? `${message}: ${detail}` : detail)
}

function assertOk<T, E>(r: Result<T, E>, message?: string): asserts r is OkResult<T> {
  if (!r.ok) {
    fail(message, `expected ok result, got error: ${formatThrown(r.error)}`)
  }
}

function assertErr<T, E>(r: Result<T, E>, message?: string): asserts r is ErrResult<E> {
  if (r.ok) {
    fail(message, `expected error result, got ok: ${fmt(r.value)}`)
  }
}

export const assert: Assert = {
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) {
      fail(message, `expected ${fmt(expected)}, got ${fmt(actual)}`)
    }
  },

  notEqual(actual: unknown, unexpected: unknown, message?: string): void {
    if (Object.is(actual, unexpected)) {
      fail(message, `expected value to differ from ${fmt(unexpected)}`)
    }
  },

  truthy(value: unknown, message?: string): void {
    if (!value) {
      fail(message, `expected truthy, got ${fmt(value)}`)
    }
  },

  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) {
      fail(message, `expected ${b}, got ${a}`)
    }
  },

  throws(fn: () => void, message?: string): Error {
    try {
      fn()
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    fail(message, 'expected function to throw')
  },

  async rejects(fn: () => Promise<unknown>, message?: string): Promise<Error> {
    try {
      await fn()
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
    fail(message, 'expected promise to reject')
  },

  type(value: unknown, expected: string, message?: string): void {
    if (typeof value !== expected) {
      fail(message, `expected typeof ${expected}, got ${typeof value}`)
    }
  },

  instance(value: unknown, ctor: new (...args: any[]) => any, message?: string): void {
    if (!(value instanceof ctor)) {
      fail(message, `expected instanceof ${ctor.name}, got ${fmt(value)}`)
    }
  },

  ok: assertOk,

  err: assertErr,
}

// --- runner ---

const DEFAULT_TEST_TIMEOUT = 10_000

type TestEvent =
  | {e: 1; s: string; n: number}
  | {e: 2; s: string; t: string; d: number}
  | {e: 3; s: string; t: string; d: number; m: string}
  | {e: 4; s: string; t: string}
  | {e: 5; s: string}
  | {
      e: 6
      p: number
      f: number
      k: number
      o: number
      d: number
      hb?: number
      ha?: number
      tb?: number
      ta?: number
      pb?: number
      pa?: number
    }
  | {e: 7; s: string; m: string}
  | {e: 8; u: number; t: number; f?: number; mf?: number}
  | {e: 9; s: string; t: string}

const emit: (event: TestEvent) => void =
  typeof (globalThis as any).__testEmit === 'function'
    ? (event) => (globalThis as any).__testEmit(JSON.stringify(event))
    : (event) => console.log('__TEST__' + JSON.stringify(event))

function elapsedMs(start: MonotonicTimestamp): number {
  return Math.round(MonotonicTimestamp.now().since(start))
}

/** Format a thrown value for test output. Handles Error instances,
 * plain objects with `name`/`message` (like our Result error shapes
 * `{name: 'Network', message: '...'}`), and falls back to String(). */
function formatThrown(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const obj = e as {name?: unknown; message?: unknown}
    if (typeof obj.message === 'string') {
      return typeof obj.name === 'string' ? `${obj.name}: ${obj.message}` : obj.message
    }
  }
  return String(e)
}

function emitHeap(): void {
  gc()
  const mem = memoryUsage()
  const evt: TestEvent = {e: 8, u: mem.heapUsed, t: mem.heapTotal}
  if (mem.systemFree > 0) evt.f = mem.systemFree
  if (mem.systemMinFree > 0) evt.mf = mem.systemMinFree
  emit(evt)
}

async function run(): Promise<void> {
  let passed = 0
  let failed = 0
  let skipped = 0
  let todo = 0
  const startTime = MonotonicTimestamp.now()

  // Leak-detection baseline: captured after gc(), with all suites already
  // registered from module eval, so persistent harness allocations are
  // included in the baseline rather than counted as growth. The harness
  // recaptures after each suite's beforeAll resolves (see below), so
  // warmup costs (module loads, TLS lazy-init, wifi connection) get
  // folded into the baseline automatically.
  gc()
  heapBaseline = memoryUsage().heapUsed
  const timersBefore = activeTimers()
  const pendingBefore = pendingHttpCount()

  // If any suite or test is marked .only anywhere, filter everything else.
  const hasOnly = suites.some((s) => s.only || s.tests.some((t) => t.only))

  for (const suite of suites) {
    emitHeap()
    emit({e: 1, s: suite.name, n: suite.tests.length})

    if (suite.skip) {
      for (const t of suite.tests) {
        if (t.todo) {
          emit({e: 9, s: suite.name, t: t.name})
          todo++
        } else {
          emit({e: 4, s: suite.name, t: t.name})
          skipped++
        }
      }
      emit({e: 5, s: suite.name})
      continue
    }

    if (suite.todo) {
      for (const t of suite.tests) {
        emit({e: 9, s: suite.name, t: t.name})
        todo++
      }
      emit({e: 5, s: suite.name})
      continue
    }

    // Only-mode: skip entire suites that are not .only and contain no .only tests.
    const suiteHasOnlyTest = suite.tests.some((t) => t.only)
    if (hasOnly && !suite.only && !suiteHasOnlyTest) {
      for (const t of suite.tests) {
        if (t.todo) {
          emit({e: 9, s: suite.name, t: t.name})
          todo++
        } else {
          emit({e: 4, s: suite.name, t: t.name})
          skipped++
        }
      }
      emit({e: 5, s: suite.name})
      continue
    }

    // Within a participating suite, if any test is .only, skip the rest.
    const onlyInSuite = hasOnly && suiteHasOnlyTest

    if (suite.beforeAll) {
      try {
        await suite.beforeAll()
      } catch (e) {
        const msg = formatThrown(e)
        emit({e: 7, s: suite.name, m: msg})
        for (const t of suite.tests) {
          if (t.todo) {
            emit({e: 9, s: suite.name, t: t.name})
            todo++
          } else {
            emit({e: 4, s: suite.name, t: t.name})
            skipped++
          }
        }
        emit({e: 5, s: suite.name})
        continue
      }
      // Recapture the baseline now that beforeAll has fully resolved and
      // its closure frame is eligible for collection. Multi-suite files
      // let the last successful beforeAll set the baseline — fine because
      // every earlier suite's test allocations have already been bounded
      // by the previous (stricter) baseline.
      await captureHeapBaseline()
    }

    for (const t of suite.tests) {
      if (t.todo) {
        emit({e: 9, s: suite.name, t: t.name})
        todo++
        continue
      }

      if (t.skip) {
        emit({e: 4, s: suite.name, t: t.name})
        skipped++
        continue
      }

      if (onlyInSuite && !t.only) {
        emit({e: 4, s: suite.name, t: t.name})
        skipped++
        continue
      }

      emitHeap()
      const testTimeout = t.timeout ?? DEFAULT_TEST_TIMEOUT
      const testStart = MonotonicTimestamp.now()
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timeout (${testTimeout}ms)`)),
            testTimeout,
          )
          ;(async () => {
            for (const hook of suite.beforeEach) await hook()
            await t.fn()
          })().then(
            () => {
              clearTimeout(timer)
              resolve()
            },
            (e) => {
              clearTimeout(timer)
              reject(e)
            },
          )
        })
        emit({e: 2, s: suite.name, t: t.name, d: elapsedMs(testStart)})
        passed++
      } catch (e) {
        const msg = formatThrown(e)
        emit({e: 3, s: suite.name, t: t.name, d: elapsedMs(testStart), m: msg})
        failed++
      }
      for (const hook of suite.afterEach) {
        try {
          await hook()
        } catch {
          // afterEach errors are not fatal
        }
      }
    }

    if (suite.afterAll) {
      try {
        await suite.afterAll()
      } catch {
        // afterAll errors are not fatal
      }
    }

    emit({e: 5, s: suite.name})
  }

  gc()
  const heapAfter = memoryUsage().heapUsed
  const timersAfter = activeTimers()
  const pendingAfter = pendingHttpCount()

  emit({
    e: 6,
    p: passed,
    f: failed,
    k: skipped,
    o: todo,
    d: elapsedMs(startTime),
    hb: heapBaseline,
    ha: heapAfter,
    tb: timersBefore,
    ta: timersAfter,
    pb: pendingBefore,
    pa: pendingAfter,
  })

  // Signal the supervisor (if any) that this file is complete so it can
  // swap in the next runtime. No-op in non-test-harness contexts.
  ;(globalThis as any).__testFileDone?.()
}

// Auto-run after module evaluation completes
setTimeout(() => void run(), 0)

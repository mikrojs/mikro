import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, test} from 'vitest'

import {
  classifyBootSnapshot,
  classifyHeapSnapshot,
  heapTolerance,
  readBootSnapshot,
  readSnapshot,
  snapshotFilePath,
  writeBootSnapshot,
  writeSnapshot,
} from '../heapSnapshots.js'

let root: string

/** Create a test file under the root so it survives the prune-on-write pass. */
function touchTest(rel: string): string {
  const abs = pathlib.join(root, rel)
  mkdirSync(pathlib.dirname(abs), {recursive: true})
  writeFileSync(abs, '')
  return abs
}

beforeEach(() => {
  root = mkdtempSync(pathlib.join(tmpdir(), 'heap-snap-'))
})

afterEach(() => {
  rmSync(root, {recursive: true, force: true})
})

describe('read/write', () => {
  test('round-trips a value', () => {
    const file = touchTest('test/smoke.test.ts')
    writeSnapshot(root, file, 'esp32c6', 3296)
    expect(readSnapshot(root, file, 'esp32c6')).toBe(3296)
  })

  test('keys by project-relative posix path', () => {
    const file = touchTest('test/nested/smoke.test.ts')
    writeSnapshot(root, file, 'esp32c6', 42)
    const data = JSON.parse(readFileSync(snapshotFilePath(root, 'esp32c6'), 'utf-8'))
    expect(data).toEqual({tests: {'test/nested/smoke.test.ts': {heapDelta: 42}}})
  })

  test('missing file and missing entry both read as undefined', () => {
    const file = touchTest('test/smoke.test.ts')
    expect(readSnapshot(root, file, 'esp32c6')).toBeUndefined()
    writeSnapshot(root, file, 'esp32c6', 1)
    expect(readSnapshot(root, touchTest('test/other.test.ts'), 'esp32c6')).toBeUndefined()
  })

  test('a corrupt file reads as undefined instead of throwing', () => {
    const file = touchTest('test/smoke.test.ts')
    mkdirSync(pathlib.dirname(snapshotFilePath(root, 'esp32c6')), {recursive: true})
    writeFileSync(snapshotFilePath(root, 'esp32c6'), '{not json')
    expect(readSnapshot(root, file, 'esp32c6')).toBeUndefined()
  })

  test('writes sorted keys and a trailing newline', () => {
    writeSnapshot(root, touchTest('test/z.test.ts'), 'esp32c6', 1)
    writeSnapshot(root, touchTest('test/a.test.ts'), 'esp32c6', 2)
    const raw = readFileSync(snapshotFilePath(root, 'esp32c6'), 'utf-8')
    expect(Object.keys(JSON.parse(raw).tests)).toEqual(['test/a.test.ts', 'test/z.test.ts'])
    expect(raw.endsWith('\n')).toBe(true)
  })

  test('preserves unknown top-level keys, so future chip-wide figures survive', () => {
    const file = touchTest('test/a.test.ts')
    writeSnapshot(root, file, 'esp32c6', 1)
    const path = snapshotFilePath(root, 'esp32c6')
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    writeFileSync(path, JSON.stringify({...data, boot: {systemFree: 241664}}, null, 2))

    writeSnapshot(root, file, 'esp32c6', 2)
    const after = JSON.parse(readFileSync(path, 'utf-8'))
    expect(after.boot).toEqual({systemFree: 241664})
    expect(after.tests['test/a.test.ts']).toEqual({heapDelta: 2})
  })

  test('leaves no temp file behind', () => {
    writeSnapshot(root, touchTest('test/smoke.test.ts'), 'esp32c6', 1)
    expect(existsSync(`${snapshotFilePath(root, 'esp32c6')}.tmp`)).toBe(false)
  })
})

describe('merging', () => {
  test('a second test does not clobber the first', () => {
    writeSnapshot(root, touchTest('test/a.test.ts'), 'esp32c6', 1)
    writeSnapshot(root, touchTest('test/b.test.ts'), 'esp32c6', 2)
    expect(readSnapshot(root, pathlib.join(root, 'test/a.test.ts'), 'esp32c6')).toBe(1)
    expect(readSnapshot(root, pathlib.join(root, 'test/b.test.ts'), 'esp32c6')).toBe(2)
  })

  test('a second chip leaves the first chip untouched', () => {
    const file = touchTest('test/a.test.ts')
    writeSnapshot(root, file, 'esp32c6', 1)
    writeSnapshot(root, file, 'simulator', 2)
    expect(readSnapshot(root, file, 'esp32c6')).toBe(1)
    expect(readSnapshot(root, file, 'simulator')).toBe(2)
  })
})

describe('pruning', () => {
  test('drops entries whose test file is gone, keeps the rest', () => {
    const kept = touchTest('test/kept.test.ts')
    const gone = touchTest('test/gone.test.ts')
    writeSnapshot(root, kept, 'esp32c6', 1)
    writeSnapshot(root, gone, 'esp32c6', 2)
    rmSync(gone)

    writeSnapshot(root, kept, 'esp32c6', 3)
    const data = JSON.parse(readFileSync(snapshotFilePath(root, 'esp32c6'), 'utf-8'))
    expect(data).toEqual({tests: {'test/kept.test.ts': {heapDelta: 3}}})
  })
})

describe('boot snapshot', () => {
  const BOOT = {heapFree: 223232, systemFree: 241664, memReserved: 65536}

  test('round-trips both ceilings, and leaves tests alone', () => {
    const file = touchTest('test/a.test.ts')
    writeSnapshot(root, file, 'esp32c6', 3296)
    writeBootSnapshot(root, 'esp32c6', BOOT)

    expect(readBootSnapshot(root, 'esp32c6')).toEqual(BOOT)
    expect(readSnapshot(root, file, 'esp32c6')).toBe(3296)
  })

  test('a test run leaves boot alone', () => {
    const file = touchTest('test/a.test.ts')
    writeBootSnapshot(root, 'esp32c6', BOOT)
    writeSnapshot(root, file, 'esp32c6', 3296)
    expect(readBootSnapshot(root, 'esp32c6')).toEqual(BOOT)
  })

  test('reads as undefined when absent', () => {
    expect(readBootSnapshot(root, 'esp32c6')).toBeUndefined()
    writeSnapshot(root, touchTest('test/a.test.ts'), 'esp32c6', 1)
    expect(readBootSnapshot(root, 'esp32c6')).toBeUndefined()
  })
})

describe('classifyBootSnapshot', () => {
  test('less free heap than stored is the regression', () => {
    expect(classifyBootSnapshot(241664 - 300, 241664, 256)).toBe('exceeded')
  })

  test('more free heap than stored is an improvement to lock in', () => {
    expect(classifyBootSnapshot(241664 + 300, 241664, 256)).toBe('stale')
  })

  test('drift within the tolerance is ok in either direction', () => {
    expect(classifyBootSnapshot(241664 - 100, 241664, 256)).toBe('ok')
    expect(classifyBootSnapshot(241664 + 100, 241664, 256)).toBe('ok')
    expect(classifyBootSnapshot(241664 + 256, 241664, 256)).toBe('ok')
  })

  test('anything flagged is something -u will write', () => {
    const stored = 241664
    for (const tolerance of [64, 256, 1024]) {
      for (let free = stored - 4096; free <= stored + 4096; free += 37) {
        if (classifyBootSnapshot(free, stored, tolerance) === 'ok') continue
        expect(Math.abs(free - stored)).toBeGreaterThan(tolerance)
      }
    }
  })
})

describe('heapTolerance', () => {
  test('defaults to the larger of 256B and 1%', () => {
    expect(heapTolerance(3296)).toBe(256)
    expect(heapTolerance(37692)).toBe(376)
  })

  test('an override wins outright', () => {
    expect(heapTolerance(37692, 64)).toBe(64)
  })
})

describe('classifyHeapSnapshot', () => {
  test('drift within the tolerance is ok in either direction', () => {
    expect(classifyHeapSnapshot(3300, 3296, 256)).toBe('ok')
    expect(classifyHeapSnapshot(3100, 3296, 256)).toBe('ok')
  })

  test('exactly at the tolerance is still ok', () => {
    expect(classifyHeapSnapshot(3296 + 256, 3296, 256)).toBe('ok')
  })

  test('growth past the tolerance is exceeded', () => {
    expect(classifyHeapSnapshot(3600, 3296, 256)).toBe('exceeded')
  })

  test('a large drop is stale', () => {
    expect(classifyHeapSnapshot(2000, 3296, 256)).toBe('stale')
  })

  test('a wide tolerance widens the stale margin too', () => {
    // Without anchoring the margin to the tolerance this would report stale,
    // and -u would then decline to write it.
    expect(classifyHeapSnapshot(2000, 3296, 4096)).toBe('ok')
  })

  test('anything flagged is something -u will write', () => {
    for (const stored of [600, 3296, 12480, 37692]) {
      for (const tolerance of [64, 256, 1024, 4096]) {
        for (let delta = 0; delta <= stored * 2; delta += 37) {
          const action = classifyHeapSnapshot(delta, stored, tolerance)
          if (action === 'ok') continue
          expect(Math.abs(delta - stored)).toBeGreaterThan(tolerance)
        }
      }
    }
  })
})

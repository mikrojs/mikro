/* eslint-disable no-console -- console output is the feature under test */
import {env} from 'mikro/env'
import {exists, readStream} from 'mikro/fs'
import {decodeUtf8, splitLines} from 'mikro/stream'
import {assert, describe, test} from 'mikro/test'

// This app enables logFile with flush: 'line' in mikro.config.ts, so the
// firmware tees console output into /logs/log.txt (raw path /appfs/logs)
// and commits every completed line to flash. 'line' rather than the
// 'error' default so the probe can be a plain console.log — error-level
// output renders red in the suite. The durable-flush behavior under test
// (fsync, not just fflush) is the same code path for both policies.
// Simulator has no file logger.
//
// The log must be scanned as a stream: it rotates at 64KB, which matches
// the readFile cap (fs_read_max), so in a full-suite run both generations
// can exceed what readFile will return — and a whole-log string would be
// a large allocation on a small chip anyway.

const onDevice = env.get('MIKRO_ENV') !== 'simulator'

const LOG_PATH = '/logs/log.txt'
const ROTATED_PATH = '/logs/log.txt.1'

/** Last line containing `needle`, or undefined. A missing file is treated
 * as "not found" (the rotated generation may not exist yet); any other
 * error fails the test rather than masking as a missing marker. */
async function findLogLine(path: string, needle: string): Promise<string | undefined> {
  const r = readStream(path)
  if (!r.ok) {
    assert.equal(r.error.name, 'NotFound', `unexpected error reading ${path}: ${r.error.name}`)
    return undefined
  }
  let found: string | undefined
  for await (const line of splitLines(decodeUtf8(r.value))) {
    assert.ok(line)
    if (line.ok && line.value.includes(needle)) found = line.value
  }
  return found
}

describe.runIf(onDevice)('logFile', () => {
  test('log file exists once logging is enabled', () => {
    assert.equal(exists(LOG_PATH), true)
  })

  test('console.log line is flushed to the file with a timestamp', async () => {
    const marker = `logfile-probe-${Date.now()}`
    console.log(marker)
    // A rotation can land between the write and the scan, so check the
    // current generation first, then the rotated one.
    const line = (await findLogLine(LOG_PATH, marker)) ?? (await findLogLine(ROTATED_PATH, marker))
    assert.truthy(line !== undefined, 'marker line should be in the log file')
    assert.truthy(
      /^(\d{4}-\d{2}-\d{2}T|\[\+\d)/.test(line ?? ''),
      `line should start with a timestamp, got: ${line}`,
    )
  })
})

import {exists, mkdir, readDir, readStream, rmdir, stat, unlink, writeFile} from 'mikro/fs'
import {decodeUtf8, splitLines} from 'mikro/stream'
import {afterEach, assert, describe, test} from 'mikro/test'

// Split out of fs.test.ts: that file's bytecode alone sat right at the
// load-OOM line on esp32c3 (~171KB mem_limit), making the whole file
// flaky at load. Two smaller files each fit comfortably.

// All test paths live under /e2e-fs/ so cleanup is a single recursive walk
// and stray files from a crashed run don't leak into the next suite.
const ROOT = '/e2e-fs'

function rmrf(path: string): void {
  const s = stat(path)
  if (!s.ok) return
  if (s.value.isDirectory) {
    const entries = readDir(path)
    if (entries.ok) {
      for (const child of entries.value) rmrf(`${path}/${child.name}`)
    }
    // Best-effort cleanup — ignore failures.
    void rmdir(path).ok
  } else {
    void unlink(path).ok
  }
}

function cleanup(): void {
  if (exists(ROOT)) rmrf(ROOT)
}

function setup(): void {
  cleanup()
  const r = mkdir(ROOT)
  assert.ok(r)
}

describe('fs: readStream', () => {
  afterEach(cleanup)

  test('yields chunks until EOF', async () => {
    setup()
    const payload = 'The quick brown fox jumps over the lazy dog.'
    assert.ok(writeFile(`${ROOT}/fox.txt`, payload))

    const r = readStream(`${ROOT}/fox.txt`, {chunkSize: 8})
    assert.ok(r)
    const decoder = new TextDecoder()
    let out = ''
    for await (const chunk of r.value) {
      assert.ok(chunk)
      out += decoder.decode(chunk.value)
    }
    assert.equal(out, payload)
  })

  test('composes with decodeUtf8 and splitLines', async () => {
    setup()
    assert.ok(writeFile(`${ROOT}/lines.txt`, 'one\ntwo\nthree\n'))

    const r = readStream(`${ROOT}/lines.txt`)
    assert.ok(r)
    const lines: string[] = []
    for await (const line of splitLines(decodeUtf8(r.value))) {
      assert.ok(line)
      lines.push(line.value)
    }
    assert.deepEqual(lines, ['one', 'two', 'three'])
  })

  test('empty file yields no chunks', async () => {
    setup()
    assert.ok(writeFile(`${ROOT}/empty.txt`, ''))

    const r = readStream(`${ROOT}/empty.txt`)
    assert.ok(r)
    let chunks = 0
    for await (const _ of r.value) {
      chunks++
    }
    assert.equal(chunks, 0)
  })

  test('missing file returns FSError.NotFound', () => {
    const r = readStream(`${ROOT}/nope.txt`)
    assert.err(r)
    assert.equal(r.error.name, 'NotFound')
  })
})

import {
  exists,
  mkdir,
  readDir,
  readFile,
  readStream,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'mikrojs/fs'
import {decodeUtf8, splitLines} from 'mikrojs/stream'
import {afterEach, assert, describe, test} from 'mikrojs/test'

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

describe('fs: writeFile and readFile', () => {
  afterEach(cleanup)

  test('string roundtrip with utf-8 encoding', () => {
    setup()
    const w = writeFile(`${ROOT}/hello.txt`, 'hello world')
    assert.ok(w)
    const r = readFile(`${ROOT}/hello.txt`, 'utf-8')
    assert.ok(r)
    assert.equal(r.value, 'hello world')
  })

  test('Uint8Array roundtrip', () => {
    setup()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const w = writeFile(`${ROOT}/bytes.bin`, bytes)
    assert.ok(w)
    const r = readFile(`${ROOT}/bytes.bin`)
    assert.ok(r)
    assert.truthy(r.value instanceof Uint8Array)
    assert.equal(r.value.length, 5)
    assert.deepEqual(Array.from(r.value), [1, 2, 3, 4, 5])
  })

  test('empty file', () => {
    setup()
    const w = writeFile(`${ROOT}/empty.txt`, '')
    assert.ok(w)
    const str = readFile(`${ROOT}/empty.txt`, 'utf-8')
    assert.ok(str)
    assert.equal(str.value, '')
    const bytes = readFile(`${ROOT}/empty.txt`)
    assert.ok(bytes)
    assert.truthy(bytes.value instanceof Uint8Array)
    assert.equal(bytes.value.length, 0)
  })

  test('writeFile truncates by default', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/t.txt`, 'longer original content'))
    assert.ok(writeFile(`${ROOT}/t.txt`, 'short'))
    const r = readFile(`${ROOT}/t.txt`, 'utf-8')
    assert.ok(r)
    assert.equal(r.value, 'short')
  })

  test('writeFile append keeps existing content', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/a.txt`, 'one'))
    assert.ok(writeFile(`${ROOT}/a.txt`, '-two', {append: true}))
    assert.ok(writeFile(`${ROOT}/a.txt`, '-three', {append: true}))
    const r = readFile(`${ROOT}/a.txt`, 'utf-8')
    assert.ok(r)
    assert.equal(r.value, 'one-two-three')
  })

  test('writeFile create:false fails with NotFound when file missing', () => {
    setup()
    const r = writeFile(`${ROOT}/ghost.txt`, 'x', {create: false})
    assert.err(r)
    assert.equal(r.error.name, 'NotFound')
  })
})

describe('fs: exists', () => {
  afterEach(cleanup)

  test('true for existing file, false otherwise', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/here.txt`, 'x'))
    assert.equal(exists(`${ROOT}/here.txt`), true)
    assert.equal(exists(`${ROOT}/nope.txt`), false)
  })

  test('does not throw on nested nonexistent path', () => {
    assert.equal(exists('/definitely/not/a/real/path'), false)
  })
})

describe('fs: stat', () => {
  afterEach(cleanup)

  test('file stat reports size and isFile', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/s.txt`, 'hello'))
    const r = stat(`${ROOT}/s.txt`)
    assert.ok(r)
    assert.equal(r.value.size, 5)
    assert.equal(r.value.isFile, true)
    assert.equal(r.value.isDirectory, false)
  })

  test('directory stat reports isDirectory', () => {
    setup()
    const r = stat(ROOT)
    assert.ok(r)
    assert.equal(r.value.isDirectory, true)
    assert.equal(r.value.isFile, false)
  })

  test('mtime is a number or absent', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/m.txt`, 'x'))
    const r = stat(`${ROOT}/m.txt`)
    assert.ok(r)
    const {mtime} = r.value
    // Device may or may not track mtime depending on CONFIG_LITTLEFS_USE_MTIME.
    // When supported, a positive ms-since-epoch number; otherwise absent.
    assert.truthy(
      mtime === undefined || (typeof mtime === 'number' && mtime > 0),
      `unexpected mtime: ${mtime}`,
    )
  })

  test('stat on missing file fails with NotFound', () => {
    const r = stat(`${ROOT}/no-such-file`)
    assert.err(r)
    assert.equal(r.error.name, 'NotFound')
  })
})

describe('fs: readDir', () => {
  afterEach(cleanup)

  test('returns entries with name, isFile, isDirectory', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/file-a.txt`, 'a'))
    assert.ok(writeFile(`${ROOT}/file-b.txt`, 'b'))
    assert.ok(mkdir(`${ROOT}/subdir`))

    const r = readDir(ROOT)
    assert.ok(r)
    assert.equal(r.value.length, 3)

    const byName = new Map(r.value.map((e) => [e.name, e]))
    assert.equal(byName.get('file-a.txt')?.isFile, true)
    assert.equal(byName.get('file-a.txt')?.isDirectory, false)
    assert.equal(byName.get('subdir')?.isDirectory, true)
    assert.equal(byName.get('subdir')?.isFile, false)
  })

  test('empty directory returns empty array', () => {
    setup()
    const r = readDir(ROOT)
    assert.ok(r)
    assert.equal(r.value.length, 0)
  })
})

describe('fs: mkdir / rmdir / rename / unlink', () => {
  afterEach(cleanup)

  test('mkdir then rmdir', () => {
    setup()
    assert.ok(mkdir(`${ROOT}/d`))
    assert.equal(exists(`${ROOT}/d`), true)
    assert.ok(rmdir(`${ROOT}/d`))
    assert.equal(exists(`${ROOT}/d`), false)
  })

  test('mkdir recursive', () => {
    setup()
    assert.ok(mkdir(`${ROOT}/a/b/c`, {recursive: true}))
    const r = stat(`${ROOT}/a/b/c`)
    assert.ok(r)
    assert.equal(r.value.isDirectory, true)
  })

  test('rename moves a file', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/src.txt`, 'renamed'))
    assert.ok(rename(`${ROOT}/src.txt`, `${ROOT}/dst.txt`))
    assert.equal(exists(`${ROOT}/src.txt`), false)
    const r = readFile(`${ROOT}/dst.txt`, 'utf-8')
    assert.ok(r)
    assert.equal(r.value, 'renamed')
  })

  test('unlink removes a file', () => {
    setup()
    assert.ok(writeFile(`${ROOT}/gone.txt`, 'bye'))
    assert.ok(unlink(`${ROOT}/gone.txt`))
    assert.equal(exists(`${ROOT}/gone.txt`), false)
  })
})

describe('fs: FSError variants', () => {
  test('missing file surfaces FSError.NotFound', () => {
    const r = readFile('/absolutely-no-such-file.txt')
    assert.err(r)
    assert.equal(r.error.name, 'NotFound')
    if (r.error.name === 'NotFound') {
      assert.equal(r.error.path, '/absolutely-no-such-file.txt')
    }
  })

  test('writes under /app surface FSError.AccessDenied', () => {
    const r = writeFile('/app/should-not-write', 'x')
    assert.err(r)
    assert.equal(r.error.name, 'AccessDenied')
  })
})

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
      out += decoder.decode(chunk)
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
      lines.push(line)
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

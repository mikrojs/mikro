import {assert, describe, test} from 'mikro/test'

describe('TextEncoder / TextDecoder', () => {
  test('roundtrip ascii', () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    assert.equal(decoder.decode(encoder.encode('hello')), 'hello')
  })

  test('roundtrip unicode', () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const text = 'cafe\u0301 \u{1F600} \u00E6\u00F8\u00E5'
    assert.equal(decoder.decode(encoder.encode(text)), text)
  })

  test('encode returns Uint8Array', () => {
    const encoded = new TextEncoder().encode('abc')
    assert.instance(encoded, Uint8Array)
    assert.equal(encoded.length, 3)
    assert.equal(encoded[0], 97)
  })

  test('decode empty', () => {
    assert.equal(new TextDecoder().decode(new Uint8Array(0)), '')
  })

  test('accepts utf-8 / utf8 labels', () => {
    const a = new TextDecoder('utf-8')
    const b = new TextDecoder('utf8')
    // @ts-expect-error - won't throw, but not advisable
    const c = new TextDecoder('UTF-8')
    assert.equal(a.decode(new Uint8Array([0x68, 0x69])), 'hi')
    assert.equal(b.decode(new Uint8Array([0x68, 0x69])), 'hi')
    assert.equal(c.decode(new Uint8Array([0x68, 0x69])), 'hi')
  })

  test('unsupported label throws RangeError', () => {
    assert.throws(
      () =>
        // @ts-expect-error - throws, not supported
        new TextDecoder('utf-16le'),
    )
  })

  test('streaming decode across multibyte boundary', () => {
    const decoder = new TextDecoder()
    // "café" = 0x63 0x61 0x66 0xC3 0xA9; split inside 'é'
    const a = decoder.decode(new Uint8Array([0x63, 0x61, 0x66, 0xc3]), {stream: true})
    const b = decoder.decode(new Uint8Array([0xa9]), {stream: true})
    assert.equal(a + b, 'café')
  })

  test('non-stream trailing incomplete emits U+FFFD', () => {
    const decoder = new TextDecoder()
    const s = decoder.decode(new Uint8Array([0x41, 0xc3]))
    assert.equal(s, 'A\uFFFD')
  })

  test('invalid byte emits U+FFFD', () => {
    const s = new TextDecoder().decode(new Uint8Array([0x41, 0xff, 0x42]))
    assert.equal(s, 'A\uFFFDB')
  })

  test('final flush emits U+FFFD for held bytes', () => {
    const decoder = new TextDecoder()
    const a = decoder.decode(new Uint8Array([0xc3]), {stream: true})
    const b = decoder.decode()
    assert.equal(a, '')
    assert.equal(b, '\uFFFD')
  })
})

describe('btoa / atob', () => {
  test('roundtrip', () => {
    assert.equal(atob(btoa('hello world')), 'hello world')
  })

  test('btoa known value', () => {
    assert.equal(btoa('hello'), 'aGVsbG8=')
  })

  test('atob known value', () => {
    assert.equal(atob('aGVsbG8='), 'hello')
  })

  test('empty string', () => {
    assert.equal(btoa(''), '')
    assert.equal(atob(''), '')
  })
})

describe('timers', () => {
  test('setTimeout fires', async () => {
    const value = await new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 10)
    })
    assert.equal(value, 42)
  })

  test('clearTimeout prevents callback', async () => {
    let called = false
    const id = setTimeout(() => {
      called = true
    }, 10)
    clearTimeout(id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(called, false)
  })

  test('setInterval fires multiple times', async () => {
    let count = 0
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        count++
        if (count >= 3) {
          clearInterval(id)
          resolve()
        }
      }, 20)
    })
    assert.truthy(count >= 3, `expected >= 3 intervals, got ${count}`)
  })

  test('setTimeout with zero delay', async () => {
    const value = await new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 0)
    })
    assert.equal(value, 'done')
  })
})

/* eslint-disable no-console */
describe('console', () => {
  test('console.log exists', () => {
    assert.type(console.log, 'function')
  })

  test('console.warn exists', () => {
    assert.type(console.warn, 'function')
  })

  test('console.error exists', () => {
    assert.type(console.error, 'function')
  })

  test('console.info exists', () => {
    assert.type(console.info, 'function')
  })
})

describe('String iteration', () => {
  test('for...of over single-char string terminates after one step', () => {
    let count = 0
    let seen = ''
    for (const ch of '1') {
      count++
      seen += ch
      if (count > 2) break
    }
    assert.equal(count, 1)
    assert.equal(seen, '1')
  })

  test('for...of over multi-char string yields each codepoint once', () => {
    let seen = ''
    for (const ch of 'abc') seen += ch
    assert.equal(seen, 'abc')
  })

  test('[Symbol.iterator]().next() reports done after the last char', () => {
    const it = 'x'[Symbol.iterator]()
    const first = it.next()
    assert.equal(first.value, 'x')
    assert.equal(first.done, false)
    const second = it.next()
    assert.equal(second.done, true)
  })
})

describe('Error types', () => {
  test('Error has stack', () => {
    const e = new Error('test')
    assert.type(e.stack, 'string')
    assert.truthy(e.stack!.length > 0)
  })

  test('TypeError works', () => {
    const e = new TypeError('bad type')
    assert.instance(e, TypeError)
    assert.instance(e, Error)
    assert.equal(e.message, 'bad type')
  })
})

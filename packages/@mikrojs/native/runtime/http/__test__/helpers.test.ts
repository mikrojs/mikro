import {describe, expect, it} from 'vitest'

import {BodyConsumedError, makeResponse, prepareBody} from '../helpers.js'

describe('prepareBody', () => {
  it('defaults to null body with empty headers', () => {
    const {body, headers} = prepareBody({})
    expect(body).toBeNull()
    expect(headers).toEqual([])
  })

  it('preserves pair-array headers as-is', () => {
    const {headers} = prepareBody({
      headers: [
        ['X-A', '1'],
        ['X-A', '2'],
      ],
    })
    expect(headers).toEqual([
      ['X-A', '1'],
      ['X-A', '2'],
    ])
  })

  it('normalizes record headers to pairs preserving case', () => {
    const {headers} = prepareBody({headers: {'X-Device-Id': 'abc'}})
    expect(headers).toEqual([['X-Device-Id', 'abc']])
  })

  it('encodes string body as UTF-8', () => {
    const {body} = prepareBody({body: 'hei'})
    expect([body![0], body![1], body![2]]).toEqual([0x68, 0x65, 0x69])
  })

  it('passes Uint8Array body through untouched', () => {
    const raw = new Uint8Array([1, 2, 3, 4])
    const {body} = prepareBody({body: raw})
    expect(body).toBe(raw)
  })
})

function bodyFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes
    },
  }
}

describe('makeResponse', () => {
  it('ok=true for 200, false for non-2xx', () => {
    const ok200 = makeResponse({
      status: 200,
      statusText: 'OK',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new Uint8Array(0)),
    })
    expect(ok200.ok).toBe(true)

    const err503 = makeResponse({
      status: 503,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new Uint8Array(0)),
    })
    expect(err503.ok).toBe(false)
  })

  it('exposes statusText, url, and redirected', () => {
    const r = makeResponse({
      status: 200,
      statusText: 'OK',
      url: 'https://example.test/final',
      redirected: true,
      headers: [],
      body: bodyFromBytes(new Uint8Array(0)),
    })
    expect(r.statusText).toBe('OK')
    expect(r.url).toBe('https://example.test/final')
    expect(r.redirected).toBe(true)
  })

  it('get() returns first match case-insensitively, undefined when absent', () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [
        ['Content-Type', 'text/plain'],
        ['X-Trace', 'first'],
        ['x-trace', 'second'],
      ],
      body: bodyFromBytes(new Uint8Array(0)),
    })
    expect(r.get('content-type')).toBe('text/plain')
    expect(r.get('CONTENT-TYPE')).toBe('text/plain')
    expect(r.get('x-trace')).toBe('first')
    expect(r.get('x-missing')).toBeUndefined()
  })

  it('getAll() returns every matching value; empty array when absent', () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [
        ['Set-Cookie', 'a=1'],
        ['set-cookie', 'b=2, c=3'],
        ['Content-Type', 'text/plain'],
      ],
      body: bodyFromBytes(new Uint8Array(0)),
    })
    expect(r.getAll('set-cookie')).toEqual(['a=1', 'b=2, c=3'])
    expect(r.getAll('x-missing')).toEqual([])
  })

  it('text() decodes body', async () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new TextEncoder().encode('hei mikro')),
    })
    expect(await r.text()).toBe('hei mikro')
  })

  it('bytes() drains multi-chunk body into a single Uint8Array', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])]
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c
      },
    }
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body,
    })
    const merged = await r.bytes()
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5])
  })

  it('text() decodes multi-chunk UTF-8 with split codepoints', async () => {
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([0x68, 0xc3])
        yield new Uint8Array([0xa9, 0x6c, 0x6c, 0x6f])
      },
    }
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body,
    })
    expect(await r.text()).toBe('héllo')
  })

  it('body yields every chunk exactly once via iteration', async () => {
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([1])
        yield new Uint8Array([2, 3])
      },
    }
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body,
    })
    const collected: number[] = []
    for await (const chunk of r.body) collected.push(...chunk)
    expect(collected).toEqual([1, 2, 3])
  })

  it('throws BodyConsumed when text() is called twice', async () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new TextEncoder().encode('hello')),
    })
    await r.text()
    await expect(r.text()).rejects.toBeInstanceOf(BodyConsumedError)
  })

  it('throws BodyConsumed when text() is called after bytes()', async () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new TextEncoder().encode('hello')),
    })
    await r.bytes()
    await expect(r.text()).rejects.toBeInstanceOf(BodyConsumedError)
  })

  it('throws BodyConsumed when iterating body after text()', async () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new TextEncoder().encode('hello')),
    })
    await r.text()
    expect(() => r.body[Symbol.asyncIterator]()).toThrow(BodyConsumedError)
  })

  it('throws BodyConsumed when body is iterated twice', async () => {
    const r = makeResponse({
      status: 200,
      statusText: '',
      url: '',
      redirected: false,
      headers: [],
      body: bodyFromBytes(new TextEncoder().encode('hello')),
    })
    for await (const _ of r.body) {
      /* drain */
    }
    expect(() => r.body[Symbol.asyncIterator]()).toThrow(BodyConsumedError)
  })
})

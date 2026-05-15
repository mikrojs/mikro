import {err, matchError, ok} from 'mikrojs/result'
import {assert, describe, test} from 'mikrojs/test'

describe('result', () => {
  test('ok wraps value', () => {
    const r = ok(42)
    assert.equal(r.ok, true)
    assert.equal(r.value, 42)
  })

  test('err wraps error', () => {
    const r = err('bad')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'bad')
  })

  test('ok().map transforms value', () => {
    const r = ok(10).map((n) => n * 2)
    assert.equal(r.ok, true)
    assert.equal(r.value, 20)
  })

  test('err().map is a no-op', () => {
    const r = err('fail').map(() => 999)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'fail')
  })

  test('ok().mapErr is a no-op', () => {
    const r = ok(5).mapErr(() => 'mapped')
    assert.equal(r.ok, true)
    assert.equal(r.value, 5)
  })

  test('err().mapErr transforms error', () => {
    const r = err('a').mapErr((e) => e + 'b')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'ab')
  })

  test('ok().andThen chains', () => {
    const r = ok(3).andThen((n) => ok(n + 1))
    assert.equal(r.ok, true)
    assert.equal(r.value, 4)
  })

  test('ok().andThen can return err', () => {
    const r = ok(3).andThen(() => err('nope'))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'nope')
  })

  test('err().andThen short-circuits', () => {
    let called = false
    const r = err('stop').andThen(() => {
      called = true
      return ok(1)
    })
    assert.equal(r.ok, false)
    assert.equal(called, false)
  })

  test('match dispatches ok', () => {
    const result = ok(7).match({
      ok: (v) => `got ${v}`,
      err: () => 'nope',
    })
    assert.equal(result, 'got 7')
  })

  test('match dispatches err', () => {
    const result = err('x').match({
      ok: () => 'nope',
      err: (e) => `err: ${e}`,
    })
    assert.equal(result, 'err: x')
  })

  test('orPanic returns value for ok', () => {
    assert.equal(ok(99).orPanic('should not panic'), 99)
  })

  test('orPanic throws for err', () => {
    assert.throws(() => err('bad').orPanic('panicked'))
  })

  test('matchError dispatches on name with exhaustive handlers', () => {
    type E = {name: 'NotFound'; id: string} | {name: 'Invalid'; reason: string}
    const e1: E = {name: 'NotFound', id: 'abc'}
    const out1 = matchError(e1, {
      NotFound: (e) => `missing:${e.id}`,
      Invalid: (e) => `bad:${e.reason}`,
    })
    assert.equal(out1, 'missing:abc')

    const e2: E = {name: 'Invalid', reason: 'too short'}
    const out2 = matchError(e2, {
      NotFound: (e) => `missing:${e.id}`,
      Invalid: (e) => `bad:${e.reason}`,
    })
    assert.equal(out2, 'bad:too short')
  })
})

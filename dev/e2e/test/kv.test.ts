import {nvsStorage} from 'mikro/kv/nvs'
import {rtcStorage} from 'mikro/kv/rtc'
import {number, object, string} from 'mikro/schema'
import {afterAll, assert, describe, test} from 'mikro/test'

describe('kv: rtcStorage', () => {
  afterAll(() => {
    rtcStorage.clear()
  })

  test('set and get primitive', () => {
    const val = rtcStorage.createValue('test-str')
    assert.ok(val.set('hello'))
    assert.equal(val.get(), 'hello')
  })

  test('set and get object', () => {
    const val = rtcStorage.createValue('test-obj')
    assert.ok(val.set({x: 1, y: 'two'}))
    assert.deepEqual(val.get(), {x: 1, y: 'two'})
  })

  test('get returns undefined for missing key', () => {
    const val = rtcStorage.createValue('nonexistent')
    assert.equal(val.get(), undefined)
  })

  test('delete removes value', () => {
    const val = rtcStorage.createValue('test-del')
    assert.ok(val.set(42))
    assert.equal(val.get(), 42)
    assert.ok(val.delete())
    assert.equal(val.get(), undefined)
  })

  test('update modifies value', () => {
    const val = rtcStorage.createValue('test-upd')
    assert.ok(val.set(10))
    assert.ok(val.update((v) => (v as number) + 5))
    assert.equal(val.get(), 15)
  })

  test('info returns storage stats', () => {
    const info = rtcStorage.info()
    assert.type(info, 'object')
  })

  test('clear removes all values', () => {
    const a = rtcStorage.createValue('clear-a')
    const b = rtcStorage.createValue('clear-b')
    assert.ok(a.set(1))
    assert.ok(b.set(2))
    rtcStorage.clear()
    assert.equal(a.get(), undefined)
    assert.equal(b.get(), undefined)
  })
})

describe('kv: nvsStorage', () => {
  afterAll(() => {
    nvsStorage.clear()
  })

  test('set and get string', () => {
    const val = nvsStorage.createValue('nvs-str')
    assert.ok(val.set('persistent'))
    assert.equal(val.get(), 'persistent')
  })

  test('set and get number', () => {
    const val = nvsStorage.createValue('nvs-num')
    assert.ok(val.set(3.14))
    assert.equal(val.get(), 3.14)
  })

  test('set and get object', () => {
    const val = nvsStorage.createValue('nvs-obj')
    assert.ok(val.set({key: 'value', n: 42}))
    assert.deepEqual(val.get(), {key: 'value', n: 42})
  })

  test('schema validation on set', () => {
    const val = nvsStorage.createValue('nvs-schema', {
      schema: object({name: string(), count: number()}),
    })
    assert.ok(val.set({name: 'test', count: 1}))
    assert.equal((val.get() as any).name, 'test')

    const bad = val.set('not an object' as any)
    assert.err(bad)
  })

  test('delete removes value', () => {
    const val = nvsStorage.createValue('nvs-del')
    assert.ok(val.set('bye'))
    assert.ok(val.delete())
    assert.equal(val.get(), undefined)
  })

  test('info returns storage stats', () => {
    const info = nvsStorage.info()
    assert.type(info, 'object')
  })
})

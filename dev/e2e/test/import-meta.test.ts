import {assert, describe, test} from 'mikro/test'

describe('import.meta', () => {
  test('import.meta.url is a string', () => {
    assert.type(import.meta.url, 'string')
    assert.truthy(import.meta.url.length > 0)
  })

  test('import.meta.main is true for entry module', () => {
    assert.type(import.meta.main, 'boolean')
    assert.equal(import.meta.main, true)
  })

  test('import.meta.env is an object', () => {
    assert.type(import.meta.env, 'object')
    assert.truthy(import.meta.env !== null)
  })

  test('import.meta.env returns undefined for missing keys', () => {
    assert.equal(import.meta.env.DEFINITELY_NOT_SET_12345, undefined)
  })
})

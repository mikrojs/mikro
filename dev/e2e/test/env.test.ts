import {env} from 'mikrojs/env'
import {assert, describe, test} from 'mikrojs/test'

describe('env', () => {
  test('get returns undefined for missing key', () => {
    assert.equal(env.get('DEFINITELY_NOT_SET_XYZ'), undefined)
  })

  test('has returns false for missing key', () => {
    assert.equal(env.has('DEFINITELY_NOT_SET_XYZ'), false)
  })

  test('require throws for missing key', () => {
    const err = assert.throws(() => env.require('DEFINITELY_NOT_SET_XYZ'))
    assert.truthy(err.message.includes('DEFINITELY_NOT_SET_XYZ'))
  })

  test('import.meta.env returns undefined for missing key', () => {
    // Verify the proxy no longer throws
    const val = import.meta.env.DEFINITELY_NOT_SET_XYZ
    assert.equal(val, undefined)
  })

  test('MIKRO_ENV is set by the test runner', () => {
    // sim test sets 'simulator', device test sets 'test'
    const value = env.get('MIKRO_ENV')
    assert.truthy(value === 'test' || value === 'simulator', `unexpected MIKRO_ENV: ${value}`)
    assert.equal(env.has('MIKRO_ENV'), true)
    assert.equal(env.require('MIKRO_ENV'), value)
    assert.equal(import.meta.env.MIKRO_ENV, value)
  })
})

import {encode as cborEncode} from 'mikro/cbor'
import {env} from 'mikro/env'
import {ok} from 'mikro/result'
import {parse, string} from 'mikro/schema'
import {stdout} from 'mikro/stdio'
import {version} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

// Verify built-in modules load and export the right types.
// Hardware modules that cost ~6KB each live in modules-hw.test.ts,
// network modules in modules-network.test.ts, so each group gets a
// fresh heap and low-memory chips can skip the groups that don't fit.

describe('module: stdio', () => {
  test('stdout.write exists', () => {
    assert.type(stdout.write, 'function')
  })
})

describe('module: env (smoke)', () => {
  test('env.get/has/require exist', () => {
    assert.type(env.get, 'function')
    assert.type(env.has, 'function')
    assert.type(env.require, 'function')
  })
})

describe('module: result (smoke)', () => {
  test('ok/err are callable', () => {
    assert.equal(ok(1).ok, true)
  })
})

describe('module: schema (smoke)', () => {
  test('parse is callable', () => {
    assert.ok(parse(string(), 'test'))
  })
})

describe('module: cbor (smoke)', () => {
  test('encode is callable', () => {
    assert.ok(cborEncode(42))
  })
})

describe('module: sys (smoke)', () => {
  test('version is accessible', () => {
    assert.type(version, 'string')
  })
})

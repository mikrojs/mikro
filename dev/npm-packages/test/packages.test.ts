import {prettyMs as prettyMsOfUptime, uptime, version} from '@repo/uptime'
import {short} from '@repo/uptime/formats/short'
import {assert, describe, test} from 'mikro/test'
import prettyMs from 'pretty-ms'

// The build resolves every import below on the host and rewrites it to a
// relative path. These tests pass only if the device then loads the right file.
describe('npm packages', () => {
  test('a package from the registry, with a dependency of its own', () => {
    assert.equal(prettyMs(123_456), '2m 3.4s')
  })

  test('a linked package: condition object, #imports, its own package.json', () => {
    assert.equal(uptime(), '1m 1s')
    assert.equal(version, '1.2.3')
  })

  test('a wildcard subpath export', () => {
    assert.equal(short(61_000), '1m')
  })

  test('two versions of a package load as two modules', () => {
    assert.notEqual(prettyMs, prettyMsOfUptime)
  })

  test('an import() between two literals', async () => {
    const norwegian = Date.now() < 0
    const {greeting} = await import(norwegian ? '../app/lang/no.js' : '../app/lang/en.js')
    assert.equal(greeting, 'hello')
  })

  // The build leaves a computed name alone, so this one goes through the
  // device's own resolver and the package.json the build generates. The REPL
  // imports packages the same way.
  test('a package by name at runtime', async () => {
    const name = ['pretty', 'ms'].join('-')
    const byName = await import(name)
    assert.equal(byName.default, prettyMs)
  })
})

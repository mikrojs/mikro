import {execFileSync} from 'node:child_process'
import {join} from 'node:path'

import {scriptsPath} from '@mikrojs/native/cmake'
import {expect, test} from 'vitest'

/* Pins the exact lists the CMake builds derive from runtime/modules.json, so
 * an accidental table edit (rename, reorder, dropped module) shows up here as
 * a reviewable diff instead of silently changing firmware contents. */

const script = join(scriptsPath, 'modules-list.js')

/** One of the lists the script prints, for the given gate flags. */
function run(list, ...args) {
  const lists = JSON.parse(execFileSync(process.execPath, [script, ...args], {encoding: 'utf8'}))
  return lists[list].split(';')
}

const deviceBytecode = [
  'abort',
  'cbor',
  'env',
  'result',
  'schema',
  'fs',
  'http/server',
  'kv/nvs',
  'kv/rtc',
  'kv/shared',
  'module',
  'observable',
  'observable/lazy',
  'ota',
  'ota/client',
  'ota/config',
  'reader',
  'sleep',
  'sntp',
  'stdio',
  'stream',
  'sys',
  'test',
  'udp',
  'watchdog',
]

const deviceNative = [
  'http_server',
  'nvs_kv',
  'rtc',
  'ota',
  'ota_client',
  'sleep',
  'sntp',
  'gpio',
  'i2c',
  'i2s',
  'spi',
  'uart',
  'pwm',
  'neopixel',
  'http',
]

test('bytecode list for a device build with BLE and WiFi', () => {
  expect(run('bytecode', '--ble=on', '--wifi=on')).toEqual([...deviceBytecode, 'ble'])
})

test('bytecode list for a device build without BLE', () => {
  expect(run('bytecode', '--ble=off', '--wifi=on')).toEqual(deviceBytecode)
})

test('bytecode list is unchanged without WiFi (http/server stays compiled)', () => {
  expect(run('bytecode', '--ble=on', '--wifi=off')).toEqual([...deviceBytecode, 'ble'])
})

test('bytecode list for the host build includes everything', () => {
  expect(run('bytecode', '--host')).toEqual([...deviceBytecode, 'ble'])
})

test('native force-include list for a device build with BLE and WiFi', () => {
  expect(run('native', '--ble=on', '--wifi=on')).toEqual([
    ...deviceNative.slice(0, 7),
    'ble',
    ...deviceNative.slice(7),
    'wifi',
  ])
})

test('native force-include list drops wifi and ble with their gates', () => {
  expect(run('native', '--ble=off', '--wifi=off')).toEqual(deviceNative)
})

test('device builds must pass both gates', () => {
  expect(() => run('bytecode', '--ble=on')).toThrow()
})

test('feature list follows the compile gates', () => {
  expect(run('features', '--ble=on', '--wifi=on')).toEqual(['wifi', 'ble', 'i2s'])
  expect(run('features', '--ble=off', '--wifi=on')).toEqual(['wifi', 'i2s'])
  expect(run('features', '--ble=on', '--wifi=off')).toEqual(['ble', 'i2s'])
  expect(run('features', '--host')).toEqual(['wifi', 'ble', 'i2s'])
})

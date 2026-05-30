// Import every mikrojs/* module to measure memory impact
import {decode, encode} from 'mikro/cbor'
import {env} from 'mikro/env'
import {request} from 'mikro/http/request'
import {I2c} from 'mikro/i2c'
import {nvsStorage} from 'mikro/kv/nvs'
import {rtcStorage} from 'mikro/kv/rtc'
import {NeoPixel} from 'mikro/neopixel'
import {analogRead, digitalRead, digitalWrite, pinMode} from 'mikro/pin'
import {Pwm} from 'mikro/pwm'
import {err, matchError, ok} from 'mikro/result'
import * as s from 'mikro/schema'
import {sleep} from 'mikro/sleep'
import {sntp} from 'mikro/sntp'
import {Spi} from 'mikro/spi'
import {stdin, stdout} from 'mikro/stdio'
import {board, firmware, gc, memoryUsage, version} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

function logMem(label: string) {
  gc()
  const m = memoryUsage()
  const jsHeapFree = m.heapTotal - m.heapUsed
  console.log(
    `[mem] ${label}: js=${jsHeapFree / 1000}KB sys=${m.systemFree / 1000}KB peak=${(m.systemTotal - m.systemMinFree) / 1000}KB`,
  )
}

logMem('after all imports')

// Touch each import so nothing gets eliminated
console.log('cbor:', typeof encode, typeof decode)
console.log('request:', typeof request)
console.log('i2c:', typeof I2c)
console.log('kv:', typeof nvsStorage, typeof rtcStorage)
console.log('neopixel:', typeof NeoPixel)
console.log('pin:', typeof pinMode, typeof digitalWrite, typeof digitalRead, typeof analogRead)
console.log('pwm:', typeof Pwm)
console.log('result:', typeof ok, typeof err, typeof matchError)
console.log('schema:', typeof s.string, typeof s.object, typeof s.parse)
console.log('sleep:', typeof sleep)
console.log('sntp:', typeof sntp)
console.log('spi:', typeof Spi)
console.log('stdio:', typeof stdin, typeof stdout)
console.log('wifi:', typeof wifi)
console.log('sys:', version, board.chip, firmware.idfVersion)

// --- cbor ---
const encodeResult = encode({hello: 'world', n: 42, pi: 3.14})
if (encodeResult.ok) {
  const decodeResult = decode(encodeResult.value)
  console.log('cbor round-trip:', decodeResult.ok ? decodeResult.value : decodeResult.error.name)
}
logMem('after cbor')

// --- schema ---
const schema = s.object({name: s.string(), age: s.number()})
const parsed = s.parse(schema, {name: 'test', age: 1})
console.log('schema parse:', parsed)
logMem('after schema')

// --- kv ---
const testVal = nvsStorage.createValue('test-key')
const kvWrite = testVal.set({ts: Date.now()})
console.log('kv write:', kvWrite)
const kvRead = testVal.get()
console.log('kv read:', kvRead)
logMem('after kv')

// --- pin ---
const pinResult = pinMode(21, 'OUTPUT')
console.log('pin mode:', pinResult)
const writePin = digitalWrite(21, 1)
console.log('pin write:', writePin)
const readPin = digitalRead(21)
console.log('pin read:', readPin)
logMem('after pin')

// --- pwm ---
const pwm = new Pwm(2, {freq: 1000})
console.log('pwm duty:', pwm.duty(0.5))
await sleep(100)
console.log('pwm end:', pwm.end())
logMem('after pwm')

// --- i2c ---
const i2c = new I2c(0, {sda: 6, scl: 7})
console.log('i2c begin:', i2c.begin())
console.log('i2c scan:', i2c.scan())
console.log('i2c end:', i2c.end())
logMem('after i2c')

// --- neopixel ---
const neo = new NeoPixel(8, {count: 1})
console.log('neopixel setPixel:', neo.setPixel(0, 255, 0, 0))
console.log('neopixel show:', neo.show())
console.log('neopixel clear:', neo.clear())
console.log('neopixel end:', neo.end())
logMem('after neopixel')

// --- wifi ---
const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')
console.log('connecting to wifi...')
logMem('before wifi connect')

if (WIFI_SSID && WIFI_PASSPHRASE) {
  const connectResult = await wifi.connect(WIFI_SSID, WIFI_PASSPHRASE)
  console.log('wifi connect:', connectResult)
  logMem('after wifi connect')

  if (connectResult.ok) {
    // --- sntp ---
    const sntpResult = await sntp.sync({timeout: 10_000})
    console.log('sntp sync:', sntpResult)
    console.log('time after sntp:', new Date().toLocaleString())
    logMem('after sntp')

    // --- request ---
    const requestResult = await request('https://jsonplaceholder.typicode.com/posts/1')
    if (requestResult.ok) {
      console.log('request status:', requestResult.value.status)
      const body = await requestResult.value.json()
      console.log('request body:', body)
    } else {
      console.error('request failed:', requestResult.error.name)
    }
    logMem('after request 1')

    // --- request 2 (memory reclaimed?) ---
    const requestResult2 = await request('https://jsonplaceholder.typicode.com/posts/2')
    if (requestResult2.ok) {
      console.log('request 2 status:', requestResult2.value.status)
      const body2 = await requestResult2.value.json()
      console.log('request 2 body title:', (body2 as {title: unknown}).title)
    } else {
      console.error('request 2 failed:', requestResult2.error.name)
    }
    logMem('after request 2')
  }
} else {
  console.log('Skipping request, no WIFI_SSID/WIFI_PASSPHRASE env var set')
}
logMem('done')

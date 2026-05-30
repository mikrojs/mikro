import {bleBuiltin} from './ble.js'
import {consoleBuiltin} from './console.js'
import {httpBuiltin} from './http.js'
import {i2cBuiltin} from './i2c.js'
import {kvBuiltin} from './kv.js'
import {neopixelBuiltin} from './neopixel.js'
import {nvsKvBuiltin} from './nvs-kv.js'
import {pinBuiltin} from './pin.js'
import {pwmBuiltin} from './pwm.js'
import {sleepBuiltin} from './sleep.js'
import {sntpBuiltin} from './sntp.js'
import {spiBuiltin} from './spi.js'
import type {BuiltinDefinition, BuiltinName} from './types.js'
import {uartBuiltin} from './uart.js'
import {wifiBuiltin} from './wifi.js'

export type {BuiltinDefinition, BuiltinName} from './types.js'

/** Module name mapping: builtin name → native:* module name */
export const builtinModuleNames: Record<BuiltinName, string> = {
  ble: 'native:ble',
  pin: 'native:pin',
  pwm: 'native:pwm',
  neopixel: 'native:neopixel',
  wifi: 'native:wifi',
  i2c: 'native:i2c',
  spi: 'native:spi',
  uart: 'native:uart',
  kv: 'native:rtc',
  nvs_kv: 'native:nvs_kv',
  sleep: 'native:sleep',
  http: 'native:http',
  sntp: 'native:sntp',
  console: 'native:console',
}

/** Default builtin implementations for the dev runner */
export const defaultBuiltins: Record<BuiltinName, BuiltinDefinition> = {
  ble: bleBuiltin,
  pin: pinBuiltin,
  pwm: pwmBuiltin,
  neopixel: neopixelBuiltin,
  kv: kvBuiltin,
  nvs_kv: nvsKvBuiltin,
  sleep: sleepBuiltin,
  wifi: wifiBuiltin,
  i2c: i2cBuiltin,
  spi: spiBuiltin,
  uart: uartBuiltin,
  http: httpBuiltin,
  sntp: sntpBuiltin,
  console: consoleBuiltin,
}

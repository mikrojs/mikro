/** Map of builtin name to its native:* module name */
export type BuiltinModuleMap = {
  ble: 'native:mikro/ble'
  pin: 'native:mikro/pin'
  pwm: 'native:mikro/pwm'
  neopixel: 'native:mikro/neopixel'
  wifi: 'native:mikro/wifi'
  i2c: 'native:mikro/i2c'
  spi: 'native:mikro/spi'
  uart: 'native:mikro/uart'
  kv: 'native:mikro/rtc'
  nvs_kv: 'native:mikro/nvs_kv'
  ota: 'native:mikro/ota'
  sleep: 'native:mikro/sleep'
  http: 'native:mikro/http'
  sntp: 'native:mikro/sntp'
  console: 'native:console'
}

export type BuiltinName = keyof BuiltinModuleMap

/** A builtin definition: JS source that replaces the native C module in the simulator */
export interface BuiltinDefinition {
  /** Raw module source string that runs inside QuickJS */
  source: string
}

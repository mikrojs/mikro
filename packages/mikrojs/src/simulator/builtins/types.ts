/** Map of builtin name to its native:* module name */
export type BuiltinModuleMap = {
  ble: 'native:ble'
  pin: 'native:pin'
  pwm: 'native:pwm'
  neopixel: 'native:neopixel'
  wifi: 'native:wifi'
  i2c: 'native:i2c'
  spi: 'native:spi'
  uart: 'native:uart'
  kv: 'native:rtc'
  nvs_kv: 'native:nvs_kv'
  sleep: 'native:sleep'
  http: 'native:http'
  sntp: 'native:sntp'
  console: 'native:console'
}

export type BuiltinName = keyof BuiltinModuleMap

/** A builtin definition: JS source that replaces the native C module in the simulator */
export interface BuiltinDefinition {
  /** Raw module source string that runs inside QuickJS */
  source: string
}

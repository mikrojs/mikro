/** Map of builtin name to the module name it replaces */
export type BuiltinModuleMap = {
  ble: 'native:mikro/ble'
  gpio: 'mikro/gpio'
  pwm: 'mikro/pwm'
  neopixel: 'mikro/neopixel'
  wifi: 'native:mikro/wifi'
  i2c: 'native:mikro/i2c'
  spi: 'mikro/spi'
  uart: 'native:mikro/uart'
  kv: 'native:mikro/rtc'
  nvs_kv: 'native:mikro/nvs_kv'
  ota_client: 'native:mikro/ota_client'
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

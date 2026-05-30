import {httpBuiltin} from './builtins/http.js'
import {i2cBuiltin} from './builtins/i2c.js'
import {pinBuiltin} from './builtins/pin.js'
import {spiBuiltin} from './builtins/spi.js'
import type {BuiltinName} from './builtins/types.js'
import {wifiBuiltin} from './builtins/wifi.js'

/** Builtin names that get auto-scaffolded when first used without a user stub */
export const SCAFFOLDABLE_BUILTINS = new Set<BuiltinName>(['wifi', 'http', 'pin', 'i2c', 'spi'])

/** Get the scaffold template for a builtin. Returns the source string from the default stub. */
export function getScaffoldTemplate(name: BuiltinName): string | undefined {
  if (!SCAFFOLDABLE_BUILTINS.has(name)) return undefined
  const templates: Partial<Record<BuiltinName, string>> = {
    wifi: wifiBuiltin.source,
    http: httpBuiltin.source,
    pin: pinBuiltin.source,
    i2c: i2cBuiltin.source,
    spi: spiBuiltin.source,
  }
  return templates[name]
}

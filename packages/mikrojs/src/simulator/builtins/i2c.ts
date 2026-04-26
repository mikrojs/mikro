import type {BuiltinDefinition} from './types.js'

export const i2cBuiltin: BuiltinDefinition = {
  source: `// Simulator stub for i2c
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikrojs/result'
import type {SimI2c} from 'mikrojs/sim'

export class I2c implements SimI2c {
  constructor(_busNo: number, _options?: Record<string, unknown>) {}
  begin() { return ok() }
  end() { return ok() }
  scan() { return ok(new Uint8Array()) }
  write(_address: number, _data: Uint8Array, _stop?: boolean) { return ok() }
  read(_address: number, bytes: number) { return ok(new Uint8Array(bytes)) }
}
`,
}

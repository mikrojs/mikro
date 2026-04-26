import type {BuiltinDefinition} from './types.js'

export const spiBuiltin: BuiltinDefinition = {
  source: `// Simulator stub for spi
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {ok} from 'mikrojs/result'
import type {SimSpi} from 'mikrojs/sim'

export class Spi implements SimSpi {
  constructor(_hostNo: number, _options: Record<string, unknown>) {}
  begin() { return ok() }
  end() { return ok() }
  transfer(data: Uint8Array) { return ok(new Uint8Array(data.length)) }
  write(_data: Uint8Array) { return ok() }
}
`,
}

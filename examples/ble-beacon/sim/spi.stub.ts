// Simulator stub for spi
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import type {SimSpi} from 'mikro/sim'

export class Spi implements SimSpi {
  constructor(_hostNo: number, _options: Record<string, unknown>) {}
  begin() {
    return {ok: true as const}
  }
  end() {
    return {ok: true as const}
  }
  transfer(data: Uint8Array) {
    return {ok: true as const, value: new Uint8Array(data.length)}
  }
  write(_data: Uint8Array) {
    return {ok: true as const}
  }
}

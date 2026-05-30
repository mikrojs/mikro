// Simulator stub for i2c
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import type {SimI2c} from 'mikro/sim'

export class I2c implements SimI2c {
  constructor(_busNo: number, _options?: Record<string, unknown>) {}
  begin() {
    return {ok: true as const}
  }
  end() {
    return {ok: true as const}
  }
  scan() {
    return {ok: true as const, value: new Uint8Array()}
  }
  write(_address: number, _data: Uint8Array, _stop?: boolean) {
    return {ok: true as const}
  }
  read(_address: number, bytes: number) {
    return {ok: true as const, value: new Uint8Array(bytes)}
  }
}

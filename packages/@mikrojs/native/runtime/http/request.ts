import * as native from 'native:mikro/http'

import {createRequestFromNative} from './native.js'

/**
 * Default HTTP request for the mikrojs runtime. Uses the ESP32 `native:mikro/http`
 * transport, which streams response bodies chunk-by-chunk with reader-driven
 * backpressure, integrates with `AbortSignal`, and enforces total-wallclock
 * timeouts.
 *
 * For `RequestError`, `BodyConsumedError`, `prepareBody`, `makeResponse`, or
 * any of the shared types, import from `mikrojs/http/helpers`. That subpath
 * has no dependency on `native:mikro/http`, so importing it from custom transports
 * (e.g. an LTE modem) doesn't retain the WiFi-backed HTTP stack.
 */
export const request = createRequestFromNative(native)

/**
 * Number of in-flight requests whose terminal message has not yet been
 * consumed. Primarily useful in tests and diagnostic code to verify that
 * cancel + drain correctly releases request slots.
 */
export function pendingCount(): number {
  return native.pendingCount()
}

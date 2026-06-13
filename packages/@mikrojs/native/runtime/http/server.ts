import * as native from 'native:mikro/http_server'

import {createServerFromNative} from './server-impl.js'

/**
 * Create an HTTP server backed by the ESP32 `esp_http_server`. Lazy: nothing
 * binds until `listen()`. The handler runs per request on the event loop and
 * returns `{status, headers?, body?}`; `body` may be a string, `Uint8Array`, or
 * an async iterable (e.g. an async generator) for a streamed response.
 *
 *     const server = createServer((req) => {
 *       if (req.url === '/') return {status: 200, body: 'Hello'}
 *       return {status: 404, body: 'not found'}
 *     })
 *     const r = server.listen({port: 80})
 *     if (!r.ok) return // ServerError
 */
export const createServer = createServerFromNative(native)

export type {
  CreateServer,
  Handler,
  PanicHandler,
  RequestHeaders,
  Server,
  ServerOptions,
  ServerRequest,
  ServerResponse,
} from './server-impl.js'
export {ServerError} from './server-impl.js'

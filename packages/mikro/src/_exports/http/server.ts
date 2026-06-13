// Pure-types entry for `mikro/http/server`. Runtime values are provided
// on-device by the bundled `http/server` bytecode module. This file declares
// the shapes so TypeScript and host tooling can see them without pulling in
// `native:mikro/http_server`.

import type {
  CreateServer,
  Handler,
  PanicHandler,
  RequestHeaders,
  Server,
  ServerOptions,
  ServerRequest,
  ServerResponse,
} from '@mikrojs/native/runtime/http/server-impl'

export declare const createServer: CreateServer
export declare const ServerError: {
  AlreadyListening(): {readonly name: 'AlreadyListening'}
  OutOfMemory(message: string): {readonly name: 'OutOfMemory'; readonly message: string}
  StartFailed(message: string): {readonly name: 'StartFailed'; readonly message: string}
}

export type {
  CreateServer,
  Handler,
  PanicHandler,
  RequestHeaders,
  Server,
  ServerOptions,
  ServerRequest,
  ServerResponse,
}

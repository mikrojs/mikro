// Pure-types entry for `mikro/http/request`. Runtime values are provided
// by the native C module in @mikrojs/native/src/mik_http_client.cpp, which
// drives the `native:mikro/http` transport (replaced by a stub in the
// simulator). This file declares the shapes so TypeScript and host tooling
// can see them without pulling in `native:mikro/http`.
//
// For `RequestError`, `BodyConsumedError`, `prepareBody`, `makeResponse`, or
// the shared types, import from `mikro/http/helpers` directly -- that
// subpath has no `native:mikro/http` dependency.

import type {Request} from '@mikrojs/native/runtime/http/helpers'

export declare const request: Request
export declare function pendingCount(): number

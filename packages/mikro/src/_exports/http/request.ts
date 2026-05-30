// Pure-types entry for `mikro/http/request`. Runtime values are provided
// on-device by the bundled `http/request` bytecode module (and by a stub in
// the simulator). This file declares the shapes so TypeScript and host
// tooling can see them without pulling in `native:http`.
//
// For `RequestError`, `BodyConsumedError`, `prepareBody`, `makeResponse`, or
// the shared types, import from `mikro/http/helpers` directly -- that
// subpath has no `native:http` dependency.

import type {Request} from '@mikrojs/native/runtime/http/helpers'

export declare const request: Request
export declare function pendingCount(): number

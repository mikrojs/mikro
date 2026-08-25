// Pure-types entry for `mikro/ota/client`. Runtime values are provided
// on-device by the bundled `ota/client` bytecode module. This file declares
// the shapes so TypeScript and host tooling can see them without pulling in
// the on-device wiring.

import type {
  BeforeCheckResult,
  CheckError,
  CheckOptions,
  CheckResult,
  DeclineReason,
  Teardown,
  Watcher,
  WatchOptions,
} from '@mikrojs/native/runtime/ota/types'

export declare function check(options?: CheckOptions): Promise<CheckResult>
export declare function watch(options?: WatchOptions): Watcher

export type {
  BeforeCheckResult,
  CheckError,
  CheckOptions,
  CheckResult,
  DeclineReason,
  Teardown,
  Watcher,
  WatchOptions,
}

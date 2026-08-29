// The OTA check-in client. The state machine lives in C
// (src/mik_ota_client.cpp); this is the app-facing surface over it.
//
// There is deliberately no logic here. Every decision — the retry budget, the
// trial gates, the config slots, the jittered cadence, the download pump with
// its resume — is in the portable library, where host tests drive it against a
// fake platform.

import {check as nativeCheck, watch as nativeWatch} from 'native:mikro/ota_client'

export type {
  BeforeCheckResult,
  CheckError,
  CheckOptions,
  CheckResult,
  DeclineReason,
  NotEnrolledError,
  Teardown,
  Watcher,
  WatchOptions,
} from './types.js'

/**
 * One-shot update check for wake-cycle apps: check in with the registry,
 * confirm the running trial, and download + stage any offered build. Never
 * restarts — on `{status: 'staged'}` the app calls `restart()` once its
 * in-flight work is done. Connectivity is the app's business: call this with
 * the network already up.
 */
export const check = nativeCheck

/**
 * Periodic update checks for always-on apps: a detached background loop that
 * checks on a jittered cadence, retries sooner after failures, and restarts
 * the device after staging a build. Use `beforeCheck` to bring the network up
 * per round (its returned teardown runs after the round). Do not combine with
 * `check()` — the two modes are alternatives, one per app.
 *
 * Returns the watcher as a Result: an un-enrolled device gets an
 * `err({name: 'NotEnrolled'})` and no loop is started.
 */
export const watch = nativeWatch

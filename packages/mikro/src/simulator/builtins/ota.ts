import type {BuiltinDefinition} from './types.js'

// In-memory stub for native:mikro/ota. The firmware module owns app-build
// staging, the trial/rollback state machine, and boot-time reconcile; on the
// host there is no app partition, so this simulates the contract in memory so
// that applyOffer -> write -> finish -> reconcile -> confirm/revert can be
// exercised in `mikro sim`. State is per-session: a `next-boot` install is
// applied on the next reconcile() call within the same run; `install: 'now'`
// is applied immediately.
export const otaBuiltin: BuiltinDefinition = {
  source: `
let current = {checksum: undefined, trial: false}
let previous = undefined // rollback target
let staging = undefined // {checksum, size, written}
let staged = undefined // {checksum} pending a next-boot install
let report = {reverted: false} // pending reconcile report

function install(checksum) {
  previous = current.checksum === undefined ? undefined : {checksum: current.checksum}
  current = {checksum, trial: true}
}

export function stageBegin(checksum, size) {
  if (staging === undefined || staging.checksum !== checksum) {
    staging = {checksum, size, written: 0}
  }
  return {ok: true, resumeOffset: staging.written}
}

export function stageWrite(bytes) {
  if (staging === undefined) return {ok: false, error: 'no staging session'}
  staging.written += bytes.length
  return {ok: true}
}

export function stageFinish(trialBoots, requireConfirm, installNow) {
  if (staging === undefined) return {ok: false, error: 'no staging session', kind: 'transient'}
  if (staging.size !== undefined && staging.size > 0 && staging.written !== staging.size) {
    const bad = staging
    staging = undefined
    return {ok: false, error: 'size mismatch: ' + bad.written + ' != ' + bad.size, kind: 'corrupt'}
  }
  const checksum = staging.checksum
  staging = undefined
  if (installNow) {
    install(checksum)
    report = {installed: checksum, reverted: false}
  } else {
    staged = {checksum}
  }
  return {ok: true}
}

export function stageAbort() {
  staging = undefined
}

export function markValid() {
  current = {checksum: current.checksum, trial: false}
}

export function revert() {
  if (previous === undefined) return {ok: false, error: 'no rollback target'}
  current = {checksum: previous.checksum, trial: false}
  previous = undefined
  report = {reverted: true}
  return {ok: true}
}

export function running() {
  return {checksum: current.checksum, trial: current.trial}
}

export function reconcile() {
  // Simulate a boot: apply any staged next-boot build, then hand back and
  // clear the pending report.
  if (staged !== undefined) {
    install(staged.checksum)
    report = {installed: staged.checksum, reverted: false}
    staged = undefined
  }
  const out = report
  report = {reverted: false}
  return out
}
`,
}

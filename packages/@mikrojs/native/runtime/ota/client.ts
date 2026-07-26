import {decode, encode} from 'mikro/cbor'
import {request} from 'mikro/http/request'
import {ota} from 'mikro/ota'
import {sleep} from 'mikro/sleep'
import {
  deviceId,
  deviceName,
  firmware,
  restart,
  setDeviceName,
  storageUsage,
  version,
} from 'mikro/sys'

import {type ClientIo, createOtaClient, type LogLevel} from './client-impl.js'

export type {
  CheckError,
  CheckOptions,
  CheckResult,
  DeclineReason,
  Teardown,
  Watcher,
  WatchOptions,
} from './client-impl.js'

/* eslint-disable no-console -- serial diagnostics are the client's only output channel */
const consoleFor: Record<LogLevel, (format: string, ...args: unknown[]) => void> = {
  debug: (format, ...args) => console.debug(format, ...args),
  info: (format, ...args) => console.log(format, ...args),
  warn: (format, ...args) => console.warn(format, ...args),
  error: (format, ...args) => console.error(format, ...args),
}
/* eslint-enable no-console */

/** The real device. Every runtime symbol the client uses is bound here and
 *  nowhere else; `ota` members go through arrows because they are methods on
 *  the builtin singleton. */
const deviceIo: ClientIo = {
  sleep,
  request,
  random: Math.random,
  log: (level, format, ...args) => consoleFor[level](format, ...args),
  encode,
  decode,
  ota,
  identity: () => ({
    deviceId,
    firmware: version,
    firmwareHash: firmware.hash,
    bytecode: firmware.bytecodeVersion,
  }),
  storageFree: () => storageUsage()?.free,
  deviceName,
  setDeviceName,
  restart,
}

const client = createOtaClient(deviceIo)

/**
 * One-shot update check for wake-cycle apps: check in with the registry,
 * confirm the running trial, and download + stage any offered build. Never
 * restarts — on `{status: 'staged'}` the app calls `restart()` once its
 * in-flight work is done. Connectivity is the app's business: call this with
 * the network already up.
 */
export const check = client.check

/**
 * Periodic update checks for always-on apps: a detached background loop that
 * checks on a jittered cadence, retries sooner after failures, and restarts
 * the device after staging a build. Use `beforeCheck` to bring the network up
 * per round (its returned teardown runs after the round). Do not combine with
 * `check()` — the two modes are alternatives, one per app.
 */
export const watch = client.watch

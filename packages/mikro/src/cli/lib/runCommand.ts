/* eslint-disable no-console */
import {describeError, UserError} from './errorMessage.js'

/**
 * Start a one-shot command. Commands that report their own failures exit on
 * their own. A UserError that still rejects here (a port that would not open,
 * a device that dropped off USB) prints one line and exits 1. Anything else is
 * rethrown, so a bug ends as an unhandled rejection with its stack trace.
 */
export function runCommand(result: void | Promise<unknown>): void {
  Promise.resolve(result).catch((err: unknown) => {
    if (!(err instanceof UserError)) throw err
    console.error(`Error: ${describeError(err)}`)
    process.exit(1)
  })
}

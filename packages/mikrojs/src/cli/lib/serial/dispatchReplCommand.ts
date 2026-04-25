import {render} from 'ink'
import {type ComponentType, createElement} from 'react'

import {isAgentMode} from '../agent.js'

/**
 * Dispatch a REPL-class command (`dev`, `console`, `deploy`) between its
 * agent-mode `run` entry point and its interactive Ink `Component`. Keeps
 * the three `case` blocks in `cli.ts` from each re-deriving the same
 * "is this interactive" check and re-specifying the same render options.
 */
export function dispatchReplCommand<T extends {agent?: boolean}>(opts: {
  /** Used only for the TTY-required error message. */
  commandName: 'dev' | 'console' | 'deploy'
  config: T
  /** Extra forcing conditions for the async path (e.g. deploy's `--json`). */
  nonInteractive?: boolean
  /** When true, absence of a TTY is an error unless `--agent` is set.
   *  `dev` and `console` need this (the Ink UI has no sensible fallback).
   *  `deploy` sets it false and silently falls through to `run`. */
  requireTtyForInteractive: boolean
  Component: ComponentType<{args: T}>
  run: (config: T) => void | Promise<unknown>
}): void {
  const isAgent = isAgentMode(opts.config.agent)
  const nonTty = !process.stdin.isTTY

  if (opts.requireTtyForInteractive && nonTty && !isAgent) {
    // eslint-disable-next-line no-console
    console.error(
      `Error: mikro ${opts.commandName} requires an interactive terminal (use --agent for NDJSON mode)`,
    )
    process.exit(1)
  }

  if (isAgent || opts.nonInteractive === true || nonTty) {
    void opts.run(opts.config)
    return
  }

  render(createElement(opts.Component, {args: opts.config}), {
    exitOnCtrlC: false,
    kittyKeyboard: {mode: 'enabled'},
  })
}

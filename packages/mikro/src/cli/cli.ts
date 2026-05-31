#!/usr/bin/env node
/* eslint-disable no-console */
// Side-effect import: must run before any code path that strips .ts types.
import '../suppressStripTypesWarning.js'

import {run} from '@optique/run'
import {render} from 'ink'
import {type ComponentType, createElement} from 'react'
import updateNotifier from 'update-notifier'

import pkg from '../../package.json' with {type: 'json'}
import {isAgentMode} from './lib/agent.js'
import {dispatchReplCommand} from './lib/serial/dispatchReplCommand.js'
import {
  aliasCommand,
  buildCommand,
  buildRuntimeCommand,
  cleanCommand,
  commands,
  consoleCommand,
  deployCommand,
  devCommand,
  docsCommand,
  envCommand,
  homeCommand,
  listCommand,
  logsCommand,
  prog,
  simCommand,
  testCommand,
} from './program.js'

/* Global flag: --native-loglevel=<error|warn|info|debug|verbose>
 *
 * Intercepted here before optique parses anything so it applies to every
 * command without having to declare it on each one. We strip it from argv
 * and set MIK_LOG_LEVEL in the environment, which the simProcess
 * subprocess inherits and the Node addon reads on first log call.
 *
 * For `mikro sim` commands: takes effect immediately, since the subprocess picks it up.
 * For device commands (serial): has no effect on firmware-side logs (the
 * device's log level is controlled at compile time via
 * CONFIG_LOG_DEFAULT_LEVEL and at runtime via the NVS env var
 * MIK_LOG_LEVEL on next boot). */
const rawArgs = process.argv.slice(2)
const filteredArgs: string[] = []
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]!
  if (arg === '--native-loglevel' && i + 1 < rawArgs.length) {
    process.env.MIK_LOG_LEVEL = rawArgs[i + 1]!
    i++ // skip value
    continue
  }
  if (arg.startsWith('--native-loglevel=')) {
    process.env.MIK_LOG_LEVEL = arg.slice('--native-loglevel='.length)
    continue
  }
  filteredArgs.push(arg)
}

const config = await run(prog, {
  help: 'both',
  version: {value: pkg.version, command: true, option: true},
  completion: 'both',
  args: filteredArgs,
})

// Skip the update banner for non-interactive invocations (pipes, AI agents);
// CI / NO_UPDATE_NOTIFIER are handled internally by update-notifier.
if (process.stdout.isTTY && !isAgentMode()) {
  updateNotifier({pkg}).notify()
}

switch (config.command.action) {
  case 'dev': {
    dispatchReplCommand({
      commandName: 'dev',
      config: config.command,
      requireTtyForInteractive: true,
      Component: devCommand.default,
      run: devCommand.run,
    })
    break
  }
  case 'env': {
    if (config.command.sub.subcommand === 'ui') {
      const {default: Component} = envCommand
      render(createElement(Component, {args: config.command}), {
        exitOnCtrlC: false,
      })
    } else {
      void envCommand.run(config.command)
    }
    break
  }
  case 'deploy': {
    dispatchReplCommand({
      commandName: 'deploy',
      config: config.command,
      requireTtyForInteractive: false,
      nonInteractive: config.command.json === true,
      Component: deployCommand.default,
      run: deployCommand.run,
    })
    break
  }
  case 'list': {
    if (config.command.json || isAgentMode(config.command.agent) || !process.stdin.isTTY) {
      void listCommand.run(config.command)
      break
    }
    const {default: ListComponent} = listCommand
    render(createElement(ListComponent, {args: config.command}), {
      exitOnCtrlC: false,
      kittyKeyboard: {mode: 'enabled'},
    })
    break
  }
  case 'build': {
    if (config.command.json || isAgentMode(config.command.agent) || !process.stdin.isTTY) {
      void buildCommand.run(config.command)
      break
    }
    const {default: BuildComponent} = buildCommand
    render(createElement(BuildComponent, {args: config.command}), {
      exitOnCtrlC: false,
      kittyKeyboard: {mode: 'enabled'},
    })
    break
  }
  case 'console': {
    dispatchReplCommand({
      commandName: 'console',
      config: config.command,
      requireTtyForInteractive: true,
      Component: consoleCommand.default,
      run: consoleCommand.run,
    })
    break
  }
  case 'build-runtime': {
    const {default: buildRuntime} = buildRuntimeCommand
    await buildRuntime(config.command)
    break
  }
  case 'clean': {
    void cleanCommand.run(config.command)
    break
  }
  case 'docs': {
    void docsCommand.run()
    break
  }
  case 'home': {
    void homeCommand.run()
    break
  }
  case 'alias': {
    void aliasCommand.run(config.command)
    break
  }
  case 'logs': {
    void logsCommand.run(config.command)
    break
  }
  case 'test': {
    void testCommand.run(config.command)
    break
  }
  case 'sim': {
    const sub = config.command.sub
    // Long-lived sim commands (dev, repl) render via Ink unless --agent.
    // One-shots (deploy, test, env, clean, reset, profile, scaffold) are
    // plain async runs.
    const isInkSub = sub.subcommand === 'dev' || sub.subcommand === 'repl'
    const wantsAgent = isInkSub && 'agent' in sub && isAgentMode(sub.agent)
    if (isInkSub && !wantsAgent) {
      if (!process.stdin.isTTY) {
        console.error(
          `Error: mikro sim ${sub.subcommand} requires an interactive terminal (use --agent for NDJSON mode)`,
        )
        process.exit(1)
      }
      const {default: SimComponent} = simCommand
      render(createElement(SimComponent, {args: config.command}), {
        exitOnCtrlC: false,
        kittyKeyboard: {mode: 'enabled'},
      })
    } else {
      void simCommand.run(config.command)
    }
    break
  }
  default: {
    if (!process.stdin.isTTY) {
      console.error(`Error: ${config.command.action} requires an interactive terminal`)
      process.exit(1)
    }
    const command = commands[config.command.action]
    const {default: Component} = command
    render(
      createElement(Component as ComponentType<{args: any}>, {
        args: config.command,
      }),
      {exitOnCtrlC: false, kittyKeyboard: {mode: 'enabled'}},
    )
  }
}

#!/usr/bin/env node
/* eslint-disable no-console */
// Side-effect import: must run before any code path that strips .ts types.
import '../suppressStripTypesWarning.js'

import {run} from '@optique/run'
import type {RenderOptions} from 'ink'
import type {ComponentType} from 'react'

import pkg from '../../package.json' with {type: 'json'}
import {isAgentMode} from './lib/agent.js'
import {bareOptions} from './lib/bareOptions.js'
import {noticeLegacyAliases} from './lib/legacyAliases.js'
import {runCommand} from './lib/runCommand.js'
import {prog} from './program.js'

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
  args: bareOptions(filteredArgs),
})

// Skip the update banner for non-interactive invocations (pipes, AI agents);
// CI / NO_UPDATE_NOTIFIER are handled internally by update-notifier.
if (process.stdout.isTTY && !isAgentMode()) {
  const {default: updateNotifier} = await import('update-notifier')
  updateNotifier({pkg}).notify()
}

// One-shot upgrade notice, and it disarms itself by renaming the file. Skipped
// in agent mode so a machine-readable run does not spend it before a human
// sees it.
if (!isAgentMode()) noticeLegacyAliases()

// Command handlers are imported inside their case so a run loads only the
// command it dispatches.
async function renderInk<T>(
  Component: ComponentType<{args: T}>,
  args: T,
  options: RenderOptions = {exitOnCtrlC: false, kittyKeyboard: {mode: 'enabled'}},
): Promise<void> {
  const [{render}, {createElement}] = await Promise.all([import('ink'), import('react')])
  render(createElement(Component, {args}), options)
}

switch (config.command.action) {
  case 'dev': {
    const {dispatchReplCommand} = await import('./lib/serial/dispatchReplCommand.js')
    const devCommand = await import('./commands/dev.js')
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
    const envCommand = await import('./commands/env.js')
    if (config.command.sub.subcommand === 'ui') {
      await renderInk(envCommand.default, config.command, {exitOnCtrlC: false})
    } else {
      runCommand(envCommand.run(config.command))
    }
    break
  }
  case 'deploy': {
    const {dispatchReplCommand} = await import('./lib/serial/dispatchReplCommand.js')
    const deployCommand = await import('./commands/deploy.js')
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
    const listCommand = await import('./commands/ls.js')
    if (config.command.json || isAgentMode(config.command.agent) || !process.stdin.isTTY) {
      runCommand(listCommand.run(config.command))
      break
    }
    await renderInk(listCommand.default, config.command)
    break
  }
  case 'build': {
    const buildCommand = await import('./commands/build.js')
    if (config.command.json || isAgentMode(config.command.agent) || !process.stdin.isTTY) {
      runCommand(buildCommand.run(config.command))
      break
    }
    await renderInk(buildCommand.default, config.command)
    break
  }
  case 'console': {
    const {dispatchReplCommand} = await import('./lib/serial/dispatchReplCommand.js')
    const consoleCommand = await import('./commands/console.js')
    dispatchReplCommand({
      commandName: 'console',
      config: config.command,
      requireTtyForInteractive: true,
      Component: consoleCommand.default,
      run: consoleCommand.run,
    })
    break
  }
  case 'clean': {
    const cleanCommand = await import('./commands/clean.js')
    runCommand(cleanCommand.run(config.command))
    break
  }
  case 'docs': {
    const docsCommand = await import('./commands/docs.js')
    runCommand(docsCommand.run())
    break
  }
  case 'home': {
    const homeCommand = await import('./commands/home.js')
    runCommand(homeCommand.run())
    break
  }
  case 'name': {
    const nameCommand = await import('./commands/name.js')
    runCommand(nameCommand.run(config.command))
    break
  }
  case 'logs': {
    const logsCommand = await import('./commands/logs.js')
    runCommand(logsCommand.run(config.command))
    break
  }
  case 'test': {
    const testCommand = await import('./commands/test.js')
    runCommand(testCommand.run(config.command))
    break
  }
  case 'ota': {
    const otaCommand = await import('./commands/ota.js')
    runCommand(otaCommand.run(config.command))
    break
  }
  case 'profile': {
    const profileCommand = await import('./commands/profile.js')
    runCommand(profileCommand.run(config.command))
    break
  }
  case 'idf': {
    const idfCommand = await import('./commands/idf.js')
    runCommand(idfCommand.run(config.command))
    break
  }
  case 'fw': {
    const fwCommand = await import('./commands/fw.js')
    runCommand(fwCommand.run(config.command))
    break
  }
  case 'sim': {
    const sub = config.command.sub
    // Long-lived sim commands (dev, repl) render via Ink unless --agent.
    // One-shots (deploy, test, env, clean, reset, profile, scaffold) are
    // plain async runs.
    const isInkSub = sub.subcommand === 'dev' || sub.subcommand === 'repl'
    const wantsAgent = isInkSub && 'agent' in sub && isAgentMode(sub.agent)
    const wantsInk = isInkSub && !wantsAgent
    if (wantsInk && !process.stdin.isTTY) {
      console.error(
        `Error: mikro sim ${sub.subcommand} requires an interactive terminal (use --agent for NDJSON mode)`,
      )
      process.exit(1)
    }
    const simCommand = await import('./commands/sim.js')
    if (wantsInk) {
      await renderInk(simCommand.default, config.command)
    } else {
      runCommand(simCommand.run(config.command))
    }
    break
  }
  case 'flash': {
    if (!process.stdin.isTTY) {
      console.error(`Error: ${config.command.action} requires an interactive terminal`)
      process.exit(1)
    }
    const flashCommand = await import('./commands/flash.js')
    await renderInk(flashCommand.default, config.command)
    break
  }
  case 'erase': {
    if (!process.stdin.isTTY) {
      console.error(`Error: ${config.command.action} requires an interactive terminal`)
      process.exit(1)
    }
    const eraseCommand = await import('./commands/erase.js')
    await renderInk(eraseCommand.default, config.command)
    break
  }
  default:
    // A command in program.ts without a case here fails the type check
    config.command satisfies never
}

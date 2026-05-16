#!/usr/bin/env node --watch
import {fork} from 'node:child_process'
import * as path from 'node:path'

const cliExt = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const cliPath = path.join(import.meta.dirname, `cli${cliExt}`)

function run() {
  const child = fork(cliPath, process.argv.slice(2))
  // Track whether we're tearing down to start a fresh child (reload) so we
  // can suppress the wrapper's own exit on the dying child.
  let restarting = false

  const onMessage = (message: string) => {
    if (message === 'exit') {
      exit('SIGTERM', false)
    }
    if (message === 'reload') {
      exit('SIGINT', true)
    }
  }
  function exit(signal: 'SIGINT' | 'SIGTERM', restart: boolean) {
    restarting = restart
    child.kill('SIGTERM')
    child.removeAllListeners('message')
    // eslint-disable-next-line no-console
    console.log(`${restart ? 'Restart' : 'Exit'} at %s\n`, new Date().toLocaleString())
    if (restart) {
      run()
    }
  }
  // Forward the child's exit code to the wrapper. Without this, a child that
  // calls process.exit(1) (e.g. on a fatal CLI error like a missing env file)
  // would leave the wrapper exiting 0, masking the failure from shell scripts
  // and CI. Suppressed during reload so the new child's lifetime drives exit.
  child.on('exit', (code, signal) => {
    if (restarting) return
    process.exit(code ?? (signal ? 1 : 0))
  })
  child.on('message', onMessage)
}

run()

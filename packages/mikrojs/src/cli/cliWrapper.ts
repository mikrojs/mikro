#!/usr/bin/env node --watch
import {fork} from 'node:child_process'
import * as path from 'node:path'

const cliPath = path.join(import.meta.dirname, '/cli.js')

function run() {
  const child = fork(cliPath, process.argv.slice(2))

  const onMessage = (message: string) => {
    if (message === 'exit') {
      exit('SIGTERM', false)
    }
    if (message === 'reload') {
      exit('SIGINT', true)
    }
  }
  function exit(signal: 'SIGINT' | 'SIGTERM', restart: boolean) {
    child.kill('SIGTERM')
    child.removeAllListeners('message')
    // eslint-disable-next-line no-console
    console.log(`${restart ? 'Restart' : 'Exit'} at %s\n`, new Date().toLocaleString())
    if (restart) {
      run()
    }
  }
  child.on('message', onMessage)
}

run()

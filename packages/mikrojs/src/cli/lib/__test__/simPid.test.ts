import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {checkPid, claimPid, clearPid, isAlive, readPid, SimAlreadyRunningError} from '../simPid.js'

describe('simPid', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(pathlib.join(tmpdir(), 'simPid-'))
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  it('readPid returns null when no pid file exists', () => {
    expect(readPid(dir)).to.equal(null)
  })

  it('readPid returns the pid when the file holds a live pid', () => {
    writeFileSync(pathlib.join(dir, 'sim.pid'), String(process.pid))
    expect(readPid(dir)).to.equal(process.pid)
  })

  it('readPid auto-cleans a stale pid file pointing at a dead process', () => {
    // pid 1 is init/launchd — checking liveness on a pid we definitely don't
    // own would return true (EPERM); we need a pid that's actually dead. Use
    // a high number that's vanishingly unlikely to be live.
    const deadPid = 2 ** 22 - 1
    const pidFile = pathlib.join(dir, 'sim.pid')
    writeFileSync(pidFile, String(deadPid))
    expect(readPid(dir)).to.equal(null)
    expect(existsSync(pidFile)).to.equal(false)
  })

  it('readPid returns null for malformed contents', () => {
    writeFileSync(pathlib.join(dir, 'sim.pid'), 'not-a-number')
    expect(readPid(dir)).to.equal(null)
  })

  it('isAlive is true for the current process', () => {
    expect(isAlive(process.pid)).to.equal(true)
  })

  it('isAlive is false for a definitely-dead pid', () => {
    expect(isAlive(2 ** 22 - 1)).to.equal(false)
  })

  it('checkPid throws SimAlreadyRunningError when a live pid is recorded', () => {
    writeFileSync(pathlib.join(dir, 'sim.pid'), String(process.pid))
    expect(() => checkPid(dir)).to.throw(SimAlreadyRunningError)
  })

  it('checkPid does nothing when no pid file exists', () => {
    expect(() => checkPid(dir)).not.to.throw()
  })

  it('claimPid writes the current pid when nothing else holds it', async () => {
    await claimPid(dir)
    const written = readFileSync(pathlib.join(dir, 'sim.pid'), 'utf-8').trim()
    expect(written).to.equal(String(process.pid))
    clearPid(dir)
  })

  it('claimPid replaces a stale pid file', async () => {
    writeFileSync(pathlib.join(dir, 'sim.pid'), String(2 ** 22 - 1))
    await claimPid(dir)
    expect(readPid(dir)).to.equal(process.pid)
    clearPid(dir)
  })

  it('clearPid removes the pid file', () => {
    writeFileSync(pathlib.join(dir, 'sim.pid'), String(process.pid))
    clearPid(dir)
    expect(existsSync(pathlib.join(dir, 'sim.pid'))).to.equal(false)
  })
})

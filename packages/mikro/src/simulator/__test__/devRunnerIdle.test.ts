import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createDevRunner, type DevRunner} from '../devRunner.js'

/* The tick loop must sleep (setTimeout, at most the idle cap) rather than
 * spin on setImmediate whenever the runtime has no work, including after an
 * uncaught error has stopped it. With fake timers, a setImmediate reschedule
 * would run again inside advanceTimersByTime and inflate the call count. */
describe('devRunner idle scheduling', () => {
  let fsRoot: string
  let runner: DevRunner | undefined
  let stop: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    fsRoot = mkdtempSync(join(tmpdir(), 'mikro-dev-runner-'))
  })

  afterEach(() => {
    stop?.()
    runner?.runtime.dispose()
    vi.useRealTimers()
    rmSync(fsRoot, {recursive: true, force: true})
  })

  function boot(source: string): DevRunner {
    const script = join(fsRoot, 'main.js')
    writeFileSync(script, source)
    runner = createDevRunner({script, fsRoot})
    runner.messages$.subscribe(() => {})
    stop = runner.start()
    return runner
  }

  it('sleeps for the idle cap when nothing is scheduled', () => {
    const r = boot('export {}\n')
    const loopOnce = vi.spyOn(r.runtime, 'loopOnce')
    vi.runOnlyPendingTimers()
    expect(loopOnce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(9)
    expect(loopOnce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(loopOnce).toHaveBeenCalledTimes(2)
  })

  it('sleeps for the idle cap after an uncaught error stopped the runtime', () => {
    const r = boot('setTimeout(() => { throw new Error("boom") }, 0)\n')
    const loopOnce = vi.spyOn(r.runtime, 'loopOnce')
    vi.runOnlyPendingTimers()
    expect(loopOnce).toHaveReturnedWith(1)
    expect(loopOnce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(9)
    expect(loopOnce).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(loopOnce).toHaveBeenCalledTimes(2)
  })
})

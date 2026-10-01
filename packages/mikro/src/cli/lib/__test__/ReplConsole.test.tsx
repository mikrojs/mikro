import {stripVTControlCharacters} from 'node:util'

import {cleanup, render} from 'ink-testing-library'
import {BehaviorSubject, EMPTY} from 'rxjs'
import {afterEach, describe, expect, it} from 'vitest'

import {ReplConsole} from '../serial/ReplConsole.js'
import {
  createInitialState,
  EMPTY_HINT,
  INPUT_HINT,
  type KeyInfo,
  reduce,
  type ReplAction,
  type ReplHandle,
  type ReplMachineState,
} from '../serial/replStateMachine.js'

/** A handle over the real reducer, driven synchronously from the test */
function fakeRepl() {
  let state = createInitialState()
  const state$ = new BehaviorSubject<ReplMachineState>(state)
  const dispatch = (action: ReplAction) => {
    state = reduce(state, action)[0]
    state$.next(state)
  }
  const repl = {
    state$,
    deploys$: EMPTY,
    keyInput() {},
    closeOverlay() {},
    printed(upTo: number) {
      dispatch({type: 'printed', upTo})
    },
  } as unknown as ReplHandle
  return {repl, dispatch, current: () => state}
}

const NO_KEY: KeyInfo = {
  ctrl: false,
  meta: false,
  shift: false,
  return: false,
  tab: false,
  backspace: false,
  delete: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  home: false,
  end: false,
}

/** Past the console's 16 ms audit and Ink's render */
const settle = () => new Promise((r) => setTimeout(r, 60))

function logLine(i: number): ReplAction {
  return {type: 'deviceEvent', event: {type: 'log', text: `line ${i}`}}
}

/** ink-testing-library renders in Ink's debug mode, where every frame is
 *  all static output printed so far plus the live area, so the last frame
 *  shows each printed line as often as it was printed. */
function printedLines(frame: string | undefined): string[] {
  return (frame ?? '')
    .split('\n')
    .map((l) => stripVTControlCharacters(l).trim())
    .filter((l) => /^line \d+$/.test(l))
}

const expectedLines = (count: number) => Array.from({length: count}, (_, i) => `line ${i}`)

describe('ReplConsole scrollback', () => {
  afterEach(cleanup)

  it('prints a burst once, then drops the printed events', async () => {
    const {repl, dispatch, current} = fakeRepl()
    const {lastFrame, unmount} = render(<ReplConsole repl={repl} />)
    const count = 2500
    for (let i = 0; i < count; i++) dispatch(logLine(i))
    // Only printed events may be dropped (the connecting line printed on mount)
    expect(current().eventsDropped).toBeLessThanOrEqual(current().printedUpTo)
    expect(current().events).toHaveLength(count + 1 - current().eventsDropped)

    await settle()
    expect(printedLines(lastFrame())).toEqual(expectedLines(count))
    // Once printed, no event is kept
    expect(current().events).toEqual([])
    expect(current().eventsDropped).toBe(count + 1)

    // A later line prints once and nothing prints again
    dispatch(logLine(count))
    await settle()
    expect(printedLines(lastFrame())).toEqual(expectedLines(count + 1))
    unmount()
  })
})

describe('ReplConsole clear', () => {
  afterEach(cleanup)

  it('wipes what was printed, and keeps it gone', async () => {
    const {repl, dispatch} = fakeRepl()
    const {lastFrame, unmount} = render(<ReplConsole repl={repl} />)
    dispatch({type: 'deviceEvent', event: {type: 'ready', chip: 'ESP32', id: null, version: null}})
    for (let i = 0; i < 3; i++) dispatch(logLine(i))
    await settle()
    expect(printedLines(lastFrame())).toEqual(expectedLines(3))

    dispatch({type: 'key', ch: 'l', key: {...NO_KEY, ctrl: true}})
    await settle()
    // Ink replays all it printed in every frame here, as it does on a full
    // redraw in a terminal: nothing of the old log may come back
    expect(printedLines(lastFrame())).toEqual([])

    dispatch(logLine(3))
    await settle()
    expect(printedLines(lastFrame())).toEqual(['line 3'])
    unmount()
  })
})

describe('ReplConsole hint', () => {
  afterEach(cleanup)

  it('follows the input', async () => {
    const {repl, dispatch} = fakeRepl()
    const {lastFrame, unmount} = render(<ReplConsole repl={repl} />)
    const key = (ch: string, ctrl = false) => dispatch({type: 'key', ch, key: {...NO_KEY, ctrl}})
    const hint = () => stripVTControlCharacters(lastFrame() ?? '')

    dispatch({type: 'deviceEvent', event: {type: 'ready', chip: 'ESP32', id: null, version: null}})
    await settle()
    expect(hint()).toContain(EMPTY_HINT)

    key('a')
    await settle()
    expect(hint()).toContain(INPUT_HINT)
    expect(hint()).not.toContain(EMPTY_HINT)

    // Ctrl+C clears the input, and the empty hint is back
    key('c', true)
    await settle()
    expect(hint()).toContain(EMPTY_HINT)
    unmount()
  })
})

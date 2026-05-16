import {describe, expect, test} from 'vitest'

import {
  createInitialState,
  type KeyInfo,
  reduce,
  type ReplAction,
  type ReplMachineState,
} from '../serial/replStateMachine.js'

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

function key(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {...NO_KEY, ...overrides}
}

function keyAction(ch: string, overrides: Partial<KeyInfo> = {}): ReplAction {
  return {type: 'key', ch, key: key(overrides)}
}

function deviceEvent(event: Extract<ReplAction, {type: 'deviceEvent'}>['event']): ReplAction {
  return {type: 'deviceEvent', event}
}

function typeChars(state: ReplMachineState, text: string): ReplMachineState {
  for (const ch of text) {
    const [next] = reduce(state, keyAction(ch))
    state = next
  }
  return state
}

describe('replStateMachine', () => {
  describe('createInitialState', () => {
    test('creates initial state with connecting event', () => {
      const state = createInitialState('/dev/ttyUSB0')
      expect(state.connection).toEqual({type: 'connecting'})
      expect(state.input).toBe('')
      expect(state.cursor).toBe(0)
      expect(state.events).toHaveLength(1)
      expect(state.events[0]).toEqual({type: 'connecting', port: '/dev/ttyUSB0'})
    })

    test('creates initial state without port', () => {
      const state = createInitialState()
      expect(state.events[0]).toEqual({type: 'connecting', port: undefined})
    })
  })

  describe('character input', () => {
    test('inserts character at cursor', () => {
      const state = createInitialState()
      // Need to be in ready state for input to work
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(ready, keyAction('a'))
      expect(next.input).toBe('a')
      expect(next.cursor).toBe(1)
    })

    test('inserts at cursor position', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      // Move cursor left
      const [moved] = reduce(s, keyAction('', {leftArrow: true}))
      const [next] = reduce(moved, keyAction('x'))
      expect(next.input).toBe('abxc')
      expect(next.cursor).toBe(3)
    })

    test('clears showWelcome on first input', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      expect(ready.showWelcome).toBe(true)
      const [next] = reduce(ready, keyAction('a'))
      expect(next.showWelcome).toBe(false)
    })
  })

  describe('cursor movement', () => {
    test('left arrow moves cursor left', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [next] = reduce(s, keyAction('', {leftArrow: true}))
      expect(next.cursor).toBe(2)
    })

    test('right arrow moves cursor right', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [moved] = reduce(s, keyAction('', {leftArrow: true}))
      const [next] = reduce(moved, keyAction('', {rightArrow: true}))
      expect(next.cursor).toBe(3)
    })

    test('left arrow does not go below 0', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(ready, keyAction('', {leftArrow: true}))
      expect(next.cursor).toBe(0)
    })

    test('right arrow does not go past input length', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'ab')
      const [next] = reduce(s, keyAction('', {rightArrow: true}))
      expect(next.cursor).toBe(2)
    })

    test('home moves to start of line', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [next] = reduce(s, keyAction('', {home: true}))
      expect(next.cursor).toBe(0)
    })

    test('end moves to end of line', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [moved] = reduce(s, keyAction('', {home: true}))
      const [next] = reduce(moved, keyAction('', {end: true}))
      expect(next.cursor).toBe(3)
    })
  })

  describe('backspace and delete', () => {
    test('backspace deletes character before cursor', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [next] = reduce(s, keyAction('', {backspace: true}))
      expect(next.input).toBe('ab')
      expect(next.cursor).toBe(2)
    })

    test('backspace at position 0 does nothing', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(ready, keyAction('', {backspace: true}))
      expect(next.input).toBe('')
      expect(next.cursor).toBe(0)
    })

    test('delete key deletes forward', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      // Move cursor to position 1 (after 'a')
      const [atPos1] = reduce({...s, cursor: 1}, keyAction('', {delete: true}))
      expect(atPos1.input).toBe('ac')
      expect(atPos1.cursor).toBe(1)
    })

    test('delete at end of input does nothing', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'abc')
      const [next] = reduce(s, keyAction('', {delete: true}))
      expect(next.input).toBe('abc')
      expect(next.cursor).toBe(3)
    })

    test('ctrl+s emits deploy effect without touching input', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello')
      const [next, effects] = reduce(s, keyAction('s', {ctrl: true}))
      expect(next.input).toBe('hello')
      expect(effects).toEqual([{type: 'deploy', force: false}])
    })

    test('ctrl+shift+s emits force-deploy effect', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [, effects] = reduce(ready, keyAction('s', {ctrl: true, shift: true}))
      expect(effects).toEqual([{type: 'deploy', force: true}])
    })
  })

  describe('submit', () => {
    test('ctrl+enter submits and emits eval effect', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '1+1')
      const [next, effects] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(next.input).toBe('')
      expect(next.evaluating).toBe(true)
      expect(next.pendingInput).toBe('1+1')
      expect(effects).toContainEqual({type: 'eval', code: '1+1'})
      expect(effects).toContainEqual({type: 'appendHistory', entry: '1+1'})
    })

    test('submit is blocked when disabled', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '1+1')
      const [disabled] = reduce(s, {type: 'setDisabled', disabled: true})
      const [next, effects] = reduce(disabled, keyAction('', {return: true, ctrl: true}))
      expect(next.input).toBe('1+1')
      expect(effects).toEqual([])
    })

    test('empty input is not submitted', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next, effects] = reduce(ready, keyAction('', {return: true, ctrl: true}))
      expect(next.input).toBe('')
      expect(effects).toEqual([])
    })

    test('/exit emits exit and end effects', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/exit')
      const [, effects] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(effects).toContainEqual({type: 'exit'})
      expect(effects).toContainEqual({type: 'end'})
    })

    test('command emits directive effect', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/help')
      const [next, effects] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(effects).toContainEqual({type: 'directive', code: '/help'})
      // Command input is logged immediately
      expect(next.events.at(-1)).toEqual({type: 'input', code: '/help'})
    })

    test('/pause sets paused flag', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/pause')
      const [next] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(next.paused).toBe(true)
    })

    test('/env sets overlay', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/env')
      const [next, effects] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(next.overlay).toBe('env')
      expect(next.input).toBe('')
      // No directive effect - /env is handled client-side
      expect(effects.find((e) => e.type === 'directive')).toBeUndefined()
    })

    test('key input is ignored when overlay is active', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/env')
      const [overlayState] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(overlayState.overlay).toBe('env')
      const [next] = reduce(overlayState, keyAction('a'))
      expect(next.input).toBe('')
    })

    test('closeOverlay clears overlay', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '/env')
      const [overlayState] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(overlayState.overlay).toBe('env')
      const [next] = reduce(overlayState, {type: 'closeOverlay'})
      expect(next.overlay).toBeNull()
    })
  })

  describe('session events', () => {
    test('ready event transitions connection state', () => {
      const state = createInitialState('/dev/ttyUSB0')
      const [next] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32C6', id: 'abc', version: '0.1.0'}),
      )
      expect(next.connection).toEqual({
        type: 'ready',
        chip: 'ESP32C6',
        deviceId: 'abc',
        firmwareVersion: '0.1.0',
      })
      // ready event is logged
      expect(next.events.at(-1)).toEqual({
        type: 'ready',
        chip: 'ESP32C6',
        id: 'abc',
        version: '0.1.0',
      })
    })

    test('duplicate ready event is ignored', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const eventCount = ready.events.length
      const [next] = reduce(
        ready,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      expect(next.events.length).toBe(eventCount)
    })

    test('log events are accumulated', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(ready, deviceEvent({type: 'log', text: 'hello'}))
      expect(next.events.at(-1)).toEqual({type: 'log', text: 'hello'})
    })

    test('result event clears evaluating and flushes pending input', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '1+1')
      const [submitted] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(submitted.evaluating).toBe(true)
      expect(submitted.pendingInput).toBe('1+1')

      const [afterResult] = reduce(submitted, deviceEvent({type: 'result', text: '2'}))
      expect(afterResult.evaluating).toBe(false)
      // pendingInput is flushed by prompt (which carries timing), not result
      expect(afterResult.pendingInput).toBe('1+1')

      const [next] = reduce(afterResult, deviceEvent({type: 'prompt', timing: ''}))
      expect(next.pendingInput).toBeNull()
      const inputEvent = next.events.find((e) => e.type === 'input')
      expect(inputEvent).toBeDefined()
    })

    test('eval_error clears evaluating', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'bad()')
      const [submitted] = reduce(s, keyAction('', {return: true, ctrl: true}))
      const [next] = reduce(submitted, deviceEvent({type: 'eval_error', text: 'ReferenceError'}))
      expect(next.evaluating).toBe(false)
    })

    test('completions with single item replaces input', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'cons')
      const [next] = reduce(
        s,
        deviceEvent({type: 'completions', result: {items: ['console'], prefix: 'cons'}}),
      )
      expect(next.input).toBe('console')
      expect(next.cursor).toBe(7)
    })

    test('disconnect emits end effect', () => {
      const state = createInitialState()
      const [, effects] = reduce(state, deviceEvent({type: 'disconnect'}))
      expect(effects).toContainEqual({type: 'end'})
    })
  })

  describe('ctrl+c', () => {
    test('clears input when non-empty', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello')
      const [next] = reduce(s, keyAction('c', {ctrl: true}))
      expect(next.input).toBe('')
      expect(next.cursor).toBe(0)
    })

    test('first ctrl+c on empty input sets pending and schedules timeout', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next, effects] = reduce(ready, keyAction('c', {ctrl: true}))
      expect(next.ctrlCPending).toBe(true)
      expect(next.overrideHint).toContain('Ctrl+C')
      expect(effects).toContainEqual({type: 'scheduleCtrlCTimeout'})
    })

    test('second ctrl+c exits', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [pending] = reduce(ready, keyAction('c', {ctrl: true}))
      const [, effects] = reduce(pending, keyAction('c', {ctrl: true}))
      expect(effects).toContainEqual({type: 'exit'})
      expect(effects).toContainEqual({type: 'end'})
    })

    test('ctrlCTimeout clears pending', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [pending] = reduce(ready, keyAction('c', {ctrl: true}))
      expect(pending.ctrlCPending).toBe(true)
      const [next] = reduce(pending, {type: 'ctrlCTimeout'})
      expect(next.ctrlCPending).toBe(false)
      expect(next.overrideHint).toBeNull()
    })
  })

  describe('restart', () => {
    test('ctrl+r emits restart effect and resets connection', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next, effects] = reduce(ready, keyAction('r', {ctrl: true}))
      expect(next.connection).toEqual({type: 'connecting', message: 'Restarting…'})
      expect(effects).toContainEqual({type: 'restart'})
      expect(next.events.at(-1)).toEqual({type: 'restarting'})
    })
  })

  describe('paste detection', () => {
    test('enter schedules returnResolve', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello')
      const [next, effects] = reduce(s, keyAction('', {return: true}))
      expect(next.returnPending).toBe(true)
      expect(effects).toContainEqual(expect.objectContaining({type: 'scheduleReturnResolve'}))
    })

    test('returnResolve on single-line submits', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '1+1')
      const [pending] = reduce(s, keyAction('', {return: true}))
      const [next, effects] = reduce(pending, {type: 'returnResolve'})
      expect(next.returnPending).toBe(false)
      expect(next.input).toBe('')
      expect(effects).toContainEqual({type: 'eval', code: '1+1'})
    })

    test('character input during returnPending inserts newline', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'a')
      const [pending] = reduce(s, keyAction('', {return: true}))
      expect(pending.returnPending).toBe(true)
      const [next] = reduce(pending, keyAction('b'))
      expect(next.returnPending).toBe(false)
      // Newline was inserted before 'b'
      expect(next.input).toBe('a\nb')
    })
  })

  describe('history', () => {
    test('up arrow navigates history', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      // Submit some entries to build history
      let s = typeChars(ready, 'first')
      ;[s] = reduce(s, keyAction('', {return: true, ctrl: true}))
      s = typeChars(s, 'second')
      ;[s] = reduce(s, keyAction('', {return: true, ctrl: true}))

      // Now press up arrow (cursor must be at 0)
      const [next] = reduce(s, keyAction('', {upArrow: true}))
      expect(next.input).toBe('second')
      expect(next.historyIdx).toBe(next.history.length - 1)
    })

    test('down arrow after history returns to draft', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'first')
      ;[s] = reduce(s, keyAction('', {return: true, ctrl: true}))

      // Type partial, then navigate up, then down
      s = typeChars(s, 'draft')
      // Move to start for history navigation
      ;[s] = reduce(s, keyAction('', {home: true}))
      const [up] = reduce(s, keyAction('', {upArrow: true}))
      expect(up.input).toBe('first')

      // Move to end for down navigation
      const [atEnd] = reduce(up, keyAction('', {end: true}))
      const [down] = reduce(atEnd, keyAction('', {downArrow: true}))
      expect(down.input).toBe('draft')
      expect(down.historyIdx).toBe(-1)
    })
  })

  describe('before ready', () => {
    test('regular input is ignored', () => {
      const state = createInitialState()
      const [next] = reduce(state, keyAction('a'))
      expect(next.input).toBe('')
    })

    test('ctrl+d exits', () => {
      const state = createInitialState()
      const [, effects] = reduce(state, keyAction('d', {ctrl: true}))
      expect(effects).toContainEqual({type: 'end'})
    })

    test('ctrl+q exits', () => {
      const state = createInitialState()
      const [, effects] = reduce(state, keyAction('q', {ctrl: true}))
      expect(effects).toContainEqual({type: 'end'})
    })
  })

  describe('setDisabled', () => {
    test('sets disabled flag', () => {
      const state = createInitialState()
      const [next] = reduce(state, {type: 'setDisabled', disabled: true})
      expect(next.disabled).toBe(true)
    })

    test('blocks input when disabled', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [disabled] = reduce(ready, {type: 'setDisabled', disabled: true})
      const [next] = reduce(disabled, keyAction('a'))
      expect(next.input).toBe('')
    })
  })

  describe('setError', () => {
    test('sets error connection state and logs error event', () => {
      const state = createInitialState()
      const [next] = reduce(state, {type: 'setError', message: 'build failed'})
      expect(next.connection).toEqual({type: 'error', message: 'build failed'})
      expect(next.events.at(-1)).toEqual({type: 'error', text: 'build failed'})
    })

    test('suppressLogEntry skips the scrollback log entry', () => {
      const state = createInitialState()
      const eventCountBefore = state.events.length
      const [next] = reduce(state, {
        type: 'setError',
        message: 'Device did not respond within 10s.',
        suppressLogEntry: true,
      })
      expect(next.connection).toEqual({
        type: 'error',
        message: 'Device did not respond within 10s.',
      })
      expect(next.events.length).toBe(eventCountBefore)
    })
  })

  describe('word navigation', () => {
    test('alt+left moves to previous word boundary', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello world')
      const [next] = reduce(s, keyAction('', {leftArrow: true, meta: true}))
      expect(next.cursor).toBe(6)
    })

    test('alt+right moves to next word boundary', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello world')
      // Move to start
      const [atStart] = reduce(s, keyAction('', {home: true}))
      const [next] = reduce(atStart, keyAction('', {rightArrow: true, meta: true}))
      expect(next.cursor).toBe(5)
    })

    test('alt+backspace deletes previous word', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'hello world')
      const [next] = reduce(s, keyAction('', {backspace: true, meta: true}))
      expect(next.input).toBe('hello ')
      expect(next.cursor).toBe(6)
    })
  })

  describe('multi-line editing', () => {
    test('shift+enter inserts newline', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'line1')
      const [next] = reduce(s, keyAction('', {return: true, shift: true}))
      expect(next.input).toBe('line1\n')
      expect(next.cursor).toBe(6)
    })

    test('up arrow moves cursor up across lines', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      // Create multi-line input: "ab\ncd" with cursor at end (pos 5)
      let s = typeChars(ready, 'ab')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'cd')
      expect(s.input).toBe('ab\ncd')
      expect(s.cursor).toBe(5)

      const [next] = reduce(s, keyAction('', {upArrow: true}))
      // Should move to line 0, col 2 (clamped to line length)
      expect(next.cursor).toBe(2)
    })

    test('down arrow moves cursor down across lines', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'ab')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'cd')
      // Move to start of first line
      ;[s] = reduce(s, keyAction('', {home: true}))
      ;[s] = reduce(s, keyAction('', {upArrow: true}))
      expect(s.cursor).toBe(0)

      const [next] = reduce(s, keyAction('', {downArrow: true}))
      // Should move to line 1, col 0
      expect(next.cursor).toBe(3)
    })

    test('down arrow on last line moves to end', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'ab')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'cd')
      // Move to start of second line
      ;[s] = reduce(s, keyAction('', {home: true}))
      expect(s.cursor).toBe(3)

      const [next] = reduce(s, keyAction('', {downArrow: true}))
      expect(next.cursor).toBe(5)
    })

    test('returnResolve on multi-line inserts newline', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'line1')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'line2')
      // Press enter (deferred)
      const [pending] = reduce(s, keyAction('', {return: true}))
      // Return resolves: multi-line, so insert newline instead of submitting
      const [next, effects] = reduce(pending, {type: 'returnResolve'})
      // Newline inserted at cursor position
      expect(next.input).toBe('line1\nline2\n')
      expect(effects.find((e) => e.type === 'eval')).toBeUndefined()
    })

    test('ctrl+a moves to start of current line in multi-line', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'ab')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'cd')
      // Cursor at end of "cd" (pos 5)
      const [next] = reduce(s, keyAction('a', {ctrl: true}))
      expect(next.cursor).toBe(3) // start of second line
    })

    test('ctrl+e moves to end of current line in multi-line', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      let s = typeChars(ready, 'ab')
      ;[s] = reduce(s, keyAction('', {return: true, shift: true}))
      s = typeChars(s, 'cd')
      // Move to start of first line
      ;[s] = reduce(s, keyAction('', {home: true}))
      ;[s] = reduce(s, keyAction('', {upArrow: true}))
      expect(s.cursor).toBe(0)

      const [next] = reduce(s, keyAction('e', {ctrl: true}))
      expect(next.cursor).toBe(2) // end of "ab"
    })
  })

  describe('tab', () => {
    test('inserts two spaces', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'x')
      const [next] = reduce(s, keyAction('', {tab: true}))
      expect(next.input).toBe('x  ')
      expect(next.cursor).toBe(3)
      expect(next.showWelcome).toBe(false)
    })
  })

  describe('more session events', () => {
    test('raw event is logged', () => {
      const state = createInitialState()
      const [next] = reduce(state, deviceEvent({type: 'raw', text: 'boot message'}))
      expect(next.events.at(-1)).toEqual({type: 'raw', text: 'boot message'})
    })

    test('prompt event sets pendingTiming', () => {
      const state = createInitialState()
      const [next] = reduce(state, deviceEvent({type: 'prompt', timing: '3ms'}))
      expect(next.pendingTiming).toBe('3ms')
    })

    test('timing is attached to flushed input', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, '1+1')
      const [submitted] = reduce(s, keyAction('', {return: true, ctrl: true}))
      // Device sends timing, then result
      const [withTiming] = reduce(submitted, deviceEvent({type: 'prompt', timing: '5ms'}))
      const [next] = reduce(withTiming, deviceEvent({type: 'result', text: '2'}))
      const inputEvent = next.events.find((e) => e.type === 'input')
      expect(inputEvent).toEqual({type: 'input', code: '1+1', timing: '5ms'})
    })

    test('empty result does not add result event', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const s = typeChars(ready, 'undefined')
      const [submitted] = reduce(s, keyAction('', {return: true, ctrl: true}))
      const [afterResult] = reduce(submitted, deviceEvent({type: 'result', text: ''}))
      // No result event added
      const resultEvents = afterResult.events.filter((e) => e.type === 'result')
      expect(resultEvents).toHaveLength(0)

      // Input flushed by prompt
      const [next] = reduce(afterResult, deviceEvent({type: 'prompt', timing: ''}))
      expect(next.pendingInput).toBeNull()
    })

    test('empty completions are ignored', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(
        ready,
        deviceEvent({type: 'completions', result: {items: [], prefix: ''}}),
      )
      expect(next).toBe(ready) // same reference, no change
    })

    test('multiple completions are logged', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      const [next] = reduce(
        ready,
        deviceEvent({
          type: 'completions',
          result: {items: ['console.log', 'console.warn', 'console.error'], prefix: 'console.'},
        }),
      )
      expect(next.events.at(-1)).toEqual({
        type: 'completions',
        result: {items: ['console.log', 'console.warn', 'console.error'], prefix: 'console.'},
      })
    })

    test('disconnect with error sets error state', () => {
      const state = createInitialState()
      const [next] = reduce(state, deviceEvent({type: 'disconnect', error: 'device lost'}))
      expect(next.connection).toEqual({type: 'error', message: 'device lost'})
      expect(next.events.at(-1)).toEqual({type: 'disconnect', error: 'device lost'})
    })

    test('disconnect without error emits end', () => {
      const state = createInitialState()
      const [, effects] = reduce(state, deviceEvent({type: 'disconnect'}))
      expect(effects).toContainEqual({type: 'end'})
    })

    test('/resume clears paused flag', () => {
      const state = createInitialState()
      const [ready] = reduce(
        state,
        deviceEvent({type: 'ready', chip: 'ESP32', id: null, version: null}),
      )
      // Pause first
      let s = typeChars(ready, '/pause')
      ;[s] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(s.paused).toBe(true)
      // Resume
      s = typeChars(s, '/resume')
      ;[s] = reduce(s, keyAction('', {return: true, ctrl: true}))
      expect(s.paused).toBe(false)
    })
  })

  describe('createRepl factory', () => {
    test('state$ emits initial state and responds to session events', async () => {
      const {Subject} = await import('rxjs')
      const messages$ = new Subject<Extract<ReplAction, {type: 'deviceEvent'}>['event']>()
      const mockSession = {
        messages$,
        eval: () => {},
        directive: () => {},
        complete: () => {},
        exit: () => {},
        restart: () => {},
        close: () => {},
        ready$: messages$,
        awaitReady$: () => messages$,
        deploy: () => messages$,
        config: {list: async () => [], set: async () => {}, delete: async () => {}},
      }

      const {createRepl: create} = await import('../serial/replStateMachine.js')
      const repl = create({
        session: mockSession as any,
        port: '/dev/test',
        onEnd: () => {},
        loadHistory: () => [],
        saveHistory: () => {},
      })

      const states: ReplMachineState[] = []
      const sub = repl.state$.subscribe((s) => states.push(s))

      // Push a ready event
      messages$.next({type: 'ready', chip: 'ESP32', id: null, version: null})
      expect(states.length).toBeGreaterThan(0)
      expect(states.at(-1)!.connection.type).toBe('ready')

      // Key input
      repl.keyInput('a', {
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
      })
      expect(states.at(-1)!.input).toBe('a')

      // setDisabled
      repl.setDisabled(true)
      expect(states.at(-1)!.disabled).toBe(true)

      // setError
      repl.setError('test error')
      expect(states.at(-1)!.connection).toEqual({type: 'error', message: 'test error'})

      sub.unsubscribe()
    })

    test('effects call session methods', async () => {
      const {Subject} = await import('rxjs')
      const messages$ = new Subject<Extract<ReplAction, {type: 'deviceEvent'}>['event']>()
      const calls: string[] = []
      const mockSession = {
        messages$,
        eval: (code: string) => calls.push(`eval:${code}`),
        directive: (code: string) => calls.push(`directive:${code}`),
        complete: () => {},
        exit: () => calls.push('exit'),
        restart: () => calls.push('restart'),
        close: () => {},
        ready$: messages$,
        awaitReady$: () => messages$,
        deploy: () => messages$,
        config: {list: async () => [], set: async () => {}, delete: async () => {}},
      }

      const {createRepl: create} = await import('../serial/replStateMachine.js')
      const onEnd = () => calls.push('end')
      const repl = create({
        session: mockSession as any,
        port: '/dev/test',
        onEnd,
        loadHistory: () => [],
        saveHistory: () => {},
      })

      const sub = repl.state$.subscribe(() => {})

      // Get to ready state
      messages$.next({type: 'ready', chip: 'ESP32', id: null, version: null})

      // Type and submit
      repl.keyInput('1', NO_KEY)
      repl.keyInput('', {...NO_KEY, return: true, ctrl: true})
      expect(calls).toContain('eval:1')

      // Restart
      repl.keyInput('r', {...NO_KEY, ctrl: true})
      expect(calls).toContain('restart')

      sub.unsubscribe()
    })

    test('Ctrl+R re-subscribes to awaitReady$ so a fresh ready can recover the connection', async () => {
      const {Subject, Observable} = await import('rxjs')
      const messages$ = new Subject<Extract<ReplAction, {type: 'deviceEvent'}>['event']>()
      let awaitReadySubscriptions = 0
      const mockSession = {
        messages$,
        eval: () => {},
        directive: () => {},
        complete: () => {},
        exit: () => {},
        restart: () => {},
        close: () => {},
        ready$: messages$,
        // Each subscription represents a fresh HELLO-poll cycle: the real
        // session.awaitReady$ polls CMD_HELLO until MSG_READY arrives, so
        // counting subscriptions is the closest proxy for "is the handshake
        // being driven right now?"
        awaitReady$: () =>
          new Observable(() => {
            awaitReadySubscriptions++
            return () => {}
          }),
        deploy: () => messages$,
        config: {list: async () => [], set: async () => {}, delete: async () => {}},
      }

      const {createRepl: create} = await import('../serial/replStateMachine.js')
      const repl = create({
        session: mockSession as any,
        port: '/dev/test',
        onEnd: () => {},
        loadHistory: () => [],
        saveHistory: () => {},
      })

      const states: ReplMachineState[] = []
      const sub = repl.state$.subscribe((s) => states.push(s))

      // Initial subscription kicks awaitReady$ once on REPL start.
      expect(awaitReadySubscriptions).toBe(1)

      // Drive the device to ready.
      messages$.next({type: 'ready', chip: 'ESP32', id: null, version: null})
      expect(states.at(-1)!.connection.type).toBe('ready')

      // User hits Ctrl+R.
      repl.keyInput('r', {...NO_KEY, ctrl: true})

      // Connection drops to 'connecting' with 'Restarting…' and the handshake
      // is re-driven (otherwise the device — which only emits MSG_READY in
      // response to CMD_HELLO — would never report ready and the state would
      // be stuck on 'Restarting…' forever).
      expect(states.at(-1)!.connection).toEqual({
        type: 'connecting',
        message: 'Restarting…',
      })
      expect(awaitReadySubscriptions).toBe(2)

      // A fresh post-restart ready event flips the state back to ready.
      messages$.next({type: 'ready', chip: 'ESP32', id: null, version: null})
      expect(states.at(-1)!.connection.type).toBe('ready')

      sub.unsubscribe()
    })
  })
})

import {appendFileSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {EMPTY, merge, type Observable, of, Subject, timer} from 'rxjs'
import {
  catchError,
  filter,
  first,
  ignoreElements,
  map,
  scan,
  shareReplay,
  startWith,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators'
import {SerialPort} from 'serialport'

import {getDeviceAlias, removeDeviceAlias, setDeviceAlias} from '../deviceAliases.js'
import {rememberDeviceForPort} from '../deviceCache.js'
import {FirmwareIncompatibleError} from '../firmwareCompat.js'
import {getMikroDir} from '../projectRoot.js'
import {isIncomplete} from '../protocol.js'
import type {ReplEvent, ReplSession} from '../session.js'

// ── Types ──────────────────────────────────────────────────

export type ConnectionState =
  | {type: 'connecting'; message?: string}
  | {type: 'negotiating'; message?: string}
  | {type: 'reconnecting'; message?: string}
  | {type: 'ready'; chip: string | null; deviceId: string | null; firmwareVersion: string | null}
  | {type: 'error'; message: string}
  | {type: 'fallback'}

/** Structured event entries accumulated by the state machine. */
export type ReplLogEvent =
  | ReplEvent
  | {type: 'connecting'; port?: string}
  | {type: 'restarting'}
  | {type: 'input'; code: string; timing?: string}

export interface ReplMachineState {
  connection: ConnectionState
  port?: string
  input: string
  cursor: number
  history: string[]
  historyIdx: number
  historyDraft: string | null
  showWelcome: boolean
  evaluating: boolean
  paused: boolean
  ctrlCPending: boolean
  returnPending: boolean
  disabled: boolean
  deployStatus: string | null
  /** Sticky error message for the REPL footer (e.g. "Hook failed: tsc
   *  --noEmit (exit 2)"). Cleared when the next deploy cycle starts. */
  footerError: string | null
  overrideHint: string | null
  contextHint: string | null
  pendingInput: string | null
  pendingTiming: string | null
  overlay: null | 'env'
  events: ReplLogEvent[]
}

// ── Actions ────────────────────────────────────────────────

export type KeyInfo = {
  ctrl: boolean
  meta: boolean
  shift: boolean
  return: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  leftArrow: boolean
  rightArrow: boolean
  upArrow: boolean
  downArrow: boolean
  home: boolean
  end: boolean
}

export type ReplAction =
  | {type: 'key'; ch: string; key: KeyInfo}
  | {type: 'deviceEvent'; event: ReplEvent}
  | {type: 'setDisabled'; disabled: boolean}
  | {type: 'setDeployStatus'; message: string | null}
  | {type: 'setError'; message: string; suppressLogEntry?: boolean}
  | {type: 'setFooterError'; message: string | null}
  | {type: 'ctrlCTimeout'}
  | {type: 'returnResolve'}
  | {type: 'closeOverlay'}

// ── Effects ────────────────────────────────────────────────

export type ReplEffect =
  | {type: 'eval'; code: string}
  | {type: 'directive'; code: string}
  | {type: 'setAlias'; name: string}
  | {type: 'unsetAlias'}
  | {type: 'exit'}
  | {type: 'restart'}
  | {type: 'end'}
  | {type: 'deploy'; force: boolean}
  | {type: 'appendHistory'; entry: string}
  | {type: 'scheduleCtrlCTimeout'}
  | {type: 'scheduleReturnResolve'; multiline: boolean}

// ── Constants ──────────────────────────────────────────────

/** All available slash commands */
const SLASH_COMMANDS = [
  '/help',
  '/alias',
  '/env',
  '/mem',
  '/info',
  '/gc',
  '/pause',
  '/resume',
  '/time',
  '/depth',
  '/hidden',
  '/ls',
  '/cat',
  '/rm',
  '/df',
  '/du',
  '/exit',
]

/** Context hints matched against the current input. First match wins. */
const CONTEXT_HINTS: {pattern: RegExp; hint: string}[] = [
  {pattern: /^console\.\s*$/, hint: 'console.log()  console.warn()  console.error()'},
  {
    pattern: /^import\s/,
    hint: 'import {x} from "mikro/module"  Built-in modules: fs, sys, stdio',
  },
]

export const WELCOME_HINT =
  'Enter to submit  |  Ctrl+D to exit  |  Ctrl+C to clear  |  /help for commands'
export const MULTILINE_HINT = 'Ctrl+Enter to submit  |  Enter to add line'

function historyFile() {
  return join(getMikroDir(), 'history.txt')
}
const HISTORY_MAX = 200

// ── Pure helpers ───────────────────────────────────────────

/** Find the line index and column for a cursor position in text */
export function cursorLocation(text: string, cursor: number) {
  const lines = text.split('\n')
  let pos = 0
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length
    if (cursor <= pos + lineLen) {
      return {line: i, col: cursor - pos, lineCount: lines.length}
    }
    pos += lineLen + 1
  }
  return {line: lines.length - 1, col: 0, lineCount: lines.length}
}

/** Get the start offset of a given line index */
export function lineStartOffset(text: string, lineIdx: number): number {
  let pos = 0
  const lines = text.split('\n')
  for (let i = 0; i < lineIdx && i < lines.length; i++) {
    pos += lines[i]!.length + 1
  }
  return pos
}

function resolveContextHint(input: string): string | null {
  // Slash command autocomplete: filter matching commands as you type
  if (input.startsWith('/') && !input.includes(' ') && !input.includes('\n')) {
    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(input))
    if (matches.length > 0) return matches.join('  ')
    return null
  }
  return CONTEXT_HINTS.find((h) => h.pattern.test(input))?.hint ?? null
}

// ── History persistence ────────────────────────────────────

export function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/\\n/g, '\n').replace(/\\\\/g, '\\'))
      .slice(-HISTORY_MAX)
  } catch {
    return []
  }
}

export function appendHistory(entry: string) {
  try {
    const escaped = entry.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
    appendFileSync(historyFile(), escaped + '\n')
  } catch {
    // ignore write errors
  }
}

// ── Initial state ──────────────────────────────────────────

export function createInitialState(port?: string, history: string[] = []): ReplMachineState {
  return {
    connection: {type: 'connecting'},
    port,
    input: '',
    cursor: 0,
    history,
    historyIdx: -1,
    historyDraft: null,
    showWelcome: true,
    evaluating: false,
    paused: false,
    ctrlCPending: false,
    returnPending: false,
    disabled: false,
    deployStatus: null,
    footerError: null,
    overrideHint: null,
    contextHint: null,
    pendingInput: null,
    pendingTiming: null,
    overlay: null,
    events: [{type: 'connecting', port}],
  }
}

// ── Reducer ────────────────────────────────────────────────

export function reduce(
  state: ReplMachineState,
  action: ReplAction,
): [ReplMachineState, ReplEffect[]] {
  switch (action.type) {
    case 'deviceEvent':
      return reduceSessionEvent(state, action.event)
    case 'key':
      return reduceKey(state, action.ch, action.key)
    case 'setDisabled':
      return [
        {
          ...state,
          disabled: action.disabled,
          deployStatus: action.disabled ? state.deployStatus : null,
          // A new cycle starts fresh — clear any sticky footer error
          // from the previous cycle.
          footerError: action.disabled ? null : state.footerError,
        },
        [],
      ]
    case 'setDeployStatus':
      return [{...state, deployStatus: action.message}, []]
    case 'setFooterError':
      return [{...state, footerError: action.message}, []]
    case 'setError': {
      const connection: ConnectionState = {type: 'error', message: action.message}
      // Connection-class failures (device timeouts, link gone) opt in to
      // suppressLogEntry: the footer already renders the message with
      // the troubleshooting link, so a duplicate line in the scrollback
      // is noise. Build/deploy/hook failures always log so the full
      // diagnostic survives once a new cycle clears the footer.
      const events = action.suppressLogEntry
        ? state.events
        : [...state.events, {type: 'error', text: action.message} satisfies ReplLogEvent]
      return [{...state, connection, events}, []]
    }
    case 'ctrlCTimeout':
      if (!state.ctrlCPending) return [state, []]
      return [{...state, ctrlCPending: false, overrideHint: null}, []]
    case 'returnResolve':
      return reduceReturnResolve(state, action)
    case 'closeOverlay':
      return [{...state, overlay: null}, []]
  }
}

// ── Session event handling ─────────────────────────────────

function reduceSessionEvent(
  state: ReplMachineState,
  event: ReplEvent,
): [ReplMachineState, ReplEffect[]] {
  switch (event.type) {
    case 'ready': {
      if (state.connection.type === 'ready') return [state, []]
      const connection: ConnectionState = {
        type: 'ready',
        chip: event.chip,
        deviceId: event.id,
        firmwareVersion: event.version,
      }
      return [{...state, connection, events: [...state.events, event]}, []]
    }
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
      return [{...state, events: [...state.events, event]}, []]
    case 'eval_error':
      return [{...state, evaluating: false, events: [...state.events, event]}, []]
    case 'result': {
      if (event.text.length > 0) {
        return [{...state, evaluating: false, events: [...state.events, event]}, []]
      }
      return [{...state, evaluating: false}, []]
    }
    case 'completions': {
      const result = event.result
      if (!result || result.items.length === 0) return [state, []]
      if (result.items.length === 1) {
        const input = result.items[0]!
        return [{...state, input, cursor: input.length}, []]
      }
      return [{...state, events: [...state.events, event]}, []]
    }
    case 'prompt': {
      // Flush pending input now that we have timing info from the prompt
      const next = flushPendingInput({...state, pendingTiming: event.timing}, event)
      return [next, []]
    }
    case 'raw':
    case 'test':
      return [{...state, events: [...state.events, event]}, []]
    case 'reconnecting': {
      // Already showing reconnecting state — drop the duplicate without
      // re-appending. The supervised session can emit this more than once
      // (each new poll cycle), and we only want one line in the footer.
      if (state.connection.type === 'reconnecting') return [state, []]
      const connection: ConnectionState = {
        type: 'reconnecting',
        message: state.port ? `Reconnecting to ${state.port}…` : 'Reconnecting…',
      }
      return [{...state, connection}, []]
    }
    case 'reconnected':
      // Informational only — the follow-up `ready` event transitions back.
      return [state, []]
    case 'disconnect': {
      if (event.error) {
        // The footer already shows the error message; appending to events
        // would duplicate it as a red scrollback line.
        const connection: ConnectionState = {type: 'error', message: event.error}
        return [{...state, connection}, []]
      }
      return [state, [{type: 'end'}]]
    }
    default:
      return [state, []]
  }
}

function flushPendingInput(state: ReplMachineState, _trigger: ReplEvent): ReplMachineState {
  if (!state.pendingInput) return state
  const inputEvent: ReplLogEvent = {
    type: 'input',
    code: state.pendingInput,
    timing: state.pendingTiming ?? undefined,
  }
  return {
    ...state,
    pendingInput: null,
    pendingTiming: null,
    events: [...state.events, inputEvent],
  }
}

// ── Key handling ───────────────────────────────────────────

function reduceKey(
  state: ReplMachineState,
  ch: string,
  key: KeyInfo,
): [ReplMachineState, ReplEffect[]] {
  // Overlay active: input goes to the overlay component, not the REPL
  if (state.overlay) return [state, []]

  // Before ready: only allow exit
  if (state.connection.type !== 'ready') {
    if (key.ctrl && (ch === 'q' || ch === 'd')) return [state, [{type: 'end'}]]
    return [state, []]
  }

  // ── Control sequences ──────────────────────────────────
  if (key.ctrl && ch === 'q') return [state, [{type: 'exit'}, {type: 'end'}]]

  if (key.ctrl && ch === 'r') {
    const connection: ConnectionState = {type: 'connecting', message: 'Restarting…'}
    const event: ReplLogEvent = {type: 'restarting'}
    return [{...state, connection, events: [...state.events, event]}, [{type: 'restart'}]]
  }

  if (key.ctrl && ch === 'd' && state.input === '') {
    return [state, [{type: 'exit'}, {type: 'end'}]]
  }

  if (key.ctrl && ch === 'c') {
    return reduceCtrlC(state)
  }

  if (state.disabled) return [state, []]

  if (key.tab) {
    const input = state.input.slice(0, state.cursor) + '  ' + state.input.slice(state.cursor)
    return [{...state, input, cursor: state.cursor + 2, showWelcome: false}, []]
  }

  // ── Newline (Shift+Enter or Alt+Enter) ─────────────────
  if (key.return && (key.shift || key.meta)) {
    const input = state.input.slice(0, state.cursor) + '\n' + state.input.slice(state.cursor)
    return [{...state, input, cursor: state.cursor + 1, showWelcome: false}, []]
  }

  // ── Submit (Ctrl+Enter) ────────────────────────────────
  if (key.return && key.ctrl) {
    return reduceSubmit(state)
  }

  // ── Enter (deferred for paste detection) ───────────────
  if (key.return && !key.ctrl) {
    const multiline = state.input.includes('\n')
    return [{...state, returnPending: true}, [{type: 'scheduleReturnResolve', multiline}]]
  }

  // ── Home / Ctrl+A ──────────────────────────────────────
  if (key.home || (key.ctrl && ch === 'a')) {
    const lineStart = state.input.lastIndexOf('\n', state.cursor - 1) + 1
    return [{...state, cursor: lineStart}, []]
  }

  // ── End / Ctrl+E ───────────────────────────────────────
  if (key.end || (key.ctrl && ch === 'e')) {
    let lineEnd = state.input.indexOf('\n', state.cursor)
    if (lineEnd === -1) lineEnd = state.input.length
    return [{...state, cursor: lineEnd}, []]
  }

  // ── Alt+Left / ESC b ──────────────────────────────────
  if ((key.leftArrow && key.meta) || (key.meta && ch === 'b')) {
    let i = state.cursor - 1
    while (i > 0 && /\W/.test(state.input[i - 1]!)) i--
    while (i > 0 && /\w/.test(state.input[i - 1]!)) i--
    return [{...state, cursor: Math.max(0, i)}, []]
  }

  // ── Alt+Right / ESC f ─────────────────────────────────
  if ((key.rightArrow && key.meta) || (key.meta && ch === 'f')) {
    let i = state.cursor
    while (i < state.input.length && /\W/.test(state.input[i]!)) i++
    while (i < state.input.length && /\w/.test(state.input[i]!)) i++
    return [{...state, cursor: i}, []]
  }

  // ── Arrow keys ─────────────────────────────────────────
  if (key.leftArrow) return [{...state, cursor: Math.max(0, state.cursor - 1)}, []]
  if (key.rightArrow)
    return [{...state, cursor: Math.min(state.input.length, state.cursor + 1)}, []]
  if (key.upArrow) return [reduceUpArrow(state), []]
  if (key.downArrow) return [reduceDownArrow(state), []]

  // ── Ctrl+S — trigger deploy (Ctrl+Shift+S forces full redeploy) ─
  if (key.ctrl && ch === 's') {
    return [state, [{type: 'deploy', force: key.shift}]]
  }

  // ── Alt+Backspace — delete previous word ───────────────
  if (key.backspace && key.meta) {
    let i = state.cursor - 1
    while (i > 0 && /\W/.test(state.input[i - 1]!)) i--
    while (i > 0 && /\w/.test(state.input[i - 1]!)) i--
    const wordStart = Math.max(0, i)
    if (wordStart < state.cursor) {
      const input = state.input.slice(0, wordStart) + state.input.slice(state.cursor)
      return [
        {
          ...state,
          input,
          cursor: wordStart,
          overrideHint: null,
          contextHint: resolveContextHint(input),
        },
        [],
      ]
    }
    return [state, []]
  }

  // ── Backspace ───────────────────────────────────────────
  if (key.backspace) {
    if (state.cursor > 0) {
      const input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor)
      return [
        {
          ...state,
          input,
          cursor: state.cursor - 1,
          overrideHint: null,
          contextHint: resolveContextHint(input),
        },
        [],
      ]
    }
    return [state, []]
  }

  // ── Delete (forward) ───────────────────────────────────
  if (key.delete) {
    if (state.cursor < state.input.length) {
      const input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1)
      return [
        {
          ...state,
          input,
          overrideHint: null,
          contextHint: resolveContextHint(input),
        },
        [],
      ]
    }
    return [state, []]
  }

  // ── Regular character input ────────────────────────────
  if (ch && !key.ctrl && !key.meta) {
    return reduceCharInput(state, ch)
  }

  return [state, []]
}

function reduceCtrlC(state: ReplMachineState): [ReplMachineState, ReplEffect[]] {
  if (state.input.length > 0) {
    return [
      {...state, input: '', cursor: 0, ctrlCPending: false, overrideHint: null, contextHint: null},
      [],
    ]
  }
  if (state.ctrlCPending) {
    return [state, [{type: 'exit'}, {type: 'end'}]]
  }
  return [
    {...state, ctrlCPending: true, overrideHint: 'Press Ctrl+C again to exit, or Ctrl+D'},
    [{type: 'scheduleCtrlCTimeout'}],
  ]
}

function reduceCharInput(state: ReplMachineState, ch: string): [ReplMachineState, ReplEffect[]] {
  let {input, cursor} = state

  // If Return is pending, it was a paste newline — insert \n instead of submitting
  if (state.returnPending) {
    input = input.slice(0, cursor) + '\n' + input.slice(cursor)
    cursor++
  }

  // Normalize line endings and expand tabs
  const text = ch.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  input = input.slice(0, cursor) + text + input.slice(cursor)
  cursor += text.length

  return [
    {
      ...state,
      input,
      cursor,
      returnPending: false,
      historyIdx: -1,
      ctrlCPending: false,
      showWelcome: false,
      overrideHint: null,
      contextHint: resolveContextHint(input),
    },
    [],
  ]
}

function reduceUpArrow(state: ReplMachineState): ReplMachineState {
  const loc = cursorLocation(state.input, state.cursor)
  if (loc.line > 0) {
    const targetStart = lineStartOffset(state.input, loc.line - 1)
    const targetLineLen = (state.input.split('\n')[loc.line - 1] ?? '').length
    return {...state, cursor: targetStart + Math.min(loc.col, targetLineLen)}
  }
  if (state.cursor === 0 && state.history.length > 0) {
    const historyDraft = state.historyIdx < 0 ? state.input : state.historyDraft
    const idx = state.historyIdx < 0 ? state.history.length - 1 : Math.max(0, state.historyIdx - 1)
    return {...state, historyIdx: idx, historyDraft, input: state.history[idx]!, cursor: 0}
  }
  if (loc.line === 0 && state.cursor > 0) {
    return {...state, cursor: 0}
  }
  return state
}

function reduceDownArrow(state: ReplMachineState): ReplMachineState {
  const loc = cursorLocation(state.input, state.cursor)
  if (loc.line < loc.lineCount - 1) {
    const targetStart = lineStartOffset(state.input, loc.line + 1)
    const targetLineLen = (state.input.split('\n')[loc.line + 1] ?? '').length
    return {...state, cursor: targetStart + Math.min(loc.col, targetLineLen)}
  }
  if (loc.line === loc.lineCount - 1 && state.cursor < state.input.length) {
    return {...state, cursor: state.input.length}
  }
  if (state.cursor === state.input.length && state.historyIdx >= 0) {
    const idx = state.historyIdx + 1
    if (idx >= state.history.length) {
      return {
        ...state,
        historyIdx: -1,
        input: state.historyDraft ?? '',
        historyDraft: null,
        cursor: (state.historyDraft ?? '').length,
      }
    }
    return {
      ...state,
      historyIdx: idx,
      input: state.history[idx]!,
      cursor: state.history[idx]!.length,
    }
  }
  return state
}

// ── Submit ─────────────────────────────────────────────────

function reduceSubmit(state: ReplMachineState): [ReplMachineState, ReplEffect[]] {
  if (state.disabled) return [state, []]

  const value = state.input

  // Auto-continue if expression is incomplete
  if (isIncomplete(value)) {
    const input = `${value}\n`
    return [{...state, input, cursor: input.length}, []]
  }

  const code = value.trim()
  if (!code) return [state, []]

  const effects: ReplEffect[] = [{type: 'appendHistory', entry: code}]

  const resetState = {
    ...state,
    history: [...state.history, code].slice(-HISTORY_MAX),
    historyIdx: -1,
    input: '',
    cursor: 0,
  }

  if (code === '/env') {
    return [{...resetState, overlay: 'env'}, effects]
  }

  if (code === '/exit') {
    return [resetState, [...effects, {type: 'exit'}, {type: 'end'}]]
  }

  // `/help` is device-answered; add host-only commands so `/alias` shows up.
  if (code === '/help') {
    const inputEvent: ReplLogEvent = {type: 'input', code}
    const hostHelp: ReplLogEvent = {
      type: 'info',
      text: 'Host commands: /alias set <name> (name this device) · /alias unset (remove its name)',
    }
    const next = {...resetState, events: [...resetState.events, inputEvent, hostHelp]}
    return [next, [...effects, {type: 'directive', code}]]
  }

  // `/alias` is host-side (writes the local alias file), not forwarded.
  if (code === '/alias' || code.startsWith('/alias ')) {
    const rest = code.slice('/alias'.length).trim()
    const inputEvent: ReplLogEvent = {type: 'input', code}
    const next = {...resetState, events: [...resetState.events, inputEvent]}
    if (rest === 'unset') {
      return [next, [...effects, {type: 'unsetAlias'}]]
    }
    // Anything but "set <name>" yields an empty name → usage message.
    const name = /^set\s+(.+)$/.exec(rest)?.[1]?.trim() ?? ''
    return [next, [...effects, {type: 'setAlias', name}]]
  }

  if (!code.includes('\n') && /^\/[a-z]+(\s|$)/i.test(code)) {
    const inputEvent: ReplLogEvent = {type: 'input', code}
    const next = {...resetState, events: [...resetState.events, inputEvent]}
    if (code === '/pause') return [{...next, paused: true}, [...effects, {type: 'directive', code}]]
    if (code === '/resume')
      return [{...next, paused: false}, [...effects, {type: 'directive', code}]]
    return [next, [...effects, {type: 'directive', code}]]
  }

  // Eval: defer input echo until result arrives
  return [
    {
      ...resetState,
      pendingInput: code,
      pendingTiming: null,
      evaluating: true,
    },
    [...effects, {type: 'eval', code}],
  ]
}

// ── Return resolve (paste detection) ───────────────────────

function reduceReturnResolve(
  state: ReplMachineState,
  _action: {type: 'returnResolve'},
): [ReplMachineState, ReplEffect[]] {
  if (!state.returnPending) return [state, []]

  const next = {...state, returnPending: false}

  // Single-line: submit
  if (!state.input.includes('\n')) {
    return reduceSubmit(next)
  }

  // Multi-line: insert newline
  const input = state.input.slice(0, state.cursor) + '\n' + state.input.slice(state.cursor)
  return [{...next, input, cursor: state.cursor + 1}, []]
}

// ── Factory ────────────────────────────────────────────────

export interface ReplHandle {
  state$: Observable<ReplMachineState>
  deploys$: Observable<{force: boolean}>
  keyInput(ch: string, key: KeyInfo): void
  setDisabled(disabled: boolean): void
  setDeployStatus(message: string | null): void
  setError(message: string, opts?: {suppressLogEntry?: boolean}): void
  /** Pin an error message in the REPL footer until the next cycle
   *  starts. Use alongside `logEvent({type:'error', …})` for errors
   *  that should remain visible after the output scrolls past. */
  setFooterError(message: string | null): void
  /** Append an entry to the REPL log pane without touching connection
   *  state. Use for CLI-originated output (e.g. predeploy hook stdout/
   *  stderr) that must survive Ink's patched stdout/stderr. */
  logEvent(event: ReplLogEvent): void
  closeOverlay(): void
}

const CONNECTION_TIMEOUT_MS = 15_000

export function createRepl(options: {
  session: ReplSession
  port?: string
  onEnd: () => void
  /** Connection timeout in ms (default: 15000) */
  timeout?: number
  loadHistory?: () => string[]
  saveHistory?: (entry: string) => void
  /** When false, Ctrl+S does nothing (deploy isn't meaningful in this
   *  context, e.g. `mikro console`). Defaults to true. */
  deployEnabled?: boolean
}): ReplHandle {
  const {session, port, onEnd, deployEnabled = true} = options
  const timeoutMs = options.timeout ?? CONNECTION_TIMEOUT_MS
  const loadHistoryFn = options.loadHistory ?? loadHistory
  const saveHistoryFn = options.saveHistory ?? appendHistory
  const actions$ = new Subject<ReplAction>()
  const deploys$ = new Subject<{force: boolean}>()
  const restarts$ = new Subject<void>()
  const initial = createInitialState(port, loadHistoryFn())

  const sessionActions$: Observable<ReplAction> = session.messages$.pipe(
    // Cache chip/deviceId on connect so the picker and `ls` can show them while
    // disconnected (the only id source for USB-UART bridge boards).
    tap((event: ReplEvent) => {
      if (event.type === 'ready') {
        void rememberDeviceForPort(port, {
          chip: event.chip ?? undefined,
          deviceId: event.id ?? undefined,
        })
      }
    }),
    map((event: ReplEvent): ReplAction => ({type: 'deviceEvent', event})),
  )

  // Connection timeout: after the full window without a MSG_READY, give
  // up and surface an error. The troubleshooting hint is rendered by
  // ReplConsole on its own delay (see TROUBLESHOOTING_HINT_DELAY_MS), so
  // the state machine doesn't need a separate "show hint" timer.
  const ready$ = sessionActions$.pipe(
    filter((a) => a.type === 'deviceEvent' && a.event.type === 'ready'),
    first(),
  )
  const connectionTimeout$ = timer(timeoutMs).pipe(
    takeUntil(ready$),
    map(
      (): ReplAction => ({
        type: 'setError',
        message: `Connection timed out after ${timeoutMs / 1000}s`,
        suppressLogEntry: true,
      }),
    ),
  )

  // Surface firmware-incompat errors as a setError action so the user sees
  // the actionable "run flash to update device" message. Other errors
  // (notably rxjs TimeoutError) are swallowed because connectionTimeout$
  // above handles the timeout case independently.
  const driveHandshake$ = (): Observable<ReplAction> =>
    session.awaitReady$(timeoutMs).pipe(
      ignoreElements(),
      catchError((err): Observable<ReplAction> => {
        if (err instanceof FirmwareIncompatibleError) {
          return of({type: 'setError', message: err.message})
        }
        return EMPTY
      }),
    )

  // The device only sends MSG_READY in reply to CMD_HELLO. awaitReady$
  // polls HELLO until a fresh ready arrives; we merge it as a side-effect
  // (no actions emitted) so the existing 'ready' deviceEvent flow drives
  // the state machine.
  const handshakeDriver$ = driveHandshake$()

  // After a user-triggered restart (Ctrl+R) the device reboots and stops
  // emitting MSG_READY until something polls CMD_HELLO again. Re-subscribe
  // to awaitReady$ on each restart so the handshake resumes; without this
  // the connection state stays in 'Restarting…' forever.
  const restartHandshakeDriver$: Observable<ReplAction> = restarts$.pipe(
    switchMap(() => driveHandshake$()),
  )

  const state$ = merge(
    sessionActions$,
    actions$,
    connectionTimeout$,
    handshakeDriver$,
    restartHandshakeDriver$,
  ).pipe(
    scan((state: ReplMachineState, action: ReplAction): ReplMachineState => {
      const [nextState, effects] = reduce(state, action)
      for (const effect of effects) {
        handleEffect(effect)
      }
      return nextState
    }, initial),
    startWith(initial),
    shareReplay({bufferSize: 1, refCount: true}),
  )

  function handleEffect(effect: ReplEffect) {
    switch (effect.type) {
      case 'eval':
        session.eval(effect.code)
        break
      case 'directive':
        session.directive(effect.code)
        break
      case 'setAlias':
        void applyAlias(effect.name)
        break
      case 'unsetAlias':
        void applyUnalias()
        break
      case 'exit':
        session.exit()
        break
      case 'restart':
        session.restart()
        restarts$.next()
        break
      case 'end':
        onEnd()
        break
      case 'deploy':
        // When `deployEnabled` is false (e.g. `mikro console`), the Ctrl+S
        // keybind is a no-op so it doesn't feed a Subject that nothing
        // subscribes to.
        if (deployEnabled) deploys$.next({force: effect.force})
        break
      case 'appendHistory':
        saveHistoryFn(effect.entry)
        break
      case 'scheduleCtrlCTimeout':
        setTimeout(() => actions$.next({type: 'ctrlCTimeout'}), 3000)
        break
      case 'scheduleReturnResolve':
        queueMicrotask(() => actions$.next({type: 'returnResolve'}))
        break
    }
  }

  // /alias feedback shows up inline as a normal log line. Deferred to a
  // microtask so synchronous callers (the empty-name usage message) don't
  // re-enter the scan reducer mid-action, which would drop the event.
  function emitAlias(type: 'info' | 'error', text: string) {
    queueMicrotask(() => actions$.next({type: 'deviceEvent', event: {type, text}}))
  }

  // Serial number for the connected port; emits a log line and returns undefined
  // when it can't be determined. Async, so callers run from an effect.
  async function aliasSerial(): Promise<string | undefined> {
    if (!port || port === 'simulator') {
      emitAlias('error', 'Cannot manage an alias for this session')
      return undefined
    }
    let serial: string | undefined
    try {
      const devices = await SerialPort.list()
      serial = devices.find((d) => d.path === port)?.serialNumber
    } catch (err) {
      emitAlias('error', `Could not read serial ports: ${err instanceof Error ? err.message : err}`)
      return undefined
    }
    if (!serial) {
      emitAlias('error', `No serial number found for ${port}; cannot manage its alias`)
    }
    return serial
  }

  async function applyAlias(rawName: string) {
    const name = rawName.trim()
    if (!name) {
      emitAlias('error', 'Usage: /alias set <name> | /alias unset')
      return
    }
    const serial = await aliasSerial()
    if (!serial) return
    const result = setDeviceAlias(serial, name)
    emitAlias(
      result.ok ? 'info' : 'error',
      result.ok ? `Named this device "${name}"` : result.error,
    )
  }

  async function applyUnalias() {
    const serial = await aliasSerial()
    if (!serial) return
    if (!getDeviceAlias(serial)) {
      emitAlias('info', 'This device has no alias')
      return
    }
    const result = removeDeviceAlias(serial)
    emitAlias(result.ok ? 'info' : 'error', result.ok ? 'Removed alias' : result.error)
  }

  return {
    state$,
    deploys$: deploys$.asObservable(),
    keyInput(ch: string, key: KeyInfo) {
      actions$.next({type: 'key', ch, key})
    },
    setDisabled(disabled: boolean) {
      actions$.next({type: 'setDisabled', disabled})
    },
    setDeployStatus(message: string | null) {
      actions$.next({type: 'setDeployStatus', message})
    },
    setError(message: string, opts?: {suppressLogEntry?: boolean}) {
      actions$.next({type: 'setError', message, suppressLogEntry: opts?.suppressLogEntry})
    },
    setFooterError(message: string | null) {
      actions$.next({type: 'setFooterError', message})
    },
    logEvent(event: ReplLogEvent) {
      // For non-ReplEvent log entries (e.g. `{type: 'restarting'}`) we
      // could add a dedicated action, but every caller today emits a
      // ReplEvent, so routing through deviceEvent keeps the surface
      // minimal. The reducer treats it the same as a real device event.
      if (isReplEvent(event)) {
        actions$.next({type: 'deviceEvent', event})
      }
    },
    closeOverlay() {
      actions$.next({type: 'closeOverlay'})
    },
  }
}

function isReplEvent(event: ReplLogEvent): event is ReplEvent {
  switch (event.type) {
    case 'connecting':
    case 'restarting':
    case 'input':
      return false
    default:
      return true
  }
}

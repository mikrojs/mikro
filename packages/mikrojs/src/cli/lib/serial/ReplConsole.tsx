import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Static, Text, useInput} from 'ink'
import React, {useCallback, useEffect, useState} from 'react'

import type {LogLevel} from '../../../_exports/index.js'
import {EnvEditor, type EnvEditorConfig} from '../../components/EnvEditor.js'
import {BorderFill, TitledBox} from '../../components/TitledBox.js'
import {logLevelAllows} from '../parseMinifier.js'
import {Spinner} from '../Spinner.js'
import {TROUBLESHOOTING_HINT_DELAY_MS, TroubleshootingHint} from '../troubleshooting.js'
import {useObservable} from '../useObservable.js'
import {
  createInitialState,
  MULTILINE_HINT,
  type ReplHandle,
  type ReplLogEvent,
  WELCOME_HINT,
} from './replStateMachine.js'

export interface ReplConsoleProps {
  repl: ReplHandle
  config?: EnvEditorConfig
  /** Drop device-originated log events below this threshold. Host-side
   *  backstop for the build-time DCE, which can leak `console.debug`
   *  calls in arrow-callback positions. Defaults to `debug` (show all). */
  logLevel?: LogLevel
  /** Adds a watch-mode line to the footer above the prompt. The footer
   *  also hosts progress messages (connecting, building, deploying,
   *  checking hooks); when nothing is in progress, the watch copy is
   *  shown. `true` → "Watching for file changes…", `false` → "File
   *  watching off. Press Ctrl+S to redeploy", `undefined` → the footer
   *  only appears while something is in progress (e.g. `mikro console`,
   *  where watching doesn't apply). */
  watch?: boolean
}

// ── Event rendering ────────────────────────────────────────

function testEventColor(e: number, data: Record<string, unknown>): string | undefined {
  switch (e) {
    case 2:
      return 'green'
    case 3:
    case 7:
      return 'red'
    case 4:
      return 'yellow'
    case 6:
      return (data.f as number) > 0 ? 'red' : 'green'
    case 8:
      return 'gray'
    default:
      return undefined
  }
}

const deviceIdSpinner = {
  interval: 150,
  frames: [
    ' ∙∙∙●∙∙∙∙∙∙ ',
    ' ∙∙∙∙●∙∙∙∙∙ ',
    ' ∙∙∙∙∙●∙∙∙∙ ',
    ' ∙∙∙∙∙∙●∙∙∙ ',
    ' ∙∙∙∙∙●∙∙∙∙ ',
    ' ∙∙∙∙●∙∙∙∙∙ ',
    ' ∙∙∙●∙∙∙∙∙∙ ',
  ],
}

function eventColor(event: ReplLogEvent): string | undefined {
  switch (event.type) {
    case 'error':
    case 'eval_error':
    case 'disconnect':
      return 'red'
    case 'warn':
      return 'yellow'
    case 'info':
      return 'cyan'
    case 'input':
      return 'blue'
    case 'result':
      return 'green'
    case 'connecting':
    case 'restarting':
      return 'yellow'
    case 'ready':
      return 'green'
    case 'test':
      return testEventColor(event.data.e as number, event.data)
    default:
      return undefined
  }
}

function testEventText(data: Record<string, unknown>): string {
  switch (data.e) {
    case 1: // suite_start
      return String(data.s)
    case 2: // test_pass
      return `  ${figures.tick} ${data.t} (${data.d}ms)`
    case 3: // test_fail
      return `  ${figures.cross} ${data.t} (${data.d}ms)\n    ${data.m}`
    case 4: // test_skip
      return `  - ${data.t}`
    case 6: {
      // run_done
      const parts: string[] = []
      if ((data.p as number) > 0) parts.push(`${data.p} passed`)
      if ((data.f as number) > 0) parts.push(`${data.f} failed`)
      if ((data.k as number) > 0) parts.push(`${data.k} skipped`)
      return `${parts.join(', ')} (${data.d}ms)`
    }
    case 7: // beforeAll error
      return `  ${figures.cross} beforeAll: ${data.m}`
    case 8: {
      // heap
      const used = ((data.u as number) / 1024) | 0
      const total = ((data.t as number) / 1024) | 0
      const parts = [`heap: ${used}/${total}KB, free: ${total - used}KB`]
      if (typeof data.f === 'number') {
        parts.push(`sysFree: ${(data.f / 1024) | 0}KB`)
      }
      if (typeof data.mf === 'number') {
        parts.push(`sysMinFree: ${(data.mf / 1024) | 0}KB`)
      }
      return `[${parts.join(', ')}]`
    }
    default:
      return ''
  }
}

function eventText(event: ReplLogEvent): string {
  switch (event.type) {
    case 'connecting':
      return event.port ? `Connecting to ${event.port}…` : 'Connecting…'
    case 'restarting':
      return 'Restarting…'
    case 'ready': {
      const name = event.id ?? event.chip ?? 'device'
      const chip = event.id && event.chip ? ` (${event.chip})` : ''
      const version = event.version ? ` Mikro.js v${event.version}` : ''
      return `Connected to ${name}${chip}${version}`
    }
    case 'input':
      return event.code
    case 'raw':
      return event.text
    case 'completions':
      return event.result?.items.join('  ') ?? ''
    case 'disconnect':
      return event.error ?? 'Disconnected'
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
    case 'result':
    case 'eval_error':
      return event.text
    case 'test':
      return testEventText(event.data)
    default:
      return ''
  }
}

function shouldRender(event: ReplLogEvent, logLevel: LogLevel): boolean {
  switch (event.type) {
    case 'connecting':
    case 'restarting':
    case 'prompt':
    case 'ok':
    case 'err':
    case 'checksum_result':
    case 'config_entries':
      return false
    case 'disconnect':
      return Boolean(event.error)
    case 'completions':
      return (event.result?.items.length ?? 0) > 1
    case 'raw':
      return event.text.trim().length > 0
    case 'test':
      return event.data.e !== 5 // skip suite_end
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
      return logLevelAllows(logLevel, event.type)
    default:
      return true
  }
}

const INITIAL_STATE = createInitialState()

// ── Component ──────────────────────────────────────────────

export function ReplConsole({repl, config, logLevel = 'debug', watch}: ReplConsoleProps) {
  const state = useObservable(repl.state$, INITIAL_STATE)

  const handleCloseOverlay = useCallback(() => repl.closeOverlay(), [repl])

  useInput((ch, key) => {
    if (!state.overlay) repl.keyInput(ch, key)
  })

  // Eval spinner (shown after 500ms of waiting for result)
  const [showEvalSpinner, setShowEvalSpinner] = useState(false)
  useEffect(() => {
    if (!state.evaluating) return
    const timer = setTimeout(() => setShowEvalSpinner(true), 500)
    return () => {
      clearTimeout(timer)
      setShowEvalSpinner(false)
    }
  }, [state.evaluating])

  // Surface the troubleshooting hint once a connect attempt drags past 8s,
  // so a stuck "Waiting for device…" footer points users at the docs.
  const [connectingTooLong, setConnectingTooLong] = useState(false)
  useEffect(() => {
    const t = state.connection.type
    if (t !== 'connecting' && t !== 'negotiating') return
    const timer = setTimeout(() => setConnectingTooLong(true), TROUBLESHOOTING_HINT_DELAY_MS)
    return () => {
      clearTimeout(timer)
      setConnectingTooLong(false)
    }
  }, [state.connection.type])

  // ── Derived render state ───────────────────────────────────
  const conn = state.connection

  if (conn.type === 'fallback') {
    return (
      <Text color="yellow">
        Device does not support protocol REPL mode. Use `mikro console --raw` for legacy mode.
      </Text>
    )
  }

  if (state.overlay === 'env' && config) {
    return <EnvEditor config={config} onClose={handleCloseOverlay} />
  }

  const isConnecting = conn.type === 'connecting' || conn.type === 'negotiating'
  const isError = conn.type === 'error'

  // One footer line drives both progress and watch-mode messaging so the
  // REPL has a single "what's the dev loop doing right now" signal.
  // Priority: active work outranks sticky errors outranks watch-mode
  // idle copy. A sticky error stays pinned until the next cycle starts.
  const footer: {message: string; tone: 'busy' | 'error' | 'watching' | 'idle'} | null =
    isConnecting
      ? {
          message: conn.message ?? (state.port ? `Connecting to ${state.port}…` : 'Connecting…'),
          tone: 'busy',
        }
      : isError
        ? {
            // Multi-line error messages (e.g. resolvePort listing several
            // matches) get clipped to the first line so the footer stays a
            // single row; the full text is in the scrollback. Single-line
            // failures (DeviceTimeoutError) pass through unchanged.
            // Watch-mode messaging is suppressed so we don't claim to be
            // "watching" when we can't actually reach the device.
            message: conn.message.split('\n')[0] || 'Disconnected from device',
            tone: 'error',
          }
        : state.disabled
          ? {message: state.deployStatus ?? 'Deploying…', tone: 'busy'}
          : state.footerError
            ? {message: state.footerError, tone: 'error'}
            : watch === true
              ? {message: 'Watching for file changes…', tone: 'watching'}
              : watch === false
                ? {message: 'File watching off. Press Ctrl+S to redeploy', tone: 'idle'}
                : null

  const renderableEvents = state.events.filter((event) => shouldRender(event, logLevel))

  const prompt = '❯ '

  return (
    <>
      <Static items={renderableEvents}>
        {(event, index) => {
          const text = eventText(event)
          const color = eventColor(event)
          const isDimmed = event.type === 'input' || event.type === 'debug'
          const timing = event.type === 'input' ? event.timing : undefined

          return (
            <Text key={index} color={color} dimColor={isDimmed}>
              {timing ? `${timing} ` : ''}
              {text}
            </Text>
          )
        }}
      </Static>

      <Box flexDirection="column" marginTop={1}>
        {footer && (
          <Text
            color={footer.tone === 'busy' ? 'magenta' : footer.tone === 'error' ? 'red' : 'gray'}
            dimColor={footer.tone === 'idle' || footer.tone === 'watching'}
          >
            {footer.tone === 'busy' ? (
              <>
                <Spinner spinner={spinners.dots} />{' '}
              </>
            ) : footer.tone === 'error' ? (
              `${figures.cross} `
            ) : footer.tone === 'watching' ? (
              <Text color="green">● </Text>
            ) : (
              ''
            )}
            {footer.message}
          </Text>
        )}
        {isConnecting && connectingTooLong && <TroubleshootingHint />}
        {isConnecting && <Text dimColor>Press Ctrl+C to cancel</Text>}
        <TitledBox
          header={
            <BorderFill
              char="─"
              color={isError || isConnecting ? 'gray' : state.disabled ? 'yellow' : 'blue'}
              dimColor={isConnecting || isError}
              justifyContent="end"
            >
              <Box gap={1} marginX={1}>
                <Box>
                  <Text dimColor>{'⌬ '}</Text>
                  <Text dimColor>Mikro.</Text>
                  <Text bold color="yellow" dimColor>
                    js
                  </Text>
                </Box>
                {conn.type === 'ready' ? (
                  <Text
                    color="black"
                    backgroundColor={conn.chip === 'simulator' ? 'magenta' : 'blue'}
                  >
                    {` ${conn.deviceId ?? conn.chip ?? 'device'} `}
                  </Text>
                ) : conn.type === 'error' ? null : (
                  <Text color="grey">
                    <Spinner spinner={deviceIdSpinner} />
                  </Text>
                )}
              </Box>
            </BorderFill>
          }
          borderStyle="single"
          borderLeft={false}
          borderRight={false}
          borderColor={isError || isConnecting ? 'gray' : state.disabled ? 'yellow' : 'blue'}
          borderDimColor={isConnecting || isError}
          paddingLeft={1}
        >
          <Text
            color={isConnecting || isError ? 'gray' : 'blue'}
            dimColor={isConnecting || isError}
          >
            {showEvalSpinner ? (
              <>
                <Spinner spinner={spinners.dots} />{' '}
              </>
            ) : (
              prompt
            )}
          </Text>
          {state.input === '' ? (
            <Text dimColor={isConnecting || isError}>
              <Text inverse color={isConnecting || isError ? 'gray' : undefined}>
                {' '}
              </Text>
              {showEvalSpinner && <Text dimColor> Evaluating…</Text>}
            </Text>
          ) : (
            <Text color={isConnecting || isError ? 'gray' : undefined}>
              {state.input.slice(0, state.cursor)}
              <Text inverse color={isConnecting || isError ? 'gray' : undefined}>
                {state.cursor >= state.input.length
                  ? ' '
                  : state.input[state.cursor] === '\n'
                    ? ' '
                    : state.input[state.cursor]}
              </Text>
              {state.cursor < state.input.length
                ? (state.input[state.cursor] === '\n' ? '\n' : '') +
                  state.input.slice(state.cursor + 1)
                : ''}
            </Text>
          )}
        </TitledBox>
        <Text dimColor>
          {isConnecting || isError
            ? 'Ctrl+D to exit'
            : (state.overrideHint ??
              (state.input.includes('\n') ? MULTILINE_HINT : null) ??
              (state.showWelcome ? WELCOME_HINT : state.contextHint) ??
              ' ')}
        </Text>
      </Box>
    </>
  )
}

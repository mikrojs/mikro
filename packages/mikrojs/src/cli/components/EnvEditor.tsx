import spinners from 'cli-spinners'
import {Box, Text, useInput, useStdout} from 'ink'
import React, {useCallback, useEffect, useState} from 'react'

import type {EnvEntry} from '../lib/session.js'
import {Spinner} from '../lib/Spinner.js'
import {EMPTY_INPUT, type InputState, reduceInput, TextInput} from './TextInput.js'

export interface EnvEditorConfig {
  list(): Promise<EnvEntry[]>
  set(key: string, value: string, secret: boolean): Promise<void>
  delete(key: string): Promise<void>
}

export interface EnvEditorProps {
  config: EnvEditorConfig
  onClose: () => void
}

const SECRET_MASK = '••••••••'
const NVS_KEY_MAX = 15

type Mode =
  | {type: 'loading'}
  | {type: 'list'}
  | {type: 'add-key'}
  | {type: 'add-secret'; key: string}
  | {type: 'add-value'; key: string; secret: boolean}
  | {type: 'edit-value'; index: number}
  | {type: 'confirm-delete'; index: number}
  | {type: 'saving'; message: string}
  | {type: 'error'; message: string}

export function EnvEditor({config, onClose}: EnvEditorProps) {
  const {stdout} = useStdout()
  const termRows = stdout?.rows ?? 24

  const [entries, setEntries] = useState<EnvEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<Mode>({type: 'loading'})
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const loadEntries = useCallback(async () => {
    try {
      const list = await config.list()
      setEntries(list)
      setSelectedIndex((prev) => Math.min(prev, Math.max(0, list.length - 1)))
      setMode({type: 'list'})
    } catch (err) {
      setMode({type: 'error', message: err instanceof Error ? err.message : String(err)})
    }
  }, [config])

  useEffect(() => {
    let cancelled = false
    config.list().then(
      (list) => {
        if (cancelled) return
        setEntries(list)
        setSelectedIndex((prev) => Math.min(prev, Math.max(0, list.length - 1)))
        setMode({type: 'list'})
      },
      (err) => {
        if (cancelled) return
        setMode({type: 'error', message: err instanceof Error ? err.message : String(err)})
      },
    )
    return () => {
      cancelled = true
    }
  }, [config])

  const showStatus = useCallback((msg: string) => {
    setStatusMessage(msg)
    setTimeout(() => setStatusMessage(null), 3000)
  }, [])

  const doSet = useCallback(
    (key: string, value: string, secret: boolean) => {
      setMode({type: 'saving', message: `Saving ${key}...`})
      void config.set(key, value, secret).then(
        () => {
          showStatus(`Set ${key}. Restart to apply (Ctrl+R).`)
          void loadEntries()
        },
        (err) => setMode({type: 'error', message: String(err)}),
      )
    },
    [config, showStatus, loadEntries],
  )

  useInput((ch, key) => {
    // ── Loading / saving: ignore input ────────────────────
    if (mode.type === 'loading' || mode.type === 'saving') return

    // ── Error: any key returns to list ────────────────────
    if (mode.type === 'error') {
      setMode({type: 'list'})
      return
    }

    // ── Confirm delete ────────────────────────────────────
    if (mode.type === 'confirm-delete') {
      if (ch === 'y' || ch === 'Y') {
        const entry = entries[mode.index]!
        setMode({type: 'saving', message: `Deleting ${entry.key}...`})
        void config.delete(entry.key).then(
          () => {
            showStatus(`Deleted ${entry.key}. Restart to apply (Ctrl+R).`)
            void loadEntries()
          },
          (err) => setMode({type: 'error', message: String(err)}),
        )
      } else {
        setMode({type: 'list'})
      }
      return
    }

    // ── Add: secret prompt (y/n) ──────────────────────────
    if (mode.type === 'add-secret') {
      if (ch === 'y' || ch === 'Y') {
        setInput(EMPTY_INPUT)
        setMode({type: 'add-value', key: mode.key, secret: true})
      } else if (ch === 'n' || ch === 'N' || key.return) {
        setInput(EMPTY_INPUT)
        setMode({type: 'add-value', key: mode.key, secret: false})
      }
      return
    }

    // ── Text input modes ──────────────────────────────────
    if (mode.type === 'add-key' || mode.type === 'add-value' || mode.type === 'edit-value') {
      // Escape: cancel
      if (key.escape) {
        setMode({type: 'list'})
        return
      }

      // Enter: confirm
      if (key.return) {
        if (mode.type === 'add-key') {
          const k = input.value.trim()
          if (!k) return
          if (Buffer.byteLength(k, 'utf-8') > NVS_KEY_MAX) {
            showStatus(`Key exceeds ${NVS_KEY_MAX}-byte NVS limit`)
            return
          }
          setInput(EMPTY_INPUT)
          setMode({type: 'add-secret', key: k})
        } else if (mode.type === 'add-value') {
          const v = input.value
          if (!v) return
          doSet(mode.key, v, mode.secret)
        } else if (mode.type === 'edit-value') {
          const v = input.value
          if (!v) return
          const entry = entries[mode.index]!
          doSet(entry.key, v, entry.secret)
        }
        return
      }

      // Regular text input
      const isSecret =
        (mode.type === 'add-value' && mode.secret) ||
        (mode.type === 'edit-value' && entries[mode.index]?.secret)
      const next = reduceInput(input, ch, key)
      if (next) {
        // Enforce key length limit in add-key mode
        if (mode.type === 'add-key' && Buffer.byteLength(next.value, 'utf-8') > NVS_KEY_MAX) {
          return
        }
        setInput(isSecret ? next : next)
      }
      return
    }

    // ── List mode ─────────────────────────────────────────
    if (mode.type === 'list') {
      // Escape or q: exit
      if (ch === 'q' || key.escape) {
        onClose()
        return
      }

      // Navigation
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(entries.length - 1, i + 1))
        return
      }

      // Add
      if (ch === 'a') {
        setInput(EMPTY_INPUT)
        setMode({type: 'add-key'})
        return
      }

      // Edit
      if (ch === 'e' && entries.length > 0) {
        const entry = entries[selectedIndex]
        if (!entry) return
        setInput(entry.secret ? EMPTY_INPUT : {value: entry.value, cursor: entry.value.length})
        setMode({type: 'edit-value', index: selectedIndex})
        return
      }

      // Delete
      if (ch === 'd' && entries.length > 0) {
        setMode({type: 'confirm-delete', index: selectedIndex})
        return
      }
    }
  })

  // ── Render ──────────────────────────────────────────────

  const isInputMode =
    mode.type === 'add-key' || mode.type === 'add-value' || mode.type === 'edit-value'

  // Column width for key names
  const maxKeyLen = entries.length > 0 ? Math.max(...entries.map((e) => e.key.length), 4) : 4

  // Calculate content height for vertical centering
  const listHeight = Math.max(1, entries.length)
  const headerLines = 2
  const footerLines = 3
  const contentHeight = headerLines + listHeight + footerLines + (isInputMode ? 2 : 0)
  const topPad = Math.max(0, Math.floor((termRows - contentHeight) / 2))

  const termCols = stdout?.columns ?? 80

  return (
    <Box flexDirection="column" paddingTop={topPad}>
      {/* Separator */}
      <Text dimColor>{'─'.repeat(termCols)}</Text>

      {/* Header */}
      <Box paddingX={2}>
        <Text bold color="blue">
          Environment Variables
        </Text>
        {statusMessage && <Text color="yellow"> {statusMessage}</Text>}
      </Box>
      <Text> </Text>

      {/* Loading */}
      {mode.type === 'loading' && (
        <Box paddingX={2}>
          <Text>
            <Spinner spinner={spinners.dots} /> Loading...
          </Text>
        </Box>
      )}

      {/* Error */}
      {mode.type === 'error' && (
        <Box paddingX={2}>
          <Text color="red">Error: {mode.message}</Text>
          <Text dimColor> (press any key)</Text>
        </Box>
      )}

      {/* Saving */}
      {mode.type === 'saving' && (
        <Box paddingX={2}>
          <Text>
            <Spinner spinner={spinners.dots} /> {mode.message}
          </Text>
        </Box>
      )}

      {/* Entry list */}
      {mode.type !== 'loading' && mode.type !== 'error' && mode.type !== 'saving' && (
        <>
          {entries.length === 0 ? (
            <Box paddingX={2}>
              <Text dimColor>No environment variables. Press </Text>
              <Text bold>a</Text>
              <Text dimColor> to add one.</Text>
            </Box>
          ) : (
            entries.map((entry, i) => {
              const isSelected = i === selectedIndex && mode.type === 'list'
              const isEditing = mode.type === 'edit-value' && i === mode.index
              const isDeleting = mode.type === 'confirm-delete' && i === mode.index
              const prefix = isSelected ? '❯ ' : '  '
              const displayValue = entry.secret ? SECRET_MASK : entry.value

              return (
                <Box key={entry.key} paddingX={1}>
                  <Text
                    color={isSelected ? 'blue' : isDeleting ? 'red' : undefined}
                    bold={isSelected}
                    dimColor={!isSelected && !isEditing && !isDeleting}
                  >
                    {prefix}
                    {entry.key.padEnd(maxKeyLen)}
                  </Text>
                  <Text> </Text>
                  {isEditing ? (
                    <TextInput
                      value={input.value}
                      cursor={input.cursor}
                      mask={entry.secret}
                      placeholder={entry.secret ? '(enter new value)' : undefined}
                    />
                  ) : (
                    <Text
                      color={isDeleting ? 'red' : undefined}
                      dimColor={!isSelected && !isDeleting}
                    >
                      {displayValue}
                    </Text>
                  )}
                </Box>
              )
            })
          )}

          {/* Confirm delete prompt */}
          {mode.type === 'confirm-delete' && entries[mode.index] && (
            <>
              <Text> </Text>
              <Box paddingX={2}>
                <Text color="red">
                  Delete {entries[mode.index]!.key}? <Text bold>y</Text>/n
                </Text>
              </Box>
            </>
          )}

          {/* Add key prompt */}
          {mode.type === 'add-key' && (
            <>
              <Text> </Text>
              <Box paddingX={2}>
                <Text>Key: </Text>
                <TextInput value={input.value} cursor={input.cursor} placeholder="ENV_VAR_NAME" />
                <Text dimColor>
                  {' '}
                  ({NVS_KEY_MAX - Buffer.byteLength(input.value, 'utf-8')} remaining)
                </Text>
              </Box>
            </>
          )}

          {/* Add secret prompt */}
          {mode.type === 'add-secret' && (
            <>
              <Text> </Text>
              <Box paddingX={2}>
                <Text>
                  Mark as secret? <Text bold>y</Text>/n
                </Text>
              </Box>
            </>
          )}

          {/* Add value prompt */}
          {mode.type === 'add-value' && (
            <>
              <Text> </Text>
              <Box paddingX={2}>
                <Text>Value for {mode.key}: </Text>
                <TextInput
                  value={input.value}
                  cursor={input.cursor}
                  mask={mode.secret}
                  placeholder={mode.secret ? '(paste secret)' : undefined}
                />
              </Box>
            </>
          )}
        </>
      )}

      {/* Footer */}
      <Text> </Text>
      <Box paddingX={2}>
        {mode.type === 'list' && (
          <Text dimColor>
            <Text bold>a</Text> add{'  '}
            {entries.length > 0 && (
              <>
                <Text bold>e</Text> edit{'  '}
                <Text bold>d</Text> delete{'  '}
              </>
            )}
            <Text bold>q</Text> back
          </Text>
        )}
        {isInputMode && (
          <Text dimColor>
            Enter to confirm{'  '}Esc to cancel
            {(mode.type === 'add-value' && mode.secret) ||
            (mode.type === 'edit-value' && entries[mode.index]?.secret)
              ? '  (paste secret)'
              : ''}
          </Text>
        )}
      </Box>
    </Box>
  )
}

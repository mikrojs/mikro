import {Text} from 'ink'
import React from 'react'

export interface TextInputProps {
  value: string
  cursor: number
  /** Show * for each character instead of the actual value */
  mask?: boolean
  /** Placeholder text shown when value is empty */
  placeholder?: string
  /** Color of the input text */
  color?: string
}

export function TextInput({value, cursor, mask, placeholder, color}: TextInputProps) {
  if (value === '' && placeholder) {
    return (
      <Text dimColor>
        <Text inverse> </Text>
        {placeholder}
      </Text>
    )
  }

  const display = mask ? '*'.repeat(value.length) : value
  const cursorChar =
    cursor >= display.length ? ' ' : display[cursor] === '\n' ? ' ' : display[cursor]

  return (
    <Text color={color}>
      {display.slice(0, cursor)}
      <Text inverse>{cursorChar}</Text>
      {cursor < display.length
        ? (display[cursor] === '\n' ? '\n' : '') + display.slice(cursor + 1)
        : ''}
    </Text>
  )
}

// ── Input state helpers ────────────────────────────────────

export interface InputState {
  value: string
  cursor: number
}

export const EMPTY_INPUT: InputState = {value: '', cursor: 0}

/** Reduce a key event into an InputState. Returns null if the key was not handled. */
export function reduceInput(
  state: InputState,
  ch: string,
  key: {
    backspace?: boolean
    delete?: boolean
    leftArrow?: boolean
    rightArrow?: boolean
    home?: boolean
    end?: boolean
    ctrl?: boolean
    meta?: boolean
  },
): InputState | null {
  if (key.home || (key.ctrl && ch === 'a')) {
    return {...state, cursor: 0}
  }
  if (key.end || (key.ctrl && ch === 'e')) {
    return {...state, cursor: state.value.length}
  }
  if (key.leftArrow) {
    return {...state, cursor: Math.max(0, state.cursor - 1)}
  }
  if (key.rightArrow) {
    return {...state, cursor: Math.min(state.value.length, state.cursor + 1)}
  }
  if (key.backspace && key.meta) {
    let i = state.cursor - 1
    while (i > 0 && /\W/.test(state.value[i - 1]!)) i--
    while (i > 0 && /\w/.test(state.value[i - 1]!)) i--
    const wordStart = Math.max(0, i)
    if (wordStart < state.cursor) {
      return {
        value: state.value.slice(0, wordStart) + state.value.slice(state.cursor),
        cursor: wordStart,
      }
    }
    return state
  }
  if (key.backspace) {
    if (state.cursor > 0) {
      return {
        value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
        cursor: state.cursor - 1,
      }
    }
    return state
  }
  if (key.delete) {
    if (state.cursor < state.value.length) {
      return {
        value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1),
        cursor: state.cursor,
      }
    }
    return state
  }
  if (key.ctrl && ch === 'u') {
    return {value: state.value.slice(state.cursor), cursor: 0}
  }
  if (ch && !key.ctrl && !key.meta) {
    return {
      value: state.value.slice(0, state.cursor) + ch + state.value.slice(state.cursor),
      cursor: state.cursor + ch.length,
    }
  }
  return null
}

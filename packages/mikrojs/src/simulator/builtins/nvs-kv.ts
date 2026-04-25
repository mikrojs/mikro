import type {BuiltinDefinition} from './types.js'

export const nvsKvBuiltin: BuiltinDefinition = {
  source: `
import {encode, decode} from 'native:cbor'

const store = new Map()

export function set(key, value) {
  const result = encode(value)
  if (!result.ok) return result
  store.set(key, result.value)
  return {ok: true}
}

export function get(key) {
  const data = store.get(key)
  if (data === undefined) return undefined
  const result = decode(data)
  return result.ok ? result.value : undefined
}

export function remove(key) {
  return store.delete(key)
}

export function clear() {
  store.clear()
}

export function info() {
  return {entries: store.size, used: store.size, total: 512, free: 512 - store.size}
}
`,
}

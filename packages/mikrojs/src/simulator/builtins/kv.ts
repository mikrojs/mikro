import type {BuiltinDefinition} from './types.js'

export const kvBuiltin: BuiltinDefinition = {
  source: `
import {encode, decode} from 'native:cbor'
import {ok} from 'mikrojs/result'

const store = new Map()

export function set(key, value) {
  const result = encode(value)
  if (!result.ok) return result
  store.set(key, result.value)
  return ok()
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
  let used = 0
  for (const [k, v] of store) {
    used += 1 + k.length + 2 + v.byteLength
  }
  return {used, total: 2036, entries: store.size}
}
`,
}

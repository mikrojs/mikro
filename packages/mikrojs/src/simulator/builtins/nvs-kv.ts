import type {BuiltinDefinition} from './types.js'

// nvs_kv mirrors the firmware NVS contract: values must survive process
// restarts (firmware NVS survives power cycles). The QuickJS-side stub
// keeps an in-memory cache for fast reads, and rehydrates / persists via
// RPC to the Node side, which writes a JSON file alongside the env-config
// `nvs.json`. Values cross the boundary as base64(cbor) blobs so binary
// data round-trips losslessly.
export const nvsKvBuiltin: BuiltinDefinition = {
  source: `
import {encode, decode} from 'native:cbor'
import {call} from 'native:host'
import {ok} from 'mikrojs/result'

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const store = new Map()

// Rehydrate from disk synchronously at module init. host.call on a sync
// Node-side handler returns a JSON string immediately (no Promise bridge).
const initial = call('nvs_kv.list', '{}')
if (typeof initial === 'string') {
  const entries = JSON.parse(initial)
  for (const key of Object.keys(entries)) {
    store.set(key, base64ToBytes(entries[key]))
  }
}

export function set(key, value) {
  const result = encode(value)
  if (!result.ok) return result
  store.set(key, result.value)
  call('nvs_kv.set', JSON.stringify({key, value: bytesToBase64(result.value)}))
  return ok()
}

export function get(key) {
  const data = store.get(key)
  if (data === undefined) return undefined
  const result = decode(data)
  return result.ok ? result.value : undefined
}

export function remove(key) {
  const existed = store.delete(key)
  if (existed) call('nvs_kv.remove', JSON.stringify({key}))
  return existed
}

export function clear() {
  store.clear()
  call('nvs_kv.clear', '{}')
}

export function info() {
  return {entries: store.size, used: store.size, total: 512, free: 512 - store.size}
}
`,
}

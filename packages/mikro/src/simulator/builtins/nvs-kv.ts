import type {BuiltinDefinition} from './types.js'

// nvs_kv mirrors the firmware NVS contract: values must survive process
// restarts (firmware NVS survives power cycles). The QuickJS-side stub
// keeps an in-memory cache for fast reads, and rehydrates / persists via
// RPC to the Node side, which writes a JSON file alongside the env-config
// `nvs.json`. Values cross the boundary as base64(cbor) blobs so binary
// data round-trips losslessly. Two isolated stores mirror the firmware's
// mik.kv (app data) and mik.sys (system) namespaces.
export const nvsKvBuiltin: BuiltinDefinition = {
  source: `
import {encode, decode} from 'native:mikro/cbor'
import {call} from 'native:mikro/host'
import {ok} from 'mikro/result'

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
const sysStore = new Map()

// Rehydrate from disk synchronously at module init. host.call on a sync
// Node-side handler returns a JSON string immediately (no Promise bridge).
function hydrate(map, ns) {
  const initial = call('nvs_kv.list', JSON.stringify({ns}))
  if (typeof initial === 'string') {
    const entries = JSON.parse(initial)
    for (const key of Object.keys(entries)) {
      map.set(key, base64ToBytes(entries[key]))
    }
  }
}
hydrate(store, 'kv')
hydrate(sysStore, 'sys')

function doSet(map, ns, key, value) {
  const result = encode(value)
  if (!result.ok) return result
  map.set(key, result.value)
  call('nvs_kv.set', JSON.stringify({key, value: bytesToBase64(result.value), ns}))
  return ok()
}

function doGet(map, key) {
  const data = map.get(key)
  if (data === undefined) return undefined
  const result = decode(data)
  return result.ok ? result.value : undefined
}

function doRemove(map, ns, key) {
  const existed = map.delete(key)
  if (existed) call('nvs_kv.remove', JSON.stringify({key, ns}))
  return existed
}

function doClear(map, ns) {
  map.clear()
  call('nvs_kv.clear', JSON.stringify({ns}))
  return ok()
}

export function set(key, value) {
  return doSet(store, 'kv', key, value)
}

export function get(key) {
  return doGet(store, key)
}

export function remove(key) {
  return doRemove(store, 'kv', key)
}

export function clear() {
  return doClear(store, 'kv')
}

export function sysSet(key, value) {
  return doSet(sysStore, 'sys', key, value)
}

export function sysGet(key) {
  return doGet(sysStore, key)
}

export function sysRemove(key) {
  return doRemove(sysStore, 'sys', key)
}

export function sysClear() {
  return doClear(sysStore, 'sys')
}

export function info() {
  return {entries: store.size, used: store.size, total: 512, free: 512 - store.size}
}
`,
}

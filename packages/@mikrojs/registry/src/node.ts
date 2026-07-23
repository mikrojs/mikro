import {mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import * as pathlib from 'node:path'

import type {
  BuildRecord,
  ChannelRecord,
  DeviceRecord,
  Registry,
  RegistryStorage,
  TokenRecord,
} from './types.js'
import {channelKey, CLIENT_IP_HEADER} from './util.js'

/** Publish is the only route with a large body; everything else is a small
 *  JSON document. Bodies are buffered before routing, so this is what keeps an
 *  unauthenticated POST from being an out-of-memory button. */
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * File-backed storage: build blobs as `<dir>/builds/<checksum>.tgz`, records
 * in `<dir>/builds.json`, `<dir>/devices.json`, and `<dir>/tokens.json`.
 * Synchronous writes, no locking: one registry process per data dir.
 */
export function fileStorage(dir: string): RegistryStorage {
  const buildsDir = pathlib.join(dir, 'builds')
  mkdirSync(buildsDir, {recursive: true})
  const buildsPath = pathlib.join(dir, 'builds.json')
  const channelsPath = pathlib.join(dir, 'channels.json')
  const devicesPath = pathlib.join(dir, 'devices.json')
  const tokensPath = pathlib.join(dir, 'tokens.json')

  /** Parsed indexes, keyed by path and invalidated by mtime. Every check-in
   *  reads devices.json before it can authenticate the caller, so without this
   *  an anonymous request with a junk credential costs a full parse of the
   *  fleet, synchronously, on the shared event loop. */
  const cache = new Map<string, {mtimeMs: number; index: Record<string, unknown>}>()

  function mtimeOf(path: string): number | undefined {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  }

  /** Keys are untrusted (device ids, token hashes), so the index has no
   *  prototype: `constructor` or `__proto__` must be an ordinary miss, not a
   *  hit on `Object.prototype` or a write that corrupts it. */
  function readIndex<T>(path: string): Record<string, T> {
    const mtimeMs = mtimeOf(path)
    const cached = cache.get(path)
    if (cached !== undefined && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
      return cached.index as Record<string, T>
    }
    const index: Record<string, T> = Object.create(null) as Record<string, T>
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return index
    }
    if (typeof parsed !== 'object' || parsed === null) return index
    for (const key of Object.getOwnPropertyNames(parsed)) {
      // defineProperty, not assignment: a `__proto__` key must land as an own
      // property rather than reaching a setter.
      Object.defineProperty(index, key, {
        value: (parsed as Record<string, T>)[key],
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    if (mtimeMs !== undefined) cache.set(path, {mtimeMs, index})
    return index
  }
  function writeIndex<T>(path: string, index: Record<string, T>): void {
    // Rewritten in full on every check-in, so a kill or a full disk mid-write
    // must not truncate it: devices.json holds every credential hash, and
    // losing it unenrolls the fleet with no way back but physical access.
    const tmp = `${path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n')
      renameSync(tmp, path)
    } catch (err) {
      // Callers mutate the cached index in place, so a write that did not land
      // leaves it ahead of the file: drop it rather than serve what is not
      // stored.
      cache.delete(path)
      throw err
    }
    const mtimeMs = mtimeOf(path)
    if (mtimeMs === undefined) cache.delete(path)
    else cache.set(path, {mtimeMs, index})
  }

  return {
    async putBlob(checksum, data) {
      writeFileSync(pathlib.join(buildsDir, `${checksum}.tgz`), data)
    },
    async getBlob(checksum) {
      try {
        return new Uint8Array(readFileSync(pathlib.join(buildsDir, `${checksum}.tgz`)))
      } catch {
        return undefined
      }
    },
    async getBuild(checksum) {
      return readIndex<BuildRecord>(buildsPath)[checksum]
    },
    async putBuild(record) {
      const index = readIndex<BuildRecord>(buildsPath)
      index[record.checksum] = record
      writeIndex(buildsPath, index)
    },
    async listBuilds() {
      return Object.values(readIndex<BuildRecord>(buildsPath))
    },
    async getChannel(app, channel, bytecodeVersion) {
      return readIndex<ChannelRecord>(channelsPath)[channelKey(app, channel, bytecodeVersion)]
    },
    async putChannel(record) {
      const index = readIndex<ChannelRecord>(channelsPath)
      index[channelKey(record.app, record.channel, record.bytecodeVersion)] = record
      writeIndex(channelsPath, index)
    },
    async getDevice(deviceId) {
      return readIndex<DeviceRecord>(devicesPath)[deviceId]
    },
    async getDeviceByCredentialHash(hash) {
      return Object.values(readIndex<DeviceRecord>(devicesPath)).find(
        (d) => d.credentialHash === hash,
      )
    },
    async putDevice(record) {
      const index = readIndex<DeviceRecord>(devicesPath)
      index[record.deviceId] = record
      writeIndex(devicesPath, index)
    },
    async listDevices() {
      return Object.values(readIndex<DeviceRecord>(devicesPath))
    },
    async getTokenByHash(hash) {
      return readIndex<TokenRecord>(tokensPath)[hash]
    },
    async putToken(record) {
      const index = readIndex<TokenRecord>(tokensPath)
      index[record.tokenHash] = record
      writeIndex(tokensPath, index)
    },
    async deleteToken(hash) {
      // Deleted in place rather than rebuilt: `Object.fromEntries` would hand
      // back an index with an ordinary prototype, and these keys are untrusted.
      const index = readIndex<TokenRecord>(tokensPath)
      Reflect.deleteProperty(index, hash)
      writeIndex(tokensPath, index)
    },
    async listTokens() {
      return Object.values(readIndex<TokenRecord>(tokensPath))
    },
  }
}

/**
 * Serve a registry on node:http. Request bodies are buffered, so
 * `maxBodyBytes` caps them; publish is the only route that needs more than a
 * few kilobytes.
 */
export function serve(
  registry: Registry,
  options: {port: number; hostname?: string; maxBodyBytes?: number},
): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of req) {
        received += (chunk as Buffer).byteLength
        // Enforced while reading, before routing or auth: an oversized body
        // must never be held in full, whoever sent it.
        if (received > maxBodyBytes) {
          res.writeHead(413, {'content-type': 'application/json'})
          res.end(JSON.stringify({error: 'Request body too large'}))
          req.destroy()
          return
        }
        chunks.push(chunk as Buffer)
      }
      const body = Buffer.concat(chunks)

      // Behind a TLS-terminating proxy the socket is plain http, but the
      // origin the registry puts in offer urls has to be the one devices
      // reach: the client rejects a non-https offer url outright.
      const forwardedProto = req.headers['x-forwarded-proto']
      const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
        ?.split(',')[0]
        ?.trim()
      const scheme = proto === 'https' ? 'https' : 'http'
      const url = `${scheme}://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
      // The client's own value for the peer-address header is dropped: it
      // feeds rate limiting, so only the socket may set it.
      const headers = Object.entries(req.headers).flatMap(([name, value]) =>
        name.toLowerCase() === CLIENT_IP_HEADER
          ? []
          : typeof value === 'string'
            ? [[name, value] as [string, string]]
            : (value ?? []).map((v) => [name, v] as [string, string]),
      )
      const remoteAddress = req.socket.remoteAddress
      if (remoteAddress !== undefined) headers.push([CLIENT_IP_HEADER, remoteAddress])

      const request = new Request(url, {
        method: req.method,
        headers,
        body: body.byteLength > 0 ? body : undefined,
      })

      const response = await registry.fetch(request)
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value
      })
      res.writeHead(response.status, responseHeaders)
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      // The message can name filesystem paths; it belongs in the log, not the
      // response.
      // eslint-disable-next-line no-console
      console.error('registry: request failed', err)
      res.writeHead(500, {'content-type': 'application/json'})
      res.end(JSON.stringify({error: 'Internal server error'}))
    }
  })
  server.listen(options.port, options.hostname)
  return server
}

import type {
  BuildRecord,
  ChannelRecord,
  DeviceRecord,
  RegistryStorage,
  TokenRecord,
} from './types.js'
import {channelKey} from './util.js'

/** In-memory storage: everything is lost on restart. For tests and demos. */
export function memoryStorage(): RegistryStorage {
  const blobs = new Map<string, Uint8Array>()
  const builds = new Map<string, BuildRecord>()
  const channels = new Map<string, ChannelRecord>()
  const devices = new Map<string, DeviceRecord>()
  const tokens = new Map<string, TokenRecord>()

  return {
    async putBlob(checksum, data) {
      blobs.set(checksum, data)
    },
    async getBlob(checksum) {
      return blobs.get(checksum)
    },
    async getBuild(checksum) {
      return builds.get(checksum)
    },
    async putBuild(record) {
      builds.set(record.checksum, record)
    },
    async listBuilds() {
      return [...builds.values()]
    },
    async getChannel(app, channel, bytecodeVersion) {
      return channels.get(channelKey(app, channel, bytecodeVersion))
    },
    async putChannel(record) {
      channels.set(channelKey(record.app, record.channel, record.bytecodeVersion), record)
    },
    async getDevice(deviceId) {
      return devices.get(deviceId)
    },
    async getDeviceByCredentialHash(hash) {
      for (const device of devices.values()) {
        if (device.credentialHash === hash) return device
      }
      return undefined
    },
    async putDevice(record) {
      devices.set(record.deviceId, record)
    },
    async listDevices() {
      return [...devices.values()]
    },
    async getTokenByHash(hash) {
      return tokens.get(hash)
    },
    async putToken(record) {
      tokens.set(record.tokenHash, record)
    },
    async deleteToken(hash) {
      tokens.delete(hash)
    },
    async listTokens() {
      return [...tokens.values()]
    },
  }
}

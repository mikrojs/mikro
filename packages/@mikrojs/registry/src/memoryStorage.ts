import type {BuildRecord, DeviceRecord, RegistryStorage, TokenRecord} from './types.js'

/** In-memory storage: everything is lost on restart. For tests and demos. */
export function memoryStorage(): RegistryStorage {
  const blobs = new Map<string, Uint8Array>()
  const builds = new Map<string, BuildRecord>()
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

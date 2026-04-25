import type {Env} from './types.js'

export const env: Env = {
  get(key: string): string | undefined {
    return (import.meta.env as Record<string, string | undefined>)[key]
  },
  has(key: string): boolean {
    return key in import.meta.env
  },
  require(key: string): string {
    const value = (import.meta.env as Record<string, string | undefined>)[key]
    if (value === undefined) {
      throw new TypeError(`Required environment variable "${key}" is not set`)
    }
    return value
  },
}

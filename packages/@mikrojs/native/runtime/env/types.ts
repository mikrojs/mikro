export interface Env {
  /** Get an environment variable, or `undefined` if not set. */
  get(key: string): string | undefined

  /** Check whether an environment variable is set. */
  has(key: string): boolean

  /** Get a required environment variable. Panics if not set. */
  require(key: string): string
}

export declare const env: Env

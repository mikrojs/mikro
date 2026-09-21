/** A package name deployed in more than one directory. */
export interface DuplicatePackage {
  name: string
  /** One entry per directory, sorted by real path. `version` is from its package.json. */
  copies: {path: string; version?: string}[]
}

import type {FormatFn, FormatString} from '../format/types.js'
import type {InspectFn} from '../inspect/types.js'

type ThemeToken =
  | 'annotation'
  | 'boolean'
  | 'comment'
  | 'date'
  | 'error'
  | 'warning'
  | 'function'
  | 'identifier'
  | 'keyword'
  | 'null'
  | 'number'
  | 'other'
  | 'regexp'
  | 'string'
  | 'symbol'
  | 'type'
  | 'undefined'
  | 'bigint'

export type ColorizeFn = (themeToken: ThemeToken, value: string) => string

export interface LogFn {
  (fmt: FormatString, ...args: any[]): void

  (...args: any[]): void
}

export type ConsoleAPI = {
  log: LogFn
  error: LogFn
  info: LogFn
  warn: LogFn
  debug: LogFn
}

export declare function createConsole(config: {
  inspect: InspectFn
  colorize: ColorizeFn
  format: FormatFn
  stdout: {write: (output: string) => void}
}): ConsoleAPI

export declare const log: ConsoleAPI['log']
export declare const info: ConsoleAPI['info']
export declare const warn: ConsoleAPI['warn']
export declare const error: ConsoleAPI['error']

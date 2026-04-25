export interface InspectOptions {
  showHidden?: boolean
  depth?: number
  truncate?: number
  colors?: boolean
}

export type InspectFn = (value: unknown, options?: InspectOptions) => string

export declare const inspect: InspectFn

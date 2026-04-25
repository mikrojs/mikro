export type FormatString = string & {}

export type FormatFn = (fmt: FormatString, ...args: any[]) => string
export declare const format: FormatFn

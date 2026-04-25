import type {Result} from '../result/types.js'

export type CborError =
  | {name: 'EncodeFailed'; message: string}
  | {name: 'DecodeFailed'; message: string}

export declare function encode(value: unknown): Result<Uint8Array, CborError>
export declare function decode(data: Uint8Array): Result<unknown, CborError>

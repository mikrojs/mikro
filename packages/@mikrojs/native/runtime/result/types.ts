export declare class PanicError extends Error {
  constructor(message: string, options?: {cause?: unknown})
}

export interface OkResult<T> {
  readonly ok: true
  readonly value: T
  readonly error?: never
  map<U>(fn: (value: T) => U): OkResult<U>
  mapErr<F>(fn: (error: never) => F): OkResult<T>
  andThen<U, F>(fn: (value: T) => Result<U, F>): Result<U, F>
  match<A, B>(handlers: {ok: (value: T) => A; err: (error: never) => B}): A
  /** Get the value, or return the default if this is an Err. */
  orDefault<D>(defaultValue: D): T | D
  /** Get the value, or panic with the given message if this is an Err. */
  orPanic(message: string): T
}

export interface ErrResult<E> {
  readonly ok: false
  readonly value?: never
  readonly error: E
  map<U>(fn: (value: never) => U): ErrResult<E>
  mapErr<F>(fn: (error: E) => F): ErrResult<F>
  andThen<U, F>(fn: (value: never) => Result<U, F>): ErrResult<E>
  match<A, B>(handlers: {ok: (value: never) => A; err: (error: E) => B}): B
  /** Return the default value since this is an Err. */
  orDefault<D>(defaultValue: D): D
  /** Always panics with the given message since this is an Err. The error is included as cause. */
  orPanic(message: string): never
}

export type Result<T, E> = OkResult<T> | ErrResult<E>

export declare function ok(): OkResult<void>
export declare function ok<T>(value: T): OkResult<T>

export declare function err<E>(error: E): ErrResult<E>

export declare function matchError<E extends {name: string}, R>(
  error: E,
  handlers: {[K in E['name']]: (error: Extract<E, {name: K}>) => R},
): R

/** Raw error shape returned by native mik__result_err(). */
export interface NativeError {
  readonly code: number
  readonly message: string
  readonly errno?: number
}

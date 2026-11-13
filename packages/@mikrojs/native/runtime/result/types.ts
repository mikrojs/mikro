export declare class PanicError extends Error {
  constructor(message?: string, options?: {cause?: unknown})
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
  /** Get the value, or panic if this is an Err. The error is included as cause. */
  orPanic(message?: string): T
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
  /** Always panics since this is an Err. The error is included as cause. */
  orPanic(message?: string): never
}

export type Result<T, E> = OkResult<T> | ErrResult<E>

export declare function ok(): OkResult<void>
export declare function ok<T>(value: T): OkResult<T>

export declare function err<E>(error: E): ErrResult<E>

/**
 * Call a builtin that throws on bad input and return the outcome as a Result:
 * `ok(value)`, or `err(error)` with what it threw. Synchronous.
 *
 * `fn` must be one of `JSON.parse`, `JSON.stringify`, `atob`, `btoa`,
 * `decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent`,
 * `RegExp` or `String.fromCodePoint`. Any other function is a TypeError.
 * If a reviver or replacer throws, the error is an `Error` whose `cause` is
 * what it threw, so a bug in it isn't mistaken for bad input.
 *
 * @example
 * const body = safe(JSON.parse, text)
 * if (!body.ok) return err(new Error('invalid body', {cause: body.error}))
 */
export declare function safe(
  fn: RegExpConstructor,
  pattern: string | RegExp,
  flags?: string,
): Result<RegExp, Error>
export declare function safe<A extends unknown[], R>(
  fn: (...args: A) => R,
  ...args: A
): Result<unknown extends R ? unknown : R, Error>
// After the generic one, so other builtins never match these: inference from an
// overloaded function sees only its last overload, which lacks the callback form
export declare function safe(
  fn: typeof JSON.parse,
  text: string,
  reviver?: (this: any, key: string, value: any) => any,
): Result<unknown, Error>
export declare function safe(
  fn: typeof JSON.stringify,
  value: unknown,
  replacer?: ((this: any, key: string, value: any) => any) | (number | string)[] | null,
  space?: string | number,
): Result<string, Error>

/**
 * Call `fn` and return the outcome as a Result: `ok(value)`, or `err(error)`
 * with what it threw. For code that throws and that {@link safe} doesn't
 * cover, such as a library.
 *
 * Given a promise, or a `fn` that returns one, it returns a promise of a
 * Result that never rejects. Passing the promise directly misses a throw that
 * happens before the promise exists; the callback form catches both.
 *
 * @example
 * const doc = tryCall(() => yaml.parse(text))
 * const body = await tryCall(() => lib.download(url))
 */
export declare function tryCall<T>(promise: Promise<T>): Promise<Result<T, unknown>>
export declare function tryCall<T>(
  fn: () => T,
): 0 extends 1 & T
  ? Result<any, unknown>
  : [T] extends [never]
    ? Result<never, unknown>
    : T extends Promise<infer U>
      ? Promise<Result<U, unknown>>
      : Result<T, unknown>

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

import type {Result} from '../result/types.js'

/* Push-shaped, composable event stream. See observable.md (worktree branch)
 * for the full design. */

export type NextArg<Ok, Err> = [Err] extends [never] ? Ok : Result<Ok, Err>

export type Observer<Ok, Err = never> = [Err] extends [never]
  ? {next?: (value: Ok) => void; complete?: () => void}
  : {next?: (value: Result<Ok, Err>) => void; complete?: () => void}

export type NextFn<Ok, Err = never> = [Err] extends [never]
  ? (value: Ok) => void
  : (value: Result<Ok, Err>) => void

export interface Subscriber<Ok, Err = never> {
  next(value: NextArg<Ok, Err>): void
  complete(): void
  addTeardown(fn: () => void): void
  readonly closed: boolean
}

export type SubscribeCallback<Ok, Err> = (subscriber: Subscriber<Ok, Err>) => void

export interface Subscription {
  unsubscribe(): void
}

export type OperatorFunction<TIn, EIn, TOut, EOut> = (
  source: Observable<TIn, EIn>,
) => Observable<TOut, EOut>

export declare class Observable<Ok, Err = never> {
  constructor(cb: SubscribeCallback<Ok, Err>)
  subscribe(observer?: Observer<Ok, Err> | NextFn<Ok, Err>): Subscription

  pipe(): Observable<Ok, Err>
  pipe<A>(op1: OperatorFunction<Ok, Err, A, Err>): Observable<A, Err>
  pipe<A, B>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
  ): Observable<B, Err>
  pipe<A, B, C>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
  ): Observable<C, Err>
  pipe<A, B, C, D>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
  ): Observable<D, Err>
  pipe<A, B, C, D, E>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
  ): Observable<E, Err>
  pipe<A, B, C, D, E, F>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
    op6: OperatorFunction<E, Err, F, Err>,
  ): Observable<F, Err>

  static from<X, E>(p: Promise<Result<X, E>>): Observable<X, E>
  static from<T>(p: Promise<T>): Observable<T, never>
  static from<T>(it: Iterable<T>): Observable<T, never>
  static from<Ok, Err>(o: Observable<Ok, Err>): Observable<Ok, Err>

  static withEmitters<Ok, Err = never>(): {
    observable: Observable<Ok, Err>
    next: (value: NextArg<Ok, Err>) => void
    complete: () => void
  }
}

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

/* May return a teardown function, registered as if passed to addTeardown() last. */
export type SubscribeCallback<Ok, Err> = (subscriber: Subscriber<Ok, Err>) => void | (() => void)

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
  pipe<A, B, C, D, E, F, G>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
    op6: OperatorFunction<E, Err, F, Err>,
    op7: OperatorFunction<F, Err, G, Err>,
  ): Observable<G, Err>
  pipe<A, B, C, D, E, F, G, H>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
    op6: OperatorFunction<E, Err, F, Err>,
    op7: OperatorFunction<F, Err, G, Err>,
    op8: OperatorFunction<G, Err, H, Err>,
  ): Observable<H, Err>
  pipe<A, B, C, D, E, F, G, H, I>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
    op6: OperatorFunction<E, Err, F, Err>,
    op7: OperatorFunction<F, Err, G, Err>,
    op8: OperatorFunction<G, Err, H, Err>,
    op9: OperatorFunction<H, Err, I, Err>,
  ): Observable<I, Err>
  /* Longer chains still compose; type them by hand from the result. */
  pipe<A, B, C, D, E, F, G, H, I>(
    op1: OperatorFunction<Ok, Err, A, Err>,
    op2: OperatorFunction<A, Err, B, Err>,
    op3: OperatorFunction<B, Err, C, Err>,
    op4: OperatorFunction<C, Err, D, Err>,
    op5: OperatorFunction<D, Err, E, Err>,
    op6: OperatorFunction<E, Err, F, Err>,
    op7: OperatorFunction<F, Err, G, Err>,
    op8: OperatorFunction<G, Err, H, Err>,
    op9: OperatorFunction<H, Err, I, Err>,
    ...ops: Array<OperatorFunction<any, any, any, any>>
  ): Observable<unknown, Err>

  static withEmitters<Ok, Err = never>(): {
    observable: Observable<Ok, Err>
    next: (value: NextArg<Ok, Err>) => void
    complete: () => void
  }
}

/* A state container: values pushed through `next` run through `pipeline`,
 * and the latest result is replayed to each new subscriber. */
export declare function state<In, Out>(
  pipeline: (source: Observable<In>) => Observable<Out>,
): readonly [value: Observable<Out>, set: (value: In) => void, complete: () => void]

/* Resolve with the first value, or undefined if the source completes without one. */
export declare function firstValueFrom<T>(source: Observable<T>): Promise<T | undefined>

/* Emit a promise's value, or an iterable's elements in order, then complete. */
export declare function from<T>(source: Promise<T>): Observable<T>
export declare function from<T>(source: Iterable<T>): Observable<T>

/* Emit the given values, then complete. */
export declare function of<T>(...values: T[]): Observable<T>

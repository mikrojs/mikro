import {from, Observable, of} from 'native:mikro/observable'

import type {Subscription} from './types.js'

export {from, Observable, of}

/* Resolve with the first value, or with undefined if the source completes
 * without one. Unsubscribes as soon as it settles. */
export function firstValueFrom<T>(source: Observable<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    /* Assigned after subscribe returns; a synchronous source settles before that. */
    let sub: Subscription | undefined = undefined
    let settled = false
    const settle = (value: T | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
      sub?.unsubscribe()
    }
    sub = source.subscribe({next: settle, complete: () => settle(undefined)})
    if (settled) sub.unsubscribe()
  })
}

/* withEmitters plus replay of the latest value to each new subscriber. */
function replayLatest<T>() {
  const live = Observable.withEmitters<T>()
  let hasValue = false
  let done = false
  let value: T
  const observable = new Observable<T>((sub) => {
    if (hasValue) sub.next(value)
    if (sub.closed) return
    const upstream = live.observable.subscribe({
      next: (v) => sub.next(v),
      complete: () => sub.complete(),
    })
    sub.addTeardown(() => upstream.unsubscribe())
  })
  return {
    observable,
    next: (v: T) => {
      if (done) return
      hasValue = true
      value = v
      live.next(v)
    },
    complete: () => {
      done = true
      live.complete()
    },
  }
}

/* A state container. Values pushed through `next` run through `pipeline`;
 * the result is what subscribers see, current value first. The pipeline
 * provides the initial value (startWith) and can fold inputs (scan).
 * `complete` stops everything: the pipeline is unsubscribed, merged sources
 * included, and the output completes. */
export function state<In, Out>(
  pipeline: (source: Observable<In>) => Observable<Out>,
): readonly [value: Observable<Out>, set: (value: In) => void, complete: () => void] {
  const input = Observable.withEmitters<In>()
  const output = replayLatest<Out>()
  const run = pipeline(input.observable).subscribe({next: output.next, complete: output.complete})
  /* Writes after the container ends are dropped, as everywhere in the stream
   * protocol: complete() closes the input, and a pipeline that ended on its
   * own has already unsubscribed from it. A runaway source writing into a
   * dead container shows up as a timer or subscription leak, not here. */
  const complete = () => {
    input.complete()
    run.unsubscribe()
    output.complete()
  }
  return [output.observable, input.next, complete]
}

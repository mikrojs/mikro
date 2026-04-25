import {useEffect, useState} from 'react'
import type {Observable} from 'rxjs'
import {tap} from 'rxjs/operators'

export function useObservable<T, U>(observable: Observable<T>, initialValue: U): T | U
export function useObservable<T>(observable: Observable<T>): T | undefined
export function useObservable<T, U>(
  observable: Observable<T>,
  initialValue?: U,
): T | U | undefined {
  const [state, setState] = useState<T | U | undefined>(initialValue)
  useEffect(() => {
    const sub = observable
      .pipe(
        tap({
          error: (err) => {
            setState(() => {
              throw err
            })
          },
          next: (v) => setState(v),
        }),
      )
      .subscribe()

    return () => {
      sub.unsubscribe()
    }
  }, [observable])

  return state
}

import {useMemo} from 'react'
import {
  catchError,
  first,
  map,
  mergeMap,
  type Observable,
  of,
  type OperatorFunction,
  scan,
  share,
  timer,
} from 'rxjs'
import {SerialPort} from 'serialport'

import {useObservable} from '../lib/useObservable.js'

export interface PortInfo {
  path: string
  manufacturer?: string | undefined
  serialNumber?: string | undefined
  pnpId?: string | undefined
  locationId?: string | undefined
  productId?: string | undefined
  vendorId?: string | undefined
}

export type AsyncState<T> =
  | {status: 'loading'}
  | {status: 'success'; value: T}
  | {
      status: 'error'
      error: Error
      value?: T
    }

const INITIAL: {status: 'loading'} = {status: 'loading'}

const devices = timer(0, 1000).pipe(
  mergeMap(() => SerialPort.list()),
  map((devices: PortInfo[]) => devices.filter((port) => port.serialNumber)),
  share(),
)

const devicesOnce = devices.pipe(first())

export function useDevices(listen = false) {
  const observable = useMemo(() => {
    return (listen ? devices : devicesOnce).pipe(withAsyncState())
  }, [listen])
  return useObservable(observable, INITIAL)
}

function withAsyncState<T>(): OperatorFunction<T, AsyncState<T>> {
  return (input: Observable<T>) =>
    input.pipe(
      map((value) => ({status: 'success' as const, value: value})),
      catchError((error: Error) => of({status: 'error' as const, error: error})),
      scan((acc: AsyncState<T>, ev) => {
        return ev.status === 'error' && acc.status === 'success' ? {...ev, value: acc.value} : ev
      }, INITIAL),
    )
}

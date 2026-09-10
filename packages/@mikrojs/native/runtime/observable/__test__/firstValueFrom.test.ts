import {firstValueFrom, Observable, of} from 'mikro/observable'
import {describe, expect, test} from 'vitest'

describe('firstValueFrom', () => {
  test('resolves with the first value', async () => {
    const source = Observable.withEmitters<number>()
    const first = firstValueFrom(source.observable)
    source.next(1)
    source.next(2)
    await expect(first).resolves.toBe(1)
  })

  test('resolves a synchronously emitted value', async () => {
    await expect(firstValueFrom(of('a', 'b'))).resolves.toBe('a')
  })

  test('resolves with undefined when the source completes empty', async () => {
    await expect(firstValueFrom(of())).resolves.toBeUndefined()
  })

  test('releases the source once settled', async () => {
    let released = false
    const source = new Observable<number>((sub) => {
      sub.addTeardown(() => {
        released = true
      })
      sub.next(1)
    })
    await expect(firstValueFrom(source)).resolves.toBe(1)
    expect(released).toBe(true)
  })
})

import {Observable, Subject} from 'rxjs'
import {describe, expect, it, vi} from 'vitest'

import {decodeDeviceName} from '../deviceName.js'
import {createRepl, type KeyInfo} from '../serial/replStateMachine.js'
import type {ReplEvent, ReplSession} from '../session.js'

const NO_KEY: KeyInfo = {
  ctrl: false,
  meta: false,
  shift: false,
  return: false,
  tab: false,
  backspace: false,
  delete: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
  home: false,
  end: false,
}

/** Answers each handshake from a script. Crucially it publishes the ready frame
 *  on `messages$` before answering the caller, exactly as the real session
 *  does — that ordering is what the monotonicity guard has to survive. */
function fakeSession(readies: {nameRev?: number; name?: string}[]) {
  const messages$ = new Subject<ReplEvent>()
  const writes: {key: string; value: string; ns: string}[] = []
  let next = 0
  const session = {
    messages$,
    awaitReady$: () =>
      new Observable((sub) => {
        const ready = readies[Math.min(next++, readies.length - 1)]!
        const event = {type: 'ready', chip: 'esp32s3', id: 'dev-1', ...ready} as ReplEvent
        messages$.next(event)
        sub.next(event)
        sub.complete()
      }),
    kv: {
      set: vi.fn(
        async (key: string, value: string, ns: string) => void writes.push({key, value, ns}),
      ),
    },
  } as unknown as ReplSession
  return {session, writes}
}

describe('rename revision monotonicity', () => {
  it('never writes at or below a revision this session already reached', async () => {
    // Opening handshake reports 5. The re-handshake `/name` performs reports 1 —
    // a write that did not land, or a wiped mik.sys. Adopting it writes rev 2,
    // which a registry holding 6 reads as behind and answers by pushing its own
    // name back: the rename silently loses, which is what the guard exists for.
    const {session, writes} = fakeSession([{nameRev: 5}, {nameRev: 1}])
    const repl = createRepl({session, port: '/dev/x', onEnd: () => {}, loadHistory: () => []})
    // state$ drives the effect loop; nothing runs until something subscribes.
    const sub = repl.state$.subscribe()

    for (const ch of '/name set kitchen') repl.keyInput(ch, NO_KEY)
    repl.keyInput('', {...NO_KEY, return: true})
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0))

    const pair = decodeDeviceName(writes[0]!.value)
    expect(pair.name).toBe('kitchen')
    expect(pair.rev).toBeGreaterThan(5)
    expect(writes[0]!.ns).toBe('sys')
    sub.unsubscribe()
  })
})

import {Subject} from 'rxjs'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {UserError} from '../../lib/errorMessage.js'
import type {ReplEvent} from '../../lib/session.js'
import {run} from '../logs.js'

const {openSession} = vi.hoisted(() => ({openSession: vi.fn()}))
vi.mock('../../lib/serial/openSession.js', () => ({openSession}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mikro logs tail', () => {
  it('rejects with a UserError carrying the cause when the device disconnects', async () => {
    // The tail registers exit and signal handlers; keep them off the test process.
    vi.spyOn(process, 'on').mockReturnValue(process)
    const messages$ = new Subject<ReplEvent>()
    openSession.mockResolvedValue({session: {messages$, restart: vi.fn()}, close: vi.fn()})

    const tail = run({
      action: 'logs',
      sub: {subcommand: 'tail', port: undefined, restart: undefined, logLevel: undefined},
    }).catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 0))
    messages$.next({type: 'disconnect', error: 'Device not configured'})
    const error = await tail

    expect(error).toBeInstanceOf(UserError)
    expect((error as Error).message).toBe('The device disconnected during logs tail')
    expect((error as Error).cause).toBe('Device not configured')
  })
})

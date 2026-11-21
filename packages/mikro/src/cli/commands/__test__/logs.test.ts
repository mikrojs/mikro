import {Subject} from 'rxjs'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {DeviceNotFoundError} from '../../lib/deploy.js'
import {UserError} from '../../lib/errorMessage.js'
import type {ReplEvent} from '../../lib/session.js'
import {PortOpenError} from '../../lib/transport.js'
import {run} from '../logs.js'

const {openSession} = vi.hoisted(() => ({openSession: vi.fn()}))
vi.mock('../../lib/serial/openSession.js', () => ({openSession}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const PATH = '/dev/ttyTest'
const SERIAL = 'AABBCCDDEEFF'
const noDevices = () => new DeviceNotFoundError('No serial devices found', [])

function fakeSession() {
  const messages$ = new Subject<ReplEvent>()
  const handles = {
    session: {messages$, restart: vi.fn()},
    devicePath: PATH,
    serialNumber: SERIAL,
    close: vi.fn(),
  }
  return {messages$, handles}
}

/** Starts a tail. The test ends it with an error a wait cannot fix. */
function tail(sub: {port?: string; restart?: true} = {}) {
  // The tail registers exit and signal handlers; keep them off the test process.
  vi.spyOn(process, 'on').mockReturnValue(process)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const done = run({
    action: 'logs',
    sub: {subcommand: 'tail', port: sub.port, restart: sub.restart, logLevel: undefined},
  }).catch((err: unknown) => err)
  return {done, stdout, stderr}
}

describe('mikro logs tail', () => {
  it('waits for the device, and for it to return after a disconnect', async () => {
    const first = fakeSession()
    const second = fakeSession()
    const busy = new UserError(`${PATH} is in use by another program`)
    openSession
      .mockReset()
      .mockRejectedValueOnce(noDevices())
      .mockResolvedValueOnce(first.handles)
      .mockRejectedValueOnce(noDevices())
      .mockResolvedValueOnce(second.handles)
      .mockRejectedValueOnce(busy)

    const {done, stdout, stderr} = tail({restart: true})

    await vi.waitFor(() => expect(first.messages$.observed).toBe(true))
    first.messages$.next({type: 'log', text: 'awake'})
    first.messages$.next({type: 'disconnect'})

    await vi.waitFor(() => expect(second.messages$.observed).toBe(true))
    second.messages$.next({type: 'log', text: 'awake again'})
    second.messages$.next({type: 'disconnect'})

    expect(await done).toBe(busy)
    expect(stdout.mock.calls).toEqual([['awake\n'], ['awake again\n']])
    expect(stderr.mock.calls[0]).toEqual(['Waiting for a device…\n'])
    expect(stderr.mock.calls[1]).toEqual([
      expect.stringMatching(/^Connected to .* on \/dev\/ttyTest\n$/),
    ])
    expect(first.handles.close).toHaveBeenCalled()
    // --restart applies to the first connection only.
    expect(first.handles.session.restart).toHaveBeenCalledTimes(1)
    expect(second.handles.session.restart).not.toHaveBeenCalled()
  })

  it('stays on the first device by its serial number', async () => {
    const session = fakeSession()
    const ambiguous = new UserError('Multiple devices found')
    openSession.mockReset().mockResolvedValueOnce(session.handles).mockRejectedValueOnce(ambiguous)

    const {done, stderr} = tail()

    await vi.waitFor(() => expect(session.messages$.observed).toBe(true))
    session.messages$.next({type: 'disconnect'})

    expect(await done).toBe(ambiguous)
    expect(openSession.mock.calls.map(([options]) => options.port)).toEqual([undefined, SERIAL])
    // A device that was there from the start is not announced.
    expect(stderr).not.toHaveBeenCalled()
  })

  it('names the device it waits for and reports another device once', async () => {
    const other = {path: '/dev/ttyOther', serialNumber: '112233445566'}
    const notFound = () => new DeviceNotFoundError('Device not found: kitchen-sensr', [other])
    const busy = new UserError(`${PATH} is in use by another program`)
    openSession
      .mockReset()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(busy)

    const {done, stderr} = tail({port: 'kitchen-sensr'})

    expect(await done).toBe(busy)
    expect(stderr.mock.calls).toEqual([
      ['Waiting for kitchen-sensr…\n'],
      [expect.stringMatching(/^Found another device: .* on \/dev\/ttyOther\n$/)],
    ])
  })

  it('retries a port that is listed but does not open yet, without a status line', async () => {
    const session = fakeSession()
    const busy = new UserError(`${PATH} is in use by another program`)
    openSession
      .mockReset()
      .mockRejectedValueOnce(new PortOpenError(`Could not open ${PATH}`))
      .mockResolvedValueOnce(session.handles)
      .mockRejectedValueOnce(busy)

    const {done, stderr} = tail()

    await vi.waitFor(() => expect(session.messages$.observed).toBe(true))
    session.messages$.next({type: 'disconnect'})

    expect(await done).toBe(busy)
    expect(stderr).not.toHaveBeenCalled()
  })

  it('says that it waits when the port fails to open and the device then leaves', async () => {
    const busy = new UserError(`${PATH} is in use by another program`)
    openSession
      .mockReset()
      .mockRejectedValueOnce(new PortOpenError(`Could not open ${PATH}`))
      .mockRejectedValueOnce(noDevices())
      .mockRejectedValueOnce(busy)

    const {done, stderr} = tail()

    expect(await done).toBe(busy)
    expect(stderr.mock.calls).toEqual([['Waiting for a device…\n']])
  })

  // The wait reads the clock for its limits. Only the clock is faked: the scan
  // interval stays real, so each test waits for the next scan.
  function advanceClock(ms: number) {
    vi.setSystemTime(Date.now() + ms)
  }

  async function nextScan() {
    const scans = openSession.mock.calls.length
    await vi.waitFor(() => expect(openSession.mock.calls.length).toBeGreaterThan(scans))
  }

  it('gives up on a port that stays listed and does not open', async () => {
    vi.useFakeTimers({toFake: ['Date']})
    const wontOpen = new PortOpenError(`Could not open ${PATH}`)
    openSession.mockReset().mockRejectedValue(wontOpen)

    const {done} = tail()
    await nextScan()
    advanceClock(2500)

    expect(await done).toBe(wontOpen)
  })

  it('links to troubleshooting once when no device connects for a while', async () => {
    vi.useFakeTimers({toFake: ['Date']})
    openSession.mockReset().mockImplementation(async () => {
      throw noDevices()
    })

    const {done, stderr} = tail()
    advanceClock(9000)
    await nextScan()
    expect(stderr.mock.calls).toEqual([['Waiting for a device…\n']])

    advanceClock(1000)
    await nextScan()
    advanceClock(20_000)
    await nextScan()

    const busy = new UserError(`${PATH} is in use by another program`)
    openSession.mockRejectedValue(busy)
    expect(await done).toBe(busy)
    expect(stderr.mock.calls.slice(1)).toEqual([
      ['Still waiting for a device. See https://mikrojs.dev/troubleshooting for help.\n'],
    ])
  })

  it('does not link to troubleshooting for a device that has connected before', async () => {
    vi.useFakeTimers({toFake: ['Date']})
    const session = fakeSession()
    openSession
      .mockReset()
      .mockResolvedValueOnce(session.handles)
      .mockImplementation(async () => {
        throw noDevices()
      })

    const {done, stderr} = tail()
    await vi.waitFor(() => expect(session.messages$.observed).toBe(true))
    session.messages$.next({type: 'disconnect'})
    await nextScan()
    advanceClock(30_000)
    await nextScan()

    const busy = new UserError(`${PATH} is in use by another program`)
    openSession.mockRejectedValue(busy)
    expect(await done).toBe(busy)
    expect(stderr.mock.calls).toEqual([[expect.stringMatching(/^Waiting for /)]])
  })

  it('reports the error a disconnect carries', async () => {
    const session = fakeSession()
    const busy = new UserError(`${PATH} is in use by another program`)
    openSession.mockReset().mockResolvedValueOnce(session.handles).mockRejectedValueOnce(busy)

    const {done, stderr} = tail()

    await vi.waitFor(() => expect(session.messages$.observed).toBe(true))
    session.messages$.next({type: 'disconnect', error: 'Device not configured'})

    expect(await done).toBe(busy)
    expect(stderr.mock.calls).toEqual([['The device disconnected: Device not configured\n']])
  })
})

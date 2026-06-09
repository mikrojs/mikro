import {Subject} from 'rxjs'
import {SerialPort} from 'serialport'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  createSupervisedSession,
  type SupervisedSessionOptions,
} from '../serial/supervisedSession.js'
import {connectRepl, type ReadyEvent, type ReplEvent, type ReplSession} from '../session.js'

// `SerialPort.list` is the only thing the reconnect loop relies on to find
// where the device went, so it's the seam we control. The instance just
// needs to open/close.
const {listMock} = vi.hoisted(() => ({listMock: vi.fn()}))

vi.mock('serialport', () => {
  class SerialPort {
    path: string
    isOpen = true
    constructor(opts: {path: string}) {
      this.path = opts.path
    }
    open(cb: (err?: Error | null) => void) {
      this.isOpen = true
      queueMicrotask(() => cb(null))
    }
    close() {
      this.isOpen = false
    }
    static list = listMock
  }
  return {SerialPort}
})

// The transport is irrelevant here; pass the serial straight through so the
// fake session can read which path it ended up on.
vi.mock('../transport.js', () => ({createSerialTransport: (serial: unknown) => serial}))

// connectRepl is replaced per-test so we can hand back controllable sessions.
vi.mock('../session.js', () => ({connectRepl: vi.fn()}))

const BAUD = 115200
const PATH_A = '/dev/tty.usbmodem1101'
const PATH_B = '/dev/tty.usbmodem101'
const SERIAL_ABC = 'AABBCCDDEEFF'
const SERIAL_XYZ = '112233445566'

interface FakeSession extends ReplSession {
  messages$: Subject<ReplEvent>
  path: string | undefined
}

const createdSessions: FakeSession[] = []

function makeFakeSession(transport: unknown): FakeSession {
  const messages$ = new Subject<ReplEvent>()
  const session = {
    path: (transport as {path?: string} | undefined)?.path,
    messages$,
    ready$: new Subject<ReadyEvent>(),
    awaitReady$: () => new Subject<ReadyEvent>(),
    eval() {},
    directive() {},
    complete() {},
    exit() {},
    deploy: () => new Subject(),
    eraseApp: async () => {},
    fsGet: async () => Buffer.alloc(0),
    logsReset: async () => {},
    restart() {},
    config: {list: async () => [], set: async () => {}, delete: async () => {}},
    close: vi.fn(),
  } as unknown as FakeSession
  createdSessions.push(session)
  return session
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sessionAt(i: number): FakeSession {
  const s = createdSessions[i]
  if (!s) throw new Error(`no session created at index ${i}`)
  return s
}

function connect(opts?: Partial<SupervisedSessionOptions>) {
  const initial = new SerialPort({
    path: PATH_A,
    baudRate: BAUD,
    autoOpen: false,
  }) as unknown as SerialPort
  const session = createSupervisedSession(initial, {
    devicePath: PATH_A,
    serialNumber: SERIAL_ABC,
    baudRate: BAUD,
    ...opts,
  })
  const events: ReplEvent[] = []
  session.messages$.subscribe((e) => events.push(e))
  return {session, events}
}

const types = (events: ReplEvent[]) => events.map((e) => e.type)

describe('createSupervisedSession reconnect', () => {
  beforeEach(() => {
    createdSessions.length = 0
    listMock.mockReset()
    vi.mocked(connectRepl).mockImplementation((t) => makeFakeSession(t))
  })

  it('reconnects when the device reappears on the same port', async () => {
    listMock.mockResolvedValue([{path: PATH_A, serialNumber: SERIAL_ABC}])
    const {session, events} = connect()

    sessionAt(0).messages$.next({type: 'disconnect'})

    await vi.waitFor(() => expect(types(events)).toContain('reconnected'))
    expect(types(events)).toEqual(['reconnecting', 'reconnected'])
    expect(createdSessions).toHaveLength(2)
    expect(sessionAt(1).path).toBe(PATH_A)
    session.close()
  })

  it('follows the device to a new port and ignores a different device on the old path', async () => {
    listMock
      // a stranger took the old path...
      .mockResolvedValueOnce([{path: PATH_A, serialNumber: SERIAL_XYZ}])
      // ...meanwhile our device re-enumerated onto a different path
      .mockResolvedValue([{path: PATH_B, serialNumber: SERIAL_ABC}])
    const {session, events} = connect()

    sessionAt(0).messages$.next({type: 'disconnect'})

    await vi.waitFor(() => expect(types(events)).toContain('reconnected'))
    expect(createdSessions).toHaveLength(2)
    expect(sessionAt(1).path).toBe(PATH_B)
    session.close()
  })

  it('keeps waiting (does nothing) while only a different device is present', async () => {
    listMock.mockResolvedValue([{path: PATH_A, serialNumber: SERIAL_XYZ}])
    const {session, events} = connect()

    sessionAt(0).messages$.next({type: 'disconnect'})
    await delay(300) // several 100ms poll cycles

    expect(types(events)).toEqual(['reconnecting'])
    expect(createdSessions).toHaveLength(1) // no inner adopted
    session.close()
    await delay(150) // let the aborted poll iteration unwind
  })

  it('falls back to the original path when the device has no USB serial', async () => {
    listMock.mockResolvedValue([{path: PATH_A, serialNumber: undefined}])
    const {session, events} = connect({serialNumber: undefined})

    sessionAt(0).messages$.next({type: 'disconnect'})

    await vi.waitFor(() => expect(types(events)).toContain('reconnected'))
    expect(sessionAt(1).path).toBe(PATH_A)
    session.close()
  })

  it('surfaces a hard transport error without reconnecting', async () => {
    listMock.mockResolvedValue([{path: PATH_A, serialNumber: SERIAL_ABC}])
    const {session, events} = connect()

    sessionAt(0).messages$.next({type: 'disconnect', error: 'write failed'})
    await delay(50)

    expect(events).toEqual([{type: 'disconnect', error: 'write failed'}])
    expect(listMock).not.toHaveBeenCalled()
    expect(createdSessions).toHaveLength(1)
    session.close()
  })
})

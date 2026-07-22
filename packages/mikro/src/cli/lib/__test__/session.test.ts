import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {encode as encodeCbor} from 'cbor2'
import pkg from 'mikro/package.json' with {type: 'json'}
import {firstValueFrom, lastValueFrom, Subject} from 'rxjs'
import {inc} from 'semver'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {FirmwareIncompatibleError} from '../firmwareCompat.js'
import {
  buildFrame,
  CMD_DEPLOY_ABORT,
  CMD_DEPLOY_BUILD,
  CMD_DEPLOY_CHECKSUM,
  CMD_DEPLOY_PUT,
  CMD_DEPLOY_PUT_CHUNK,
  CMD_DIRECTIVE,
  CMD_EVAL,
  CMD_EXIT,
  CMD_RESTART,
  CMD_RUNTIME_PAUSE,
  CMD_RUNTIME_RESUME,
  HEADER_SIZE,
  MSG_CHECKSUM_RESULT,
  MSG_CONFIG_ENTRIES,
  MSG_ERR,
  MSG_LOG,
  MSG_OK,
  MSG_READY,
} from '../protocol.js'
import {
  connectRepl as connectReplImpl,
  type ConnectReplOptions,
  type ReplEvent,
  type ReplSession,
} from '../session.js'
import type {Transport} from '../transport.js'

// Track every session opened by a test so we can close any that the test
// itself didn't get to (e.g. on assertion failure or vitest test-timeout).
// Without this an abandoned awaitReady$ inside session.deploy() can fire its
// 10s timeout after the test process has moved on, surfacing as an uncaught
// DeviceTimeoutError that kills the run.
const openSessions = new Set<ReplSession>()

function connectRepl(transport: Transport, options?: ConnectReplOptions): ReplSession {
  const session = connectReplImpl(transport, options)
  openSessions.add(session)
  return session
}

afterEach(() => {
  for (const session of openSessions) session.close()
  openSessions.clear()
  vi.restoreAllMocks()
})

const CLI_VERSION = pkg.version

/** Create a mock transport for testing */
function createMockTransport() {
  const written: Uint8Array[] = []
  const dataSubject = new Subject<Uint8Array>()

  const transport: Transport = {
    write(data: Uint8Array): Promise<void> {
      written.push(new Uint8Array(data))
      return Promise.resolve()
    },
    data: dataSubject.asObservable(),
    close() {
      dataSubject.complete()
    },
  }

  function send(data: Buffer | Uint8Array) {
    dataSubject.next(new Uint8Array(data))
  }

  return {
    transport,
    written,
    send,
    sendFrame(type: number, payload: string | Buffer = Buffer.alloc(0)) {
      send(buildFrame(type, payload))
    },
    complete() {
      dataSubject.complete()
    },
  }
}

/** Parse the type byte from a written frame */
function parseWrittenType(data: Uint8Array): number {
  return data[0]!
}

/** Parse the payload from a written frame */
function parseWrittenPayload(data: Uint8Array): string {
  const len = data[1]! | (data[2]! << 8) | (data[3]! << 16) | (data[4]! << 24)
  return Buffer.from(data.subarray(HEADER_SIZE, HEADER_SIZE + len)).toString('utf-8')
}

describe('session', () => {
  describe('connectRepl', () => {
    it('emits ready event from MSG_READY', () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      const events: ReplEvent[] = []

      session.messages$.subscribe((e) => events.push(e))
      sendFrame(
        MSG_READY,
        Buffer.from(encodeCbor({chip: 'esp32c6', id: 'aa:bb:cc:dd:ee:ff', v: '0.1.0'})),
      )

      expect(events.length).to.equal(1)
      expect(events[0]!.type).to.equal('ready')
      if (events[0]!.type === 'ready') {
        expect(events[0]!.chip).to.equal('esp32c6')
        expect(events[0]!.id).to.equal('aa:bb:cc:dd:ee:ff')
        expect(events[0]!.version).to.equal('0.1.0')
      }

      session.close()
    })

    it('emits ready event with version null for old firmware', () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      const events: ReplEvent[] = []

      session.messages$.subscribe((e) => events.push(e))
      sendFrame(MSG_READY, Buffer.from(encodeCbor({chip: 'esp32c6', id: 'aa:bb:cc:dd:ee:ff'})))

      expect(events.length).to.equal(1)
      if (events[0]!.type === 'ready') {
        expect(events[0]!.version).to.be.null
      }

      session.close()
    })

    it('emits log/warn/error events', () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      const events: ReplEvent[] = []

      session.messages$.subscribe((e) => events.push(e))
      sendFrame(MSG_LOG, 'hello')

      expect(events.length).to.equal(1)
      expect(events[0]).to.deep.equal({type: 'log', text: 'hello'})

      session.close()
    })

    it('emits raw events for non-TLV bytes', () => {
      const {transport, send} = createMockTransport()
      const session = connectRepl(transport)
      const events: ReplEvent[] = []

      session.messages$.subscribe((e) => events.push(e))
      // Send raw boot text followed by a valid frame
      const raw = Buffer.from('boot: mikrojs v1.0\n')
      const frame = buildFrame(MSG_READY, Buffer.from(encodeCbor({})))
      send(Buffer.concat([raw, frame]))

      // Should get raw event then ready event
      const rawEvents = events.filter((e) => e.type === 'raw')
      const readyEvents = events.filter((e) => e.type === 'ready')
      expect(rawEvents.length).to.be.greaterThanOrEqual(1)
      expect(readyEvents.length).to.equal(1)

      session.close()
    })

    it('emits disconnect on transport complete', () => {
      const {transport, complete} = createMockTransport()
      const session = connectRepl(transport)
      const events: ReplEvent[] = []

      session.messages$.subscribe((e) => events.push(e))
      complete()

      expect(events.some((e) => e.type === 'disconnect')).to.be.true
    })
  })

  describe('REPL commands', () => {
    it('eval sends CMD_EVAL frame', () => {
      const {transport, written} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      session.eval('1+1')

      expect(written.length).to.equal(1)
      expect(parseWrittenType(written[0]!)).to.equal(CMD_EVAL)
      expect(parseWrittenPayload(written[0]!)).to.equal('1+1')

      session.close()
    })

    it('directive sends CMD_DIRECTIVE frame', () => {
      const {transport, written} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      session.directive('.mem')

      expect(parseWrittenType(written[0]!)).to.equal(CMD_DIRECTIVE)
      expect(parseWrittenPayload(written[0]!)).to.equal('.mem')

      session.close()
    })

    it('exit sends CMD_EXIT frame', () => {
      const {transport, written} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      session.exit()

      expect(parseWrittenType(written[0]!)).to.equal(CMD_EXIT)
      session.close()
    })

    it('restart sends CMD_RESTART frame', () => {
      const {transport, written} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      session.restart()

      expect(parseWrittenType(written[0]!)).to.equal(CMD_RESTART)
      session.close()
    })
  })

  describe('request/response', () => {
    /** Send MSG_READY so session.ready resolves (required before deploy/config).
     *  Uses the CLI's own version so the firmware-compat check passes. */
    function sendReady(sendFrame: (type: number, payload?: string | Buffer) => void) {
      sendFrame(
        MSG_READY,
        Buffer.from(encodeCbor({chip: 'test', id: '00:00:00:00:00:00', v: CLI_VERSION})),
      )
    }

    it('deploy resolves on MSG_OK', async () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)

      // Auto-respond to each command with MSG_OK.
      // Deploy with one file + restart:false sends:
      //   PAUSE, PUT-begin /app/main.js, PUT_CHUNK,
      //   PUT-begin /app/.checksums, PUT_CHUNK,
      //   DONE, RESUME
      let okCount = 0
      const autoRespond = setInterval(() => {
        if (okCount < 7) {
          sendFrame(MSG_OK)
          okCount++
        }
      }, 5)

      const last = await lastValueFrom(
        session.deploy({
          files: [{path: '/app/main.js', data: Buffer.from('hi')}],
          force: true,
          restart: false,
        }),
      )

      clearInterval(autoRespond)
      expect(last.type).to.equal('complete')
      if (last.type === 'complete') {
        expect(last.deployed).to.be.true
        expect(last.stats.put).to.equal(1)
      }

      session.close()
    })

    it('no-op deploy with restart:true resumes the runtime', async () => {
      // Regression: a pre-deploy PAUSE + no-changes + restart:true would
      // leave the device paused (no RESTART issued, finally skipped RESUME
      // because it checked shouldRestart instead of actual-restart).
      const {transport, written, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)

      // Respond per frame type: PAUSE/ABORT/RESUME → OK, CHECKSUM → match=1.
      let lastSeen = 0
      const autoRespond = setInterval(() => {
        while (lastSeen < written.length) {
          const type = parseWrittenType(written[lastSeen]!)
          if (type === CMD_DEPLOY_CHECKSUM) {
            sendFrame(MSG_CHECKSUM_RESULT, Buffer.from([1]))
          } else if (type === CMD_RESTART) {
            // fire-and-forget on device; nothing to send back
          } else {
            sendFrame(MSG_OK)
          }
          lastSeen++
        }
      }, 5)

      const last = await lastValueFrom(
        session.deploy({
          files: [{path: '/app/main.js', data: Buffer.from('hi')}],
          restart: true,
        }),
      )

      clearInterval(autoRespond)
      expect(last.type).to.equal('complete')
      if (last.type === 'complete') {
        expect(last.deployed).to.be.false
      }

      const types = written.map(parseWrittenType)
      expect(types).to.deep.equal([
        CMD_RUNTIME_PAUSE,
        CMD_DEPLOY_CHECKSUM,
        CMD_DEPLOY_ABORT,
        CMD_RUNTIME_RESUME,
      ])

      session.close()
    })

    it('deploy with restart:true does not send RESUME', async () => {
      const {transport, written, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)

      let lastSeen = 0
      const autoRespond = setInterval(() => {
        while (lastSeen < written.length) {
          const type = parseWrittenType(written[lastSeen]!)
          if (type !== CMD_RESTART) sendFrame(MSG_OK)
          lastSeen++
        }
      }, 5)

      await lastValueFrom(
        session.deploy({
          files: [{path: '/app/main.js', data: Buffer.from('hi')}],
          force: true,
          restart: true,
        }),
      )

      clearInterval(autoRespond)
      const types = written.map(parseWrittenType)
      expect(types).to.not.include(CMD_RUNTIME_RESUME)
      expect(types[0]).to.equal(CMD_RUNTIME_PAUSE)
      expect(types[types.length - 1]).to.equal(CMD_RESTART)

      session.close()
    })

    it('deploy rejects on MSG_ERR', async () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)

      // Respond to first command with error after a tick
      setTimeout(() => sendFrame(MSG_ERR, 'disk full'), 5)

      await expect(
        lastValueFrom(
          session.deploy({
            files: [{path: '/app/main.js', data: Buffer.from('hi')}],
            force: true,
            restart: false,
          }),
        ),
      ).rejects.toThrow('disk full')

      session.close()
    })

    it('deployBuild streams the tgz then adopts it', async () => {
      const dir = await mkdtemp(pathlib.join(tmpdir(), 'mikro-build-'))
      const tgzPath = pathlib.join(dir, 'app.tgz')
      await writeFile(tgzPath, Buffer.from('fake-tgz-bytes'))

      try {
        const {transport, written, sendFrame} = createMockTransport()
        const session = connectRepl(transport)
        session.messages$.subscribe(() => {})

        sendReady(sendFrame)

        // Reply OK to every command (pause, put-begin, put-chunk, build, resume).
        let lastSeen = 0
        const autoRespond = setInterval(() => {
          while (lastSeen < written.length) {
            if (parseWrittenType(written[lastSeen]!) !== CMD_RESTART) sendFrame(MSG_OK)
            lastSeen++
          }
        }, 5)

        const last = await lastValueFrom(
          session.deployBuild(tgzPath, 'a'.repeat(64), {restart: false}),
        )

        clearInterval(autoRespond)
        expect(last.type).to.equal('complete')
        if (last.type === 'complete') expect(last.deployed).to.be.true

        const types = written.map(parseWrittenType)
        expect(types).to.deep.equal([
          CMD_RUNTIME_PAUSE,
          CMD_DEPLOY_PUT,
          CMD_DEPLOY_PUT_CHUNK,
          CMD_DEPLOY_BUILD,
          CMD_RUNTIME_RESUME,
        ])

        // PUT-begin targets the build staging name; BUILD carries the checksum.
        const putPayload = Buffer.from(written[1]!.subarray(HEADER_SIZE))
        const nameLen = putPayload.readUInt16LE(0)
        expect(putPayload.subarray(2, 2 + nameLen).toString('utf-8')).to.equal('/.build.tgz')
        const buildPayload = Buffer.from(written[3]!.subarray(HEADER_SIZE))
        const chkLen = buildPayload.readUInt16LE(0)
        expect(buildPayload.subarray(2, 2 + chkLen).toString('utf-8')).to.equal('a'.repeat(64))

        session.close()
      } finally {
        await rm(dir, {recursive: true, force: true})
      }
    })

    it('deployBuild with restart:true sends RESTART, not RESUME', async () => {
      const dir = await mkdtemp(pathlib.join(tmpdir(), 'mikro-build-'))
      const tgzPath = pathlib.join(dir, 'app.tgz')
      await writeFile(tgzPath, Buffer.from('fake-tgz-bytes'))

      try {
        const {transport, written, sendFrame} = createMockTransport()
        const session = connectRepl(transport)
        session.messages$.subscribe(() => {})

        sendReady(sendFrame)

        let lastSeen = 0
        const autoRespond = setInterval(() => {
          while (lastSeen < written.length) {
            if (parseWrittenType(written[lastSeen]!) !== CMD_RESTART) sendFrame(MSG_OK)
            lastSeen++
          }
        }, 5)

        await lastValueFrom(session.deployBuild(tgzPath, 'b'.repeat(64), {restart: true}))

        clearInterval(autoRespond)
        const types = written.map(parseWrittenType)
        expect(types).to.not.include(CMD_RUNTIME_RESUME)
        expect(types[types.length - 1]).to.equal(CMD_RESTART)

        session.close()
      } finally {
        await rm(dir, {recursive: true, force: true})
      }
    })

    it('deployBuild rejects on MSG_ERR from adopt', async () => {
      const dir = await mkdtemp(pathlib.join(tmpdir(), 'mikro-build-'))
      const tgzPath = pathlib.join(dir, 'app.tgz')
      await writeFile(tgzPath, Buffer.from('fake-tgz-bytes'))

      try {
        const {transport, written, sendFrame} = createMockTransport()
        const session = connectRepl(transport)
        session.messages$.subscribe(() => {})

        sendReady(sendFrame)

        // OK for pause/put/chunk; ERR for the BUILD adopt; OK for the
        // resume issued by the finally block.
        let lastSeen = 0
        const autoRespond = setInterval(() => {
          while (lastSeen < written.length) {
            const type = parseWrittenType(written[lastSeen]!)
            if (type === CMD_DEPLOY_BUILD) sendFrame(MSG_ERR, 'corrupt build')
            else if (type !== CMD_RESTART) sendFrame(MSG_OK)
            lastSeen++
          }
        }, 5)

        await expect(
          lastValueFrom(session.deployBuild(tgzPath, 'c'.repeat(64), {restart: false})),
        ).rejects.toThrow('corrupt build')

        clearInterval(autoRespond)
        expect(written.map(parseWrittenType)).to.include(CMD_RUNTIME_RESUME)

        session.close()
      } finally {
        await rm(dir, {recursive: true, force: true})
      }
    })

    it('config.list resolves with entries', async () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)

      setTimeout(
        () =>
          sendFrame(
            MSG_CONFIG_ENTRIES,
            Buffer.from(encodeCbor([{key: 'WIFI', value: 'mynet', secret: false}])),
          ),
        5,
      )

      const entries = await session.config.list()
      expect(entries.length).to.equal(1)
      expect(entries[0]!.key).to.equal('WIFI')

      session.close()
    })

    it('config.set resolves on MSG_OK', async () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)
      setTimeout(() => sendFrame(MSG_OK), 5)
      await session.config.set('KEY', 'val', false)

      session.close()
    })

    it('config.delete resolves on MSG_OK', async () => {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport)
      session.messages$.subscribe(() => {})

      sendReady(sendFrame)
      setTimeout(() => sendFrame(MSG_OK), 5)
      await session.config.delete('KEY')

      session.close()
    })
  })

  // Everything downstream — the registry sync rules, the re-seed guard in
  // postFlash, the revision `/name set` writes — reads its input from here, and
  // none of it was exercised against a real MSG_READY carrying a name.
  describe('ready frame name pair', () => {
    function readyWith(name?: string) {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport, {compat: 'report'})
      session.messages$.subscribe(() => {})
      const ready = firstValueFrom(session.awaitReady$(1000))
      const info: Record<string, string> = {chip: 'test', id: '0', v: CLI_VERSION}
      if (name !== undefined) info.name = name
      sendFrame(MSG_READY, Buffer.from(encodeCbor(info)))
      return ready
    }

    it('decodes a name and its revision', async () => {
      const ready = await readyWith('[7,"kitchen"]')
      expect(ready.name).to.equal('kitchen')
      expect(ready.nameRev).to.equal(7)
      expect(ready.nameCorrupt).to.be.undefined
    })

    // Firmware predating name sync sends no name key at all. That is rev 0 and
    // never-named, which is what lets a flash seed one.
    it('treats an absent name field as never named', async () => {
      const ready = await readyWith()
      expect(ready.name).to.be.undefined
      expect(ready.nameRev).to.equal(0)
      expect(ready.nameCorrupt).to.be.undefined
    })

    it('keeps the revision of a cleared name so the clear can propagate', async () => {
      const ready = await readyWith('[4]')
      expect(ready.name).to.be.undefined
      expect(ready.nameRev).to.equal(4)
    })

    it('flags an unreadable pair rather than reporting revision 0', async () => {
      const ready = await readyWith('not json{')
      expect(ready.nameCorrupt).to.equal(true)
    })
  })

  describe('firmware compat policy', () => {
    /** Outside any ^x.y range the CLI can ever be in. */
    const INCOMPATIBLE_VERSION = '0.0.1'
    /** In-range but not equal: next patch of the CLI's own version. */
    const NEWER_IN_RANGE = inc(CLI_VERSION, 'patch')!

    function awaitReadyWith(version: string, compat?: ConnectReplOptions['compat']) {
      const {transport, sendFrame} = createMockTransport()
      const session = connectRepl(transport, compat ? {compat} : undefined)
      session.messages$.subscribe(() => {})
      const ready = firstValueFrom(session.awaitReady$(1000))
      sendFrame(MSG_READY, Buffer.from(encodeCbor({chip: 'test', id: '0', v: version})))
      return ready
    }

    it("'enforce' (default) rejects awaitReady$ on incompatible firmware", async () => {
      await expect(awaitReadyWith(INCOMPATIBLE_VERSION)).rejects.toBeInstanceOf(
        FirmwareIncompatibleError,
      )
    })

    it("'report' resolves silently and attaches the incompatible advisory", async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const ready = await awaitReadyWith(INCOMPATIBLE_VERSION, 'report')

      expect(ready.advisory?.kind).to.equal('incompatible')
      expect(ready.advisory?.message).to.contain('not compatible')
      expect(stderr).not.toHaveBeenCalled()
    })

    it("'report' stays silent on the soft update_available advisory", async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const ready = await awaitReadyWith(NEWER_IN_RANGE, 'report')

      expect(ready.advisory?.kind).to.equal('device_newer')
      expect(stderr).not.toHaveBeenCalled()
    })

    it("'best-effort' warns on stderr once and proceeds on incompatible firmware", async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const ready = await awaitReadyWith(INCOMPATIBLE_VERSION, 'best-effort')

      expect(ready.advisory?.kind).to.equal('incompatible')
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(String(stderr.mock.calls[0]![0])).to.contain('Attempting anyway')
    })
  })
})

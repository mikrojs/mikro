import {encode as encodeCbor} from 'cbor2'
import {describe, expect, it} from 'vitest'

import {
  buildCompleteCommand,
  buildConfigDeleteCommand,
  buildConfigListCommand,
  buildConfigSetCommand,
  buildDeployAbortCommand,
  buildDeployChecksumCommand,
  buildDeployDoneCommand,
  buildDeployEraseCommand,
  buildDeployKeepCommand,
  buildDeployPutChunkCommand,
  buildDeployPutCommand,
  buildDirectiveCommand,
  buildEvalCommand,
  buildExitCommand,
  buildFrame,
  buildRestartCommand,
  CMD_COMPLETE,
  CMD_CONFIG_DELETE,
  CMD_CONFIG_LIST,
  CMD_CONFIG_SET,
  CMD_DEPLOY_ABORT,
  CMD_DEPLOY_CHECKSUM,
  CMD_DEPLOY_DONE,
  CMD_DEPLOY_ERASE,
  CMD_DEPLOY_KEEP,
  CMD_DEPLOY_PUT,
  CMD_DEPLOY_PUT_CHUNK,
  CMD_DIRECTIVE,
  CMD_EVAL,
  CMD_EXIT,
  CMD_RESTART,
  FrameParser,
  frameToMessage,
  HEADER_SIZE,
  isIncomplete,
  MSG_CHECKSUM_RESULT,
  MSG_CONFIG_ENTRIES,
  MSG_ERR,
  MSG_ERROR,
  MSG_EVAL_ERROR,
  MSG_INFO,
  MSG_LOG,
  MSG_OK,
  MSG_PROMPT,
  MSG_READY,
  MSG_RESULT,
  MSG_WARN,
  parseCompletions,
  parseFrame,
} from '../protocol.js'

describe('protocol', () => {
  describe('buildFrame', () => {
    it('builds a frame with string payload', () => {
      const frame = buildFrame(0x01, 'hello')
      expect(frame[0]).to.equal(0x01)
      expect(frame.readUInt32LE(1)).to.equal(5)
      expect(frame.subarray(HEADER_SIZE).toString('utf-8')).to.equal('hello')
    })

    it('builds a frame with Buffer payload', () => {
      const payload = Buffer.from([0xff, 0x00, 0x7f])
      const frame = buildFrame(0x02, payload)
      expect(frame[0]).to.equal(0x02)
      expect(frame.readUInt32LE(1)).to.equal(3)
      expect(Buffer.compare(frame.subarray(HEADER_SIZE), payload)).to.equal(0)
    })

    it('builds a frame with empty payload', () => {
      const frame = buildFrame(0x04)
      expect(frame.length).to.equal(HEADER_SIZE)
      expect(frame[0]).to.equal(0x04)
      expect(frame.readUInt32LE(1)).to.equal(0)
    })

    it('handles UTF-8 payload correctly', () => {
      const text = 'héllo wörld'
      const frame = buildFrame(0x01, text)
      const payloadLen = Buffer.from(text, 'utf-8').length
      expect(frame.readUInt32LE(1)).to.equal(payloadLen)
      expect(frame.subarray(HEADER_SIZE).toString('utf-8')).to.equal(text)
    })
  })

  describe('parseFrame', () => {
    it('parses a valid frame', () => {
      const frame = buildFrame(MSG_RESULT, 'result')
      const result = parseFrame(frame)
      expect(result).not.to.be.null
      expect(result!.frame.type).to.equal(MSG_RESULT)
      expect(result!.frame.payload.toString('utf-8')).to.equal('result')
      expect(result!.bytesConsumed).to.equal(frame.length)
    })

    it('parses a frame with empty payload', () => {
      const frame = buildFrame(MSG_OK)
      const result = parseFrame(frame)
      expect(result).not.to.be.null
      expect(result!.frame.type).to.equal(MSG_OK)
      expect(result!.frame.payload.length).to.equal(0)
      expect(result!.bytesConsumed).to.equal(HEADER_SIZE)
    })

    it('parses a frame at an offset', () => {
      const prefix = Buffer.from([0xaa, 0xbb])
      const frame = buildFrame(MSG_READY, 'test')
      const combined = Buffer.concat([prefix, frame])
      const result = parseFrame(combined, 2)
      expect(result).not.to.be.null
      expect(result!.frame.type).to.equal(MSG_READY)
      expect(result!.frame.payload.toString('utf-8')).to.equal('test')
    })

    it('returns null for empty buffer', () => {
      expect(parseFrame(Buffer.alloc(0))).to.be.null
    })

    it('returns null for incomplete header', () => {
      expect(parseFrame(Buffer.from([0x01, 0x05, 0x00]))).to.be.null
    })

    it('returns null for incomplete payload', () => {
      const buf = Buffer.alloc(7)
      buf[0] = 0x01
      buf.writeUInt32LE(10, 1) // says 10 bytes payload
      buf[5] = 0x61 // only 2 bytes of payload
      buf[6] = 0x62
      expect(parseFrame(buf)).to.be.null
    })
  })

  describe('round-trip', () => {
    it('frame survives build → parse round-trip', () => {
      const payloads = ['hello world', '', '{"key":"value"}', 'line1\nline2\nline3']
      for (const payload of payloads) {
        const frame = buildFrame(MSG_RESULT, payload)
        const result = parseFrame(frame)
        expect(result).not.to.be.null
        expect(result!.frame.payload.toString('utf-8')).to.equal(payload)
        expect(result!.bytesConsumed).to.equal(frame.length)
      }
    })

    it('parses multiple concatenated frames', () => {
      const f1 = buildFrame(MSG_LOG, 'log line')
      const f2 = buildFrame(MSG_RESULT, '42')
      const f3 = buildFrame(MSG_PROMPT, '5.4ms')
      const stream = Buffer.concat([f1, f2, f3])

      let offset = 0
      const r1 = parseFrame(stream, offset)
      expect(r1!.frame.type).to.equal(MSG_LOG)
      offset += r1!.bytesConsumed

      const r2 = parseFrame(stream, offset)
      expect(r2!.frame.type).to.equal(MSG_RESULT)
      offset += r2!.bytesConsumed

      const r3 = parseFrame(stream, offset)
      expect(r3!.frame.type).to.equal(MSG_PROMPT)
    })
  })

  describe('REPL command builders', () => {
    it('buildEvalCommand', () => {
      const frame = buildEvalCommand('1 + 2')
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_EVAL)
      expect(result!.frame.payload.toString('utf-8')).to.equal('1 + 2')
    })

    it('buildCompleteCommand', () => {
      const frame = buildCompleteCommand('console.l')
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_COMPLETE)
      expect(result!.frame.payload.toString('utf-8')).to.equal('console.l')
    })

    it('buildDirectiveCommand', () => {
      const frame = buildDirectiveCommand('.help')
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_DIRECTIVE)
      expect(result!.frame.payload.toString('utf-8')).to.equal('.help')
    })

    it('buildExitCommand', () => {
      const frame = buildExitCommand()
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_EXIT)
      expect(result!.frame.payload.length).to.equal(0)
    })

    it('buildRestartCommand', () => {
      const frame = buildRestartCommand()
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_RESTART)
    })
  })

  describe('deploy command builders', () => {
    it('buildDeployPutCommand encodes name and total size, no body', () => {
      const frame = buildDeployPutCommand('/app/main.js', 17)
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_DEPLOY_PUT)

      const payload = result!.frame.payload
      const nameLen = payload.readUInt16LE(0)
      const name = payload.subarray(2, 2 + nameLen).toString('utf-8')
      const totalSize = payload.readUInt32LE(2 + nameLen)
      expect(name).to.equal('/app/main.js')
      expect(totalSize).to.equal(17)
      expect(payload.length).to.equal(2 + nameLen + 4)
    })

    it('buildDeployPutChunkCommand carries raw body bytes', () => {
      const data = Buffer.from('console.log("hi")')
      const frame = buildDeployPutChunkCommand(data)
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_DEPLOY_PUT_CHUNK)
      expect(result!.frame.payload.equals(data)).to.equal(true)
    })

    it('buildDeployDoneCommand', () => {
      const frame = buildDeployDoneCommand()
      expect(parseFrame(frame)!.frame.type).to.equal(CMD_DEPLOY_DONE)
    })

    it('buildDeployAbortCommand', () => {
      const frame = buildDeployAbortCommand()
      expect(parseFrame(frame)!.frame.type).to.equal(CMD_DEPLOY_ABORT)
    })

    it('buildDeployEraseCommand', () => {
      const frame = buildDeployEraseCommand()
      expect(parseFrame(frame)!.frame.type).to.equal(CMD_DEPLOY_ERASE)
    })

    it('buildDeployKeepCommand', () => {
      const frame = buildDeployKeepCommand('/app/lib.js')
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_DEPLOY_KEEP)
      const payload = result!.frame.payload
      const nameLen = payload.readUInt16LE(0)
      expect(payload.subarray(2, 2 + nameLen).toString('utf-8')).to.equal('/app/lib.js')
    })

    it('buildDeployChecksumCommand', () => {
      const hash = Buffer.alloc(32, 0xab)
      const frame = buildDeployChecksumCommand('/app/main.js', hash)
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_DEPLOY_CHECKSUM)

      const payload = result!.frame.payload
      const nameLen = payload.readUInt16LE(0)
      expect(payload.subarray(2, 2 + nameLen).toString('utf-8')).to.equal('/app/main.js')
      expect(Buffer.compare(payload.subarray(2 + nameLen, 2 + nameLen + 32), hash)).to.equal(0)
    })
  })

  describe('config command builders', () => {
    it('buildConfigListCommand', () => {
      const frame = buildConfigListCommand()
      expect(parseFrame(frame)!.frame.type).to.equal(CMD_CONFIG_LIST)
    })

    it('buildConfigSetCommand', () => {
      const frame = buildConfigSetCommand('WIFI_SSID', 'mynet', false)
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_CONFIG_SET)
      const payload = result!.frame.payload
      expect(payload[0]).to.equal(0x00) // not secret
    })

    it('buildConfigDeleteCommand', () => {
      const frame = buildConfigDeleteCommand('OLD_KEY')
      const result = parseFrame(frame)
      expect(result!.frame.type).to.equal(CMD_CONFIG_DELETE)
      const payload = result!.frame.payload
      const keyLen = payload.readUInt16LE(0)
      expect(payload.subarray(2, 2 + keyLen).toString('utf-8')).to.equal('OLD_KEY')
    })
  })

  describe('frameToMessage', () => {
    it('maps all device message types', () => {
      const types: [number, string][] = [
        [MSG_READY, 'ready'],
        [MSG_LOG, 'log'],
        [MSG_WARN, 'warn'],
        [MSG_ERROR, 'error'],
        [MSG_RESULT, 'result'],
        [MSG_INFO, 'info'],
        [MSG_EVAL_ERROR, 'eval_error'],
        [MSG_PROMPT, 'prompt'],
        [MSG_OK, 'ok'],
        [MSG_ERR, 'err'],
        [MSG_CHECKSUM_RESULT, 'checksum_result'],
        [MSG_CONFIG_ENTRIES, 'config_entries'],
      ]
      for (const [byte, name] of types) {
        const msg = frameToMessage({type: byte, payload: Buffer.from('test')})
        expect(msg, `type 0x${byte.toString(16)}`).not.to.be.null
        expect(msg!.type).to.equal(name)
      }
    })

    it('returns null for unknown type', () => {
      expect(frameToMessage({type: 0xff, payload: Buffer.from('?')})).to.be.null
    })
  })

  describe('parseCompletions', () => {
    it('parses valid CBOR completions', () => {
      const cbor = encodeCbor({prefix: 'console.l', items: ['console.log', 'console.length']})
      const result = parseCompletions(new Uint8Array(cbor))
      expect(result).not.to.be.null
      expect(result!.prefix).to.equal('console.l')
      expect(result!.items).to.deep.equal(['console.log', 'console.length'])
    })

    it('returns null for invalid CBOR', () => {
      expect(parseCompletions(new Uint8Array([0xff, 0xfe]))).to.be.null
    })

    it('returns null for missing prefix', () => {
      const cbor = encodeCbor({items: ['a']})
      expect(parseCompletions(new Uint8Array(cbor))).to.be.null
    })
  })

  describe('FrameParser', () => {
    it('yields complete frames from a single chunk', () => {
      const parser = new FrameParser()
      const f1 = buildFrame(MSG_LOG, 'hello')
      const f2 = buildFrame(MSG_RESULT, '42')
      const data = Buffer.concat([f1, f2])

      const {frames} = parser.feed(data)
      expect(frames.length).to.equal(2)
      expect(frames[0]!.type).to.equal(MSG_LOG)
      expect(frames[0]!.payload.toString('utf-8')).to.equal('hello')
      expect(frames[1]!.type).to.equal(MSG_RESULT)
    })

    it('handles partial frames across multiple chunks', () => {
      const parser = new FrameParser()
      const frame = buildFrame(MSG_LOG, 'hello world')

      const chunk1 = frame.subarray(0, 7)
      const chunk2 = frame.subarray(7)

      expect(parser.feed(chunk1).frames.length).to.equal(0)
      const {frames} = parser.feed(chunk2)
      expect(frames.length).to.equal(1)
      expect(frames[0]!.payload.toString('utf-8')).to.equal('hello world')
    })

    it('handles header split across chunks', () => {
      const parser = new FrameParser()
      const frame = buildFrame(MSG_RESULT, 'ok')

      expect(parser.feed(frame.subarray(0, 3)).frames.length).to.equal(0)
      const {frames} = parser.feed(frame.subarray(3))
      expect(frames.length).to.equal(1)
      expect(frames[0]!.payload.toString('utf-8')).to.equal('ok')
    })

    it('skips unknown type bytes and recovers', () => {
      const parser = new FrameParser()
      const junk = Buffer.from([0xfe, 0xff, 0x00, 0xaa])
      const validFrame = buildFrame(MSG_RESULT, 'recovered')
      const stream = Buffer.concat([junk, validFrame])

      const {frames} = parser.feed(stream)
      expect(frames.length).to.equal(1)
      expect(frames[0]!.type).to.equal(MSG_RESULT)
      expect(frames[0]!.payload.toString('utf-8')).to.equal('recovered')
    })

    it('returns raw bytes for unknown type bytes', () => {
      const parser = new FrameParser()

      const junk = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"
      const validFrame = buildFrame(MSG_READY, '{}')
      const stream = Buffer.concat([junk, validFrame])

      const {frames, raw} = parser.feed(stream)
      expect(frames.length).to.equal(1)
      expect(raw).not.to.be.null
      expect(raw!.toString('utf-8')).to.equal('Hello')
    })

    it('reset clears internal buffer', () => {
      const parser = new FrameParser()
      const frame = buildFrame(MSG_LOG, 'hello')

      parser.feed(frame.subarray(0, 3))
      parser.reset()

      const {frames} = parser.feed(frame.subarray(3))
      expect(frames.length).to.equal(0)
    })

    it('handles empty feed', () => {
      const parser = new FrameParser()
      expect(parser.feed(Buffer.alloc(0)).frames.length).to.equal(0)
    })

    it('resyncs when a banner byte coincides with a valid message type', () => {
      /* The firmware banner `Mikro.js v0.0.0 on esp32c6, 1 core, WiFi/BLE\r\n`
       * ends in 0d 0a. 0x0d happens to equal MSG_MANIFEST_DONE. Without a
       * max-frame-size guard the parser would read `0a 31 38 36` (`\n186`)
       * that follows as a 907 MB little-endian length and stall forever.
       * With the guard, the bogus 0x0d start is rejected as raw and the
       * real frame that follows the banner is parsed correctly. */
      const parser = new FrameParser()
      const banner = Buffer.from('Mikro.js v0.0.0 on esp32c6\r\n186 KB free heap\r\n', 'utf-8')
      const realFrame = buildFrame(0x01, Buffer.from('hello'))
      const stream = Buffer.concat([banner, realFrame])

      const result = parser.feed(stream)
      expect(result.frames.length).to.equal(1)
      expect(result.frames[0]!.type).to.equal(0x01)
      expect(result.frames[0]!.payload.toString('utf-8')).to.equal('hello')
      // The banner bytes should be captured as raw output, not swallowed.
      expect(result.raw?.toString('utf-8')).to.contain('Mikro.js')
    })
  })

  describe('isIncomplete', () => {
    it('complete simple expression', () => expect(isIncomplete('1 + 2')).to.be.false)
    it('incomplete open paren', () => expect(isIncomplete('foo(1, 2')).to.be.true)
    it('incomplete open brace', () => expect(isIncomplete('{ a: 1,')).to.be.true)
    it('complete matched brackets', () => expect(isIncomplete('{ a: 1, b: 2 }')).to.be.false)
    it('incomplete single-quoted string', () => expect(isIncomplete("'hello")).to.be.true)
    it('complete single-quoted string', () => expect(isIncomplete("'hello'")).to.be.false)
    it('incomplete template literal', () => expect(isIncomplete('`hello ${')).to.be.true)
    it('complete template literal', () => expect(isIncomplete('`hello ${name}`')).to.be.false)
    it('incomplete block comment', () => expect(isIncomplete('/* comment')).to.be.true)
    it('complete block comment', () => expect(isIncomplete('/* comment */ 42')).to.be.false)
    it('line comment does not make incomplete', () =>
      expect(isIncomplete('42 // comment')).to.be.false)
    it('empty string is complete', () => expect(isIncomplete('')).to.be.false)
  })
})

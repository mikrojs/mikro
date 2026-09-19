import {firstValueFrom} from 'rxjs'
import type {SerialPort} from 'serialport'
import {describe, expect, it, type MockInstance, vi} from 'vitest'

import {UserError} from '../errorMessage.js'
import {createSerialTransport, openSerial, serialOpenError} from '../transport.js'

const {MockSerialPort, nextOpen} = await vi.hoisted(async () => {
  const {EventEmitter} = await import('node:events')
  /** Set `error` to make the next open() fail with it. */
  const nextOpen: {error?: Error} = {}

  class MockSerialPort extends EventEmitter {
    isOpen = false
    open = vi.fn(function (this: MockSerialPort, cb: (err?: Error) => void) {
      const error = nextOpen.error
      nextOpen.error = undefined
      this.isOpen = error === undefined
      queueMicrotask(() => cb(error))
    })
    close = vi.fn(function (this: MockSerialPort) {
      this.isOpen = false
      this.emit('close')
    })
  }

  return {MockSerialPort, nextOpen}
})

vi.mock('serialport', () => ({SerialPort: MockSerialPort}))

describe('openSerial', () => {
  it('does not close the serial port after the observable completes', async () => {
    const port = await firstValueFrom(openSerial('/dev/ttyTest', 115200))
    expect((port as unknown as {close: MockInstance}).close).not.toHaveBeenCalled()
  })

  it('fails with a UserError naming the port when the open fails', async () => {
    const cause = new Error('Error Resource temporarily unavailable Cannot lock port')
    nextOpen.error = cause

    const error = await firstValueFrom(openSerial('/dev/ttyTest', 115200)).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(UserError)
    expect((error as Error).cause).toBe(cause)
  })

  it('emits an open serial port', async () => {
    const port = await firstValueFrom(openSerial('/dev/ttyTest', 115200))
    expect((port as unknown as {isOpen: boolean}).isOpen).toBe(true)
  })
})

describe('createSerialTransport', () => {
  it('rejects a failed write with context and keeps the serial error as the cause', async () => {
    const drainError = new Error('Device not configured, cannot drain')
    const port = {
      write: vi.fn(),
      drain: (cb: (err?: Error) => void) => cb(drainError),
      on: vi.fn(),
      off: vi.fn(),
    }
    const transport = createSerialTransport(port as unknown as SerialPort)

    const error = await transport.write(new Uint8Array([1, 2, 3])).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(UserError)
    expect((error as Error).message).toBe('Lost the serial connection while writing')
    expect((error as Error).cause).toBe(drainError)
  })
})

describe('serialOpenError', () => {
  it('says the port is in use when another program holds the lock', () => {
    const cause = new Error('Error Resource temporarily unavailable Cannot lock port')
    const error = serialOpenError('/dev/ttyTest', cause)
    expect(error).toBeInstanceOf(UserError)
    expect(error.message).toBe(
      '/dev/ttyTest is in use by another program (close any serial monitor or other mikro command using it)',
    )
    expect(error.cause).toBe(cause)
  })

  it('names the port for any other open failure', () => {
    const cause = new Error('Error: No such file or directory, cannot open /dev/ttyTest')
    const error = serialOpenError('/dev/ttyTest', cause)
    expect(error.message).toBe('Could not open /dev/ttyTest')
    expect(error.cause).toBe(cause)
  })
})

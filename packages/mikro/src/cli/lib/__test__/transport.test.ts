import {firstValueFrom} from 'rxjs'
import {describe, expect, it, type MockInstance, vi} from 'vitest'

import {openSerial} from '../transport.js'

const {MockSerialPort} = vi.hoisted(() => {
  const {EventEmitter} = require('node:events') as typeof import('node:events')

  class MockSerialPort extends EventEmitter {
    isOpen = false
    open = vi.fn(function (this: MockSerialPort, cb: (err?: Error) => void) {
      this.isOpen = true
      queueMicrotask(() => cb())
    })
    close = vi.fn(function (this: MockSerialPort) {
      this.isOpen = false
      this.emit('close')
    })
  }

  return {MockSerialPort}
})

vi.mock('serialport', () => ({SerialPort: MockSerialPort}))

describe('openSerial', () => {
  it('does not close the serial port after the observable completes', async () => {
    const port = await firstValueFrom(openSerial('/dev/ttyTest', 115200))
    expect((port as unknown as {close: MockInstance}).close).not.toHaveBeenCalled()
  })

  it('emits an open serial port', async () => {
    const port = await firstValueFrom(openSerial('/dev/ttyTest', 115200))
    expect((port as unknown as {isOpen: boolean}).isOpen).toBe(true)
  })
})

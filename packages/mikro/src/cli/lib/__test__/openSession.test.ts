import {SerialPortMock} from 'serialport'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {openSession} from '../serial/openSession.js'

// The real stream class over serialport's mock binding, so closing a port
// behaves as it does on a device.
vi.mock('serialport', async (importOriginal) => {
  const serialport = await importOriginal<typeof import('serialport')>()
  return {...serialport, SerialPort: serialport.SerialPortMock}
})

const PATH = '/dev/ttyTest'

afterEach(() => {
  SerialPortMock.binding.reset()
})

describe('openSession', () => {
  it('returns the serial number of the device it opened', async () => {
    SerialPortMock.binding.createPort(PATH, {echo: false, record: false})

    const handles = await openSession({})

    expect(handles.devicePath).toBe(PATH)
    expect(handles.serialNumber).toBeTruthy()
    handles.close()
  })

  it('closes without an error after the port has closed itself', async () => {
    SerialPortMock.binding.createPort(PATH, {echo: false, record: false})
    const handles = await openSession({})
    // What a disconnect does: the stream closes the port on its own.
    await new Promise<void>((resolve) => handles.serial.close(() => resolve()))
    const onError = vi.fn()
    handles.serial.on('error', onError)

    handles.close()
    // serialport reports a close of a closed port on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onError).not.toHaveBeenCalled()
  })
})

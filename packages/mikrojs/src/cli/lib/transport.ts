/**
 * Transport abstraction for the MIK protocol.
 *
 * A transport is a bidirectional byte pipe. The protocol layer (session.ts)
 * builds on top of it. `createSerialTransport` wraps a `serialport` SerialPort
 * instance; other implementations (loopback, WebSocket) can be added for
 * testing or alternative connectivity.
 */

import {Observable} from 'rxjs'
import {SerialPort} from 'serialport'

export interface Transport {
  /** Push data to the device. Returns a promise that resolves once the
   *  bytes have been flushed to the OS — important for tiny writes
   *  (e.g. 5-byte command frames) on macOS, where node-serialport's
   *  internal queue can otherwise hold them indefinitely behind a
   *  USB-CDC packet boundary. */
  write(data: Uint8Array): Promise<void>
  /** Observable stream of incoming bytes from the device */
  data: Observable<Uint8Array>
  /** Tear down the transport */
  close(): void
}

/**
 * Open a serial port as an Observable. Emits the open port, then completes.
 * Closing the port on unsubscribe ensures cleanup if the subscriber cancels.
 */
export function openSerial(path: string, baudRate: number): Observable<SerialPort> {
  return new Observable((observer) => {
    let opened = false
    const serial = new SerialPort({path, baudRate, autoOpen: false})
    serial.open((err) => {
      if (err) {
        observer.error(err)
      } else {
        opened = true
        observer.next(serial)
        observer.complete()
      }
    })
    return () => {
      // Only close if the open was cancelled before completing.
      // Once emitted, the consumer owns the serial port lifecycle.
      if (!opened && serial.isOpen) serial.close()
    }
  })
}

/** Chunk size for serial writes (avoids overflowing device UART FIFO) */
const WRITE_CHUNK_SIZE = 64

/**
 * Create a transport backed by a SerialPort instance.
 * The caller owns the SerialPort lifecycle; `close()` removes listeners
 * but does NOT close the port (the caller may reuse it).
 */
export function createSerialTransport(serialPort: SerialPort): Transport {
  const debugBytes = process.env.MIKRO_DEBUG_SERIAL === '1'
  const data = new Observable<Uint8Array>((observer) => {
    const onData = (chunk: Buffer) => {
      if (debugBytes) {
        // eslint-disable-next-line no-console
        console.error(
          `[serial rx ${chunk.length}B] ${chunk.subarray(0, Math.min(chunk.length, 64)).toString('hex')}${chunk.length > 64 ? '...' : ''}`,
        )
      }
      observer.next(new Uint8Array(chunk))
    }
    const onError = (err: unknown) => {
      if (debugBytes) {
        // eslint-disable-next-line no-console
        console.error(`[serial error] ${String(err)}`)
      }
      observer.error(err)
    }
    const onClose = () => {
      if (debugBytes) {
        // eslint-disable-next-line no-console
        console.error('[serial close]')
      }
      observer.complete()
    }

    serialPort.on('data', onData)
    serialPort.on('error', onError)
    serialPort.on('close', onClose)

    return () => {
      serialPort.off('data', onData)
      serialPort.off('error', onError)
      serialPort.off('close', onClose)
    }
  })

  return {
    write(chunk: Uint8Array): Promise<void> {
      if (debugBytes) {
        // eslint-disable-next-line no-console
        console.error(
          `[serial tx ${chunk.length}B] ${Buffer.from(chunk.subarray(0, Math.min(chunk.length, 64))).toString('hex')}${chunk.length > 64 ? '...' : ''}`,
        )
      }
      // Write in small chunks with drain to avoid overflowing the device FIFO.
      // serialport's write() queues internally, so sequential calls are safe.
      for (let offset = 0; offset < chunk.length; offset += WRITE_CHUNK_SIZE) {
        const slice = chunk.subarray(offset, offset + WRITE_CHUNK_SIZE)
        serialPort.write(Buffer.from(slice))
      }
      return new Promise<void>((resolve, reject) => {
        serialPort.drain((err) => {
          if (err) {
            if (debugBytes) {
              // eslint-disable-next-line no-console
              console.error(`[serial tx drain error] ${String(err)}`)
            }
            reject(err)
          } else {
            if (debugBytes) {
              // eslint-disable-next-line no-console
              console.error(`[serial tx drained ${chunk.length}B]`)
            }
            resolve()
          }
        })
      })
    },

    data,

    close(): void {
      // Remove all our listeners but don't close the port
      serialPort.removeAllListeners('data')
      serialPort.removeAllListeners('error')
      serialPort.removeAllListeners('close')
    },
  }
}

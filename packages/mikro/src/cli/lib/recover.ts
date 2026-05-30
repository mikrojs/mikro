/**
 * Safe-mode recovery for crash-looping devices.
 *
 * Two independent reset paths, run back-to-back so at least one fires:
 *
 *   1. In-band CMD_RESTART frame. If the device is currently in the protocol
 *      loop (responsive, not crash-looping) the firmware handler calls
 *      esp_restart() and we get a clean software reset. Also handles the
 *      common "crash-looping but briefly responsive" case.
 *
 *   2. Hardware RTS/DTR reset matching esptool's HardReset(uses_usb=True).
 *      DTR pinned to false so IO0 stays high and the chip boots normally
 *      instead of entering the ROM bootloader. Covers genuinely stuck devices
 *      where the protocol is not responding at all.
 *
 * After the reset attempts, we flood the firmware's recovery sync sequence
 * ("MIKSAFE\n") so mik__check_recovery() picks it up during its boot window
 * and skips user-app autorun. The firmware's RTC_NOINIT_ATTR double-reset
 * detection makes path 1 + path 2 firing back-to-back safe.
 *
 * Pairs with the firmware-side window in mik_recovery.cpp.
 */

import type {SerialPort} from 'serialport'

import {buildRestartCommand} from './protocol.js'

const SYNC = Buffer.from('MIKSAFE\n')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const setLines = (serial: SerialPort, lines: {dtr: boolean; rts: boolean}) =>
  new Promise<void>((resolve, reject) => {
    serial.set(lines, (err) => (err ? reject(err) : resolve()))
  })

const writeAndDrain = (serial: SerialPort, buf: Buffer) =>
  new Promise<void>((resolve, reject) => {
    serial.write(buf, (err) => {
      if (err) return reject(err)
      serial.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()))
    })
  })

/**
 * Reset the chip and flood sync bytes during the firmware's recovery window.
 *
 * On USB Serial/JTAG chips the reset can briefly disconnect the USB device,
 * so the RTS/DTR writes are wrapped in a retry loop that tolerates transient
 * IOErrors. Matches what esptool does in ResetStrategy.__call__().
 *
 * @param serial - already-open SerialPort
 * @param floodMs - how long to send sync bytes after reset (default 1500ms,
 *   wide enough to cover boot prologue + 500ms recovery window)
 */
const DEBUG = process.env['MIKRO_RECOVER_DEBUG'] === '1'

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[recover] ${msg}\n`)
}

function debugRxListener(serial: SerialPort): () => void {
  if (!DEBUG) return () => {}
  const onData = (chunk: Buffer) => {
    const hex = chunk.toString('hex')
    const ascii = chunk
      .toString('latin1')
      .split('')
      .map((c) => {
        const code = c.charCodeAt(0)
        return code >= 0x20 && code < 0x7f ? c : '.'
      })
      .join('')
    process.stderr.write(`[recover] rx ${chunk.length}B  ${hex}  |${ascii}|\n`)
  }
  serial.on('data', onData)
  return () => {
    serial.off('data', onData)
  }
}

export async function triggerSafeMode(serial: SerialPort, floodMs = 1500): Promise<void> {
  const unwatch = debugRxListener(serial)
  try {
    debug(`start; port=${(serial as unknown as {path: string}).path}`)

    // Path 1: in-band CMD_RESTART. If the device is in the protocol loop
    // the firmware calls esp_restart() immediately. Harmless if ignored.
    try {
      debug('writing CMD_RESTART frame')
      await writeAndDrain(serial, buildRestartCommand())
    } catch (err) {
      debug(`CMD_RESTART write failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Give the firmware a moment to process the restart and start rebooting
    // before we pulse the hardware lines (avoids resetting mid-boot-prologue).
    await sleep(100)

    // Path 2: hardware RTS/DTR reset. Wrapped to tolerate IO errors since
    // USB Serial/JTAG ports can briefly disconnect during reset.
    try {
      debug('hardware RTS/DTR reset')
      await hardReset(serial)
    } catch (err) {
      debug(`hardReset failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Flood for the full duration. The firmware drains stdin after detecting
    // the sync sequence (see mik_recovery.cpp drain_stdin), so the tail of
    // the flood doesn't pollute the protocol RX buffer.
    debug(`flooding sync bytes for ${floodMs}ms`)
    const deadline = Date.now() + floodMs
    let sent = 0
    let failed = 0
    while (Date.now() < deadline) {
      try {
        await writeAndDrain(serial, SYNC)
        sent++
      } catch {
        failed++
      }
      await sleep(50)
    }
    debug(`flood done; sent=${sent} failed=${failed}`)
  } finally {
    unwatch()
  }
}

/**
 * esptool-equivalent of HardReset(uses_usb=True). Retries on IO errors since
 * the USB CDC device can briefly disappear during reset on newer ESP32 chips.
 */
async function hardReset(serial: SerialPort): Promise<void> {
  for (let attempt = 2; attempt >= 0; attempt--) {
    try {
      // Pin DTR=false throughout so IO0 stays high (app boot, not download mode).
      // RTS=true → EN low (chip in reset).
      await setLines(serial, {dtr: false, rts: true})
      await sleep(200)
      // RTS=false → EN high, chip starts booting.
      await setLines(serial, {dtr: false, rts: false})
      await sleep(200)
      return
    } catch (err) {
      if (attempt === 0) throw err
      // Port may have dropped out mid-reset on USB Serial/JTAG. Give it a moment.
      await sleep(500)
    }
  }
}

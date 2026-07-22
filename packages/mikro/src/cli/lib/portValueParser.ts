import {message} from '@optique/core'
import type {ValueParser} from '@optique/core/valueparser'
import {SerialPort} from 'serialport'

import {deviceDisplayName} from './deviceName.js'

/* A ValueParser for the `--port` option that suggests connected serial
 * devices on Tab. Only ports with a serialNumber are surfaced; the rest
 * are virtual/internal ports (Bluetooth, debug UARTs) the user almost
 * never targets. */
export function port(): ValueParser<'async', string> {
  return {
    mode: 'async',
    metavar: 'PORT',
    placeholder: '',
    async parse(input: string) {
      return {success: true, value: input}
    },
    format(value: string) {
      return value
    },
    async *suggest(_prefix: string) {
      // SerialPort.list() can throw on transient USB-subsystem errors or
      // permission failures. Yielding nothing is better than letting the
      // shell session see a stack trace mid-Tab.
      let ports
      try {
        ports = await SerialPort.list()
      } catch {
        return
      }
      for (const p of ports) {
        if (!p.serialNumber) continue
        // Offer the displayed name (alias if set, else the generated name) as a
        // completion — it's exactly what `--port` resolves via matchPortToken.
        const name = deviceDisplayName(p.serialNumber)
        yield {kind: 'literal' as const, text: name, description: message`${p.path}`}
        yield {kind: 'literal' as const, text: p.path, description: message`${name}`}
      }
    },
  }
}

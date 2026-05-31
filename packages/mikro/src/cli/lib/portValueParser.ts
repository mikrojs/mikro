import {message} from '@optique/core'
import type {ValueParser} from '@optique/core/valueparser'
import {SerialPort} from 'serialport'

import {getDeviceAlias} from './deviceAliases.js'

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
        const alias = getDeviceAlias(p.serialNumber)
        // Offer the alias as its own completion so `--port <alias>` is discoverable.
        if (alias) {
          yield {kind: 'literal' as const, text: alias, description: message`${p.path}`}
        }
        yield {
          kind: 'literal' as const,
          text: p.path,
          description: alias
            ? message`${alias}`
            : p.manufacturer
              ? message`${p.manufacturer}`
              : undefined,
        }
      }
    },
  }
}

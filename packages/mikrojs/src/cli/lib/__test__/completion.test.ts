import {suggest} from '@optique/core/parser'
import {describe, expect, it, vi} from 'vitest'

const listMock = vi.hoisted(() =>
  vi.fn(async () => [
    {path: '/dev/tty.usbmodem-fake-1', serialNumber: 'abc123', manufacturer: 'Espressif'},
    {path: '/dev/tty.usbmodem-fake-2', serialNumber: 'def456'},
    {path: '/dev/tty.Bluetooth-Incoming-Port'}, // no serialNumber, must be filtered
  ]),
)

vi.mock('serialport', () => ({SerialPort: {list: listMock}}))

const {argsParser, commands} = await import('../../program.js')

describe('shell completion', () => {
  it('suggests every top-level subcommand', async () => {
    const suggestions = await suggest(argsParser, [''])
    const texts = suggestions.flatMap((s) => (s.kind === 'literal' ? [s.text] : []))
    expect(texts).toEqual(
      expect.arrayContaining([
        'dev',
        'deploy',
        'env',
        'build',
        'flash',
        'console',
        'ls',
        'erase',
        'clean',
        'test',
        'sim',
        'docs',
        'home',
        'logs',
      ]),
    )
  })

  it('suggests connected serial ports for --port, filtering ones without a serialNumber', async () => {
    const suggestions = await suggest(commands.dev.args, ['dev', '--port', ''])
    const texts = suggestions.flatMap((s) => (s.kind === 'literal' ? [s.text] : []))
    expect(texts).toContain('/dev/tty.usbmodem-fake-1')
    expect(texts).toContain('/dev/tty.usbmodem-fake-2')
    expect(texts).not.toContain('/dev/tty.Bluetooth-Incoming-Port')
  })

  it('yields no port suggestions when SerialPort.list rejects', async () => {
    listMock.mockRejectedValueOnce(new Error('USB subsystem unavailable'))
    const suggestions = await suggest(commands.dev.args, ['dev', '--port', ''])
    const portPaths = suggestions
      .flatMap((s) => (s.kind === 'literal' ? [s.text] : []))
      .filter((t) => t.startsWith('/dev/'))
    expect(portPaths).toEqual([])
  })
})

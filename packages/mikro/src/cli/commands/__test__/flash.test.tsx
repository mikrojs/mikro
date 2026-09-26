import {stripVTControlCharacters} from 'node:util'

import {cleanup, render} from 'ink-testing-library'
import {of} from 'rxjs'
import {afterEach, describe, expect, it, vi} from 'vitest'

import type {FlashPlan} from '../../lib/flashFirmware.js'
import Flash from '../flash.js'

const PORT = '/dev/tty.fixture'

const {resolveFlashPlan, openSession} = vi.hoisted(() => ({
  resolveFlashPlan: vi.fn(),
  openSession: vi.fn(),
}))

vi.mock('../../hooks/useDevices.js', () => ({
  useDevices: () => ({status: 'success', value: [{path: '/dev/tty.fixture'}]}),
}))
vi.mock('../../lib/flashFirmware.js', () => ({resolveFlashPlan}))
// The device probe: a device running custom firmware.
vi.mock('../../lib/serial/openSession.js', () => ({openSession}))
function customFirmwareDevice() {
  openSession.mockResolvedValue({
    session: {awaitReady$: () => of({fw: 'my-firmware', chip: 'esp32c6'})},
    close: () => {},
  })
}

// --force skips the device probe, so the flash plan is the only thing the
// prompt can wait for.
function screen() {
  return <Flash args={{port: PORT, force: true} as never} />
}

describe('mikro flash confirmation', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resolveFlashPlan.mockReset()
    openSession.mockReset()
  })

  it('does not ask for a go-ahead while the flash plan is still resolving', async () => {
    resolveFlashPlan.mockReturnValue(new Promise<FlashPlan>(() => {}))

    const {lastFrame} = render(screen())
    await vi.waitFor(() => expect(resolveFlashPlan).toHaveBeenCalled())

    const frame = stripVTControlCharacters(lastFrame() ?? '')
    expect(frame).toContain('Preparing firmware…')
    expect(frame).not.toContain('Continue?')
  })

  it('refuses a plan that fails without having asked first', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    resolveFlashPlan.mockRejectedValue(new Error('esp32s3-generic is an esp32s3 board'))

    const {frames} = render(screen())
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))

    const seen = frames.map((frame) => stripVTControlCharacters(frame))
    expect(seen.at(-1)).toContain('esp32s3-generic is an esp32s3 board')
    expect(seen.some((frame) => frame.includes('Continue?'))).toBe(false)
  })

  it("warns before the go-ahead when a board's image is older than its build", async () => {
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32s3'},
      image: 'board',
      board: {name: 'knob', source: 'flag'},
      warnings: ['the image of knob is older than the last build in /work/knob'],
    } as unknown as FlashPlan)

    const {lastFrame} = render(screen())

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(lastFrame() ?? '')
      expect(frame).toContain('the image of knob is older than the last build')
      expect(frame).toContain('Continue? (y/N)')
    })
  })

  it('asks once the plan has resolved', async () => {
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32c6'},
      image: 'bundled',
      warnings: [],
    } as unknown as FlashPlan)

    const {lastFrame} = render(screen())

    await vi.waitFor(() =>
      expect(stripVTControlCharacters(lastFrame() ?? '')).toContain('Continue? (y/N)'),
    )
  })

  it('refuses the bundled image over custom firmware without --force', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    customFirmwareDevice()
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32c6'},
      image: 'bundled',
      warnings: [],
    } as unknown as FlashPlan)

    const {lastFrame} = render(<Flash args={{port: PORT} as never} />)

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stripVTControlCharacters(lastFrame() ?? '')).toContain(
      'Device is running custom firmware ("my-firmware")',
    )
  })

  it("warns before flashing a board's image over other firmware", async () => {
    customFirmwareDevice()
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32c6'},
      image: 'board',
      board: {name: '@acme/devboard', source: 'dependency'},
      warnings: [],
    } as unknown as FlashPlan)

    const {lastFrame} = render(<Flash args={{port: PORT} as never} />)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(lastFrame() ?? '')
      expect(frame).toContain(
        'The device runs other firmware ("my-firmware"), which this replaces with',
      )
      expect(frame).toContain('Continue? (y/N)')
    })
  })

  it('checks the device before the plan, which may reset it', async () => {
    openSession.mockReturnValue(new Promise(() => {}))
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32c6'},
      image: 'bundled',
      warnings: [],
    } as unknown as FlashPlan)

    const {lastFrame} = render(<Flash args={{port: PORT} as never} />)

    await vi.waitFor(() => expect(openSession).toHaveBeenCalled())
    expect(stripVTControlCharacters(lastFrame() ?? '')).toContain('Checking device firmware…')
    expect(resolveFlashPlan).not.toHaveBeenCalled()
  })
})

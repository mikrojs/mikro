import {stripVTControlCharacters} from 'node:util'

import {cleanup, render} from 'ink-testing-library'
import {afterEach, describe, expect, it, vi} from 'vitest'

import type {FlashPlan} from '../../lib/flashFirmware.js'
import Flash from '../flash.js'

const PORT = '/dev/tty.fixture'

const {resolveFlashPlan} = vi.hoisted(() => ({resolveFlashPlan: vi.fn()}))

vi.mock('../../hooks/useDevices.js', () => ({
  useDevices: () => ({status: 'success', value: [{path: '/dev/tty.fixture'}]}),
}))
vi.mock('../../lib/flashFirmware.js', () => ({resolveFlashPlan}))

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

  it('asks once the plan has resolved', async () => {
    resolveFlashPlan.mockResolvedValue({
      esptoolPath: '/fixture/esptool',
      flasherArgs: {chip: 'esp32c6'},
    } as unknown as FlashPlan)

    const {lastFrame} = render(screen())

    await vi.waitFor(() =>
      expect(stripVTControlCharacters(lastFrame() ?? '')).toContain('Continue? (y/N)'),
    )
  })
})

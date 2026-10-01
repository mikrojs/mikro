import {stripVTControlCharacters} from 'node:util'

import {Box, Text} from 'ink'
import {cleanup, render} from 'ink-testing-library'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {AbortQuestion, useConfirmAbort, useExitKeys} from '../exitKeys.js'

/** Past Ink's render */
const settle = () => new Promise((r) => setTimeout(r, 40))

// Ctrl+C is not used here: ink-testing-library renders with exitOnCtrlC on,
// so Ink takes it before any handler.
const CTRL_D = '\x04'
const CTRL_Q = '\x11'

function Writing({onAbort}: {onAbort: () => void}) {
  const asking = useConfirmAbort(true, onAbort)
  return (
    <Box flexDirection="column">
      <Text>writing</Text>
      {asking && <AbortQuestion during="flash" />}
    </Box>
  )
}

function Waiting({onExit}: {onExit: () => void}) {
  useExitKeys(true, onExit)
  return <Text>waiting</Text>
}

describe('exit keys', () => {
  afterEach(cleanup)

  it('leave a screen on Ctrl+D or Ctrl+Q, and not on the letters', async () => {
    const onExit = vi.fn()
    const {stdin} = render(<Waiting onExit={onExit} />)
    await settle()
    stdin.write('d')
    stdin.write('q')
    await settle()
    expect(onExit).not.toHaveBeenCalled()
    stdin.write(CTRL_D)
    stdin.write(CTRL_Q)
    await settle()
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('ask before stopping a write, and stop it only on y', async () => {
    const onAbort = vi.fn()
    const {stdin, lastFrame} = render(<Writing onAbort={onAbort} />)
    const frame = () => stripVTControlCharacters(lastFrame() ?? '')
    await settle()
    expect(frame()).not.toContain('Abort anyway?')

    stdin.write(CTRL_Q)
    await settle()
    expect(frame()).toContain('Abort anyway?')

    // n takes the question away, and the write goes on
    stdin.write('n')
    await settle()
    expect(frame()).not.toContain('Abort anyway?')

    // A second exit key is not a yes: pressing Ctrl+C twice must not stop a flash
    stdin.write(CTRL_Q)
    stdin.write(CTRL_Q)
    await settle()
    expect(frame()).toContain('Abort anyway?')
    expect(onAbort).not.toHaveBeenCalled()

    stdin.write('y')
    await settle()
    expect(onAbort).toHaveBeenCalledOnce()
  })
})

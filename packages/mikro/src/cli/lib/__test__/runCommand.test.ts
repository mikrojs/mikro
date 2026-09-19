import {afterEach, describe, expect, it, vi} from 'vitest'

import {UserError} from '../errorMessage.js'
import {runCommand} from '../runCommand.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runCommand', () => {
  it('prints one line with the cause chain and exits 1 for a UserError', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    runCommand(
      Promise.reject(
        new UserError('/dev/ttyTest is in use by another program', {
          cause: new Error('Cannot lock port'),
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Error: /dev/ttyTest is in use by another program: Cannot lock port',
    )
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('rethrows any other error so a bug keeps its stack trace', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const bug = new TypeError("Cannot read properties of undefined (reading 'x')")

      runCommand(Promise.reject(bug))
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(unhandled).toHaveBeenCalledExactlyOnceWith(bug, expect.anything())
      expect(error).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('does nothing when the command succeeds', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)

    runCommand(Promise.resolve())
    runCommand(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(exit).not.toHaveBeenCalled()
  })
})

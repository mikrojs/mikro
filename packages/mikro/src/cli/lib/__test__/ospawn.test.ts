import {describe, expect, it} from 'vitest'

import {SpawnError, spawnErrorMessage} from '../ospawn.js'

describe('spawnErrorMessage', () => {
  it('reports the exit code of a tool that ran and failed', () => {
    const error = new SpawnError('Process exited with non-zero exit code', 2)
    expect(spawnErrorMessage(error, 'esptool')).toBe('esptool exited with code 2')
  })

  it('reports why a tool could not be started', () => {
    expect(spawnErrorMessage(new Error('spawn esptool ENOENT'), 'esptool')).toBe(
      'esptool could not be run: spawn esptool ENOENT',
    )
  })

  it('never includes a stack trace', () => {
    const error = new SpawnError('Process exited with non-zero exit code', 2)
    expect(spawnErrorMessage(error, 'esptool')).not.toContain(' at ')
  })
})

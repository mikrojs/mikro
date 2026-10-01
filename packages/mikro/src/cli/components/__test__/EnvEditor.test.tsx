import {stripVTControlCharacters} from 'node:util'

import {cleanup, render} from 'ink-testing-library'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {EnvEditor, type EnvEditorConfig} from '../EnvEditor.js'

/** Past the load of the entries and Ink's render */
const settle = () => new Promise((r) => setTimeout(r, 60))

const CTRL_D = '\x04'
const CTRL_Q = '\x11'

function editor(overrides: Partial<EnvEditorConfig> = {}) {
  const config: EnvEditorConfig = {
    list: async () => [{key: 'WIFI_SSID', value: 'home', secret: false}],
    set: async () => {},
    delete: async () => {},
    ...overrides,
  }
  const onClose = vi.fn()
  const app = render(<EnvEditor config={config} onClose={onClose} />)
  return {stdin: app.stdin, onClose, frame: () => stripVTControlCharacters(app.lastFrame() ?? '')}
}

describe('EnvEditor keys', () => {
  afterEach(cleanup)

  it('takes d as delete, and Ctrl+D as a way out', async () => {
    const {stdin, onClose, frame} = editor()
    await settle()
    stdin.write(CTRL_D)
    await settle()
    expect(frame()).not.toContain('Delete WIFI_SSID?')
    expect(onClose).toHaveBeenCalledOnce()

    stdin.write('d')
    await settle()
    expect(frame()).toContain('Delete WIFI_SSID?')
  })

  it('backs out of a question to the list, then out of the editor', async () => {
    const {stdin, onClose, frame} = editor()
    await settle()
    stdin.write('d')
    await settle()
    stdin.write(CTRL_Q)
    await settle()
    expect(frame()).not.toContain('Delete WIFI_SSID?')
    expect(onClose).not.toHaveBeenCalled()

    stdin.write(CTRL_Q)
    await settle()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('can be left while a save does not come back', async () => {
    const {stdin, onClose, frame} = editor({delete: () => new Promise(() => {})})
    await settle()
    stdin.write('d')
    await settle()
    stdin.write('y')
    await settle()
    expect(frame()).toContain('Deleting WIFI_SSID')
    // Other keys are still ignored
    stdin.write('q')
    await settle()
    expect(onClose).not.toHaveBeenCalled()

    stdin.write(CTRL_D)
    await settle()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

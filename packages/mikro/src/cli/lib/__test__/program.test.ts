import {expect, it, vi} from 'vitest'

const loaded = vi.hoisted(() => new Set<string>())

vi.mock('ink', () => {
  loaded.add('ink')
  return {}
})
vi.mock('react', () => {
  loaded.add('react')
  return {}
})
vi.mock('serialport', () => {
  loaded.add('serialport')
  return {}
})

// Every run parses with program.ts before it loads a command, so the parsers
// must not pull in what the handlers use.
it('loads no ink, react or serialport to parse', async () => {
  await import('../../program.js')
  expect([...loaded]).toEqual([])
})

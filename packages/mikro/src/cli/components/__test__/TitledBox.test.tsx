import {Text} from 'ink'
import {render} from 'ink-testing-library'
import React from 'react'
import {describe, expect, test} from 'vitest'

import {BorderFill, TitledBox} from '../TitledBox.js'

// The TitledBox component uses measureElement + useEffect to measure width,
// so the custom top border only appears after the first render cycle.
// We wait briefly for the effect to fire and the second frame to settle.
async function renderSettled(element: React.ReactElement) {
  const inst = render(element)
  await new Promise((r) => setTimeout(r, 50))
  return inst
}

function lines(frame: string | undefined): string[] {
  return (frame ?? '').split('\n').filter((l) => l.length > 0)
}

describe('TitledBox', () => {
  test('renders a header on the top border', async () => {
    const inst = await renderSettled(
      <TitledBox
        header={
          <BorderFill char="─">
            <Text>Hello</Text>
          </BorderFill>
        }
        borderStyle="single"
        width={30}
      >
        <Text>content</Text>
      </TitledBox>,
    )
    const ls = lines(inst.lastFrame())
    expect(ls[0]).toContain('Hello')
    expect(ls.some((l) => l.includes('content'))).toBe(true)
    inst.cleanup()
  })

  test('renders without header shows standard ink border', async () => {
    const inst = await renderSettled(
      <TitledBox borderStyle="single" width={30}>
        <Text>content</Text>
      </TitledBox>,
    )
    const ls = lines(inst.lastFrame())
    // Without a header, Ink renders its own top border
    expect(ls[0]).toMatch(/^┌─+┐$/)
    inst.cleanup()
  })

  test('does not render custom top border when borderTop is false', async () => {
    const inst = await renderSettled(
      <TitledBox
        header={
          <BorderFill char="─">
            <Text>Hidden</Text>
          </BorderFill>
        }
        borderStyle="single"
        borderTop={false}
        width={30}
      >
        <Text>content</Text>
      </TitledBox>,
    )
    const frame = inst.lastFrame() ?? ''
    expect(frame).not.toContain('Hidden')
    inst.cleanup()
  })

  test('passes inner layout props to content box', async () => {
    const inst = await renderSettled(
      <TitledBox
        header={
          <BorderFill char="─">
            <Text>Title</Text>
          </BorderFill>
        }
        borderStyle="single"
        width={40}
        paddingLeft={2}
      >
        <Text>padded</Text>
      </TitledBox>,
    )
    const frame = inst.lastFrame() ?? ''
    const contentLine = frame.split('\n').find((l) => l.includes('padded'))
    expect(contentLine).toBeDefined()
    // With paddingLeft=2 there should be spaces between the border and content
    expect(contentLine).toMatch(/│\s{2,}padded/)
    inst.cleanup()
  })
})

describe('BorderFill', () => {
  test('fills remaining space with border char', async () => {
    const inst = render(
      <BorderFill char="─">
        <Text>Hi</Text>
      </BorderFill>,
    )
    await new Promise((r) => setTimeout(r, 50))
    const frame = inst.lastFrame() ?? ''
    expect(frame).toContain('Hi')
    expect(frame).toContain('─')
    inst.cleanup()
  })

  test('justifyContent="end" puts fill before children', async () => {
    const inst = render(
      <BorderFill char="─" justifyContent="end">
        <Text>End</Text>
      </BorderFill>,
    )
    await new Promise((r) => setTimeout(r, 50))
    const frame = inst.lastFrame() ?? ''
    // Fill should come before the text
    const fillIdx = frame.indexOf('─')
    const textIdx = frame.indexOf('End')
    expect(fillIdx).toBeLessThan(textIdx)
    inst.cleanup()
  })

  test('renders multiple children with fill between', async () => {
    const inst = render(
      <BorderFill char="─" justifyContent="space-between">
        <Text>A</Text>
        <Text>B</Text>
      </BorderFill>,
    )
    await new Promise((r) => setTimeout(r, 50))
    const frame = inst.lastFrame() ?? ''
    expect(frame).toContain('A')
    expect(frame).toContain('B')
    inst.cleanup()
  })
})

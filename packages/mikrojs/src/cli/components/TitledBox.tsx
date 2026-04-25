import {Box, type BoxProps, type DOMElement, measureElement, Text} from 'ink'
import React, {type ReactNode, useEffect, useRef, useState} from 'react'

type BorderStyle =
  | 'round'
  | 'single'
  | 'double'
  | 'bold'
  | 'classic'
  | 'doubleSingle'
  | 'singleDouble'
  | 'arrow'

// ── BorderFill ──────────────────────────────────────────────

type Justify = 'start' | 'end' | 'center' | 'space-between'

export interface BorderFillProps {
  /** The fill character (e.g. ─). Defaults to ─ */
  char?: string
  /** Color applied to fill segments and (by default) children text */
  color?: string
  /** Dim the fill segments */
  dimColor?: boolean
  /** Controls how fill segments distribute space around children */
  justifyContent?: Justify
  /** Standard flex gap between items (in columns) */
  gap?: number
  children?: ReactNode
}

/**
 * A flex row where remaining space is filled with a repeated character.
 * Children are placed as flex items; fill segments expand between them.
 *
 * `justifyContent` controls which fill segments grow:
 * - `start` (default): fill after last child grows
 * - `end`: fill before first child grows
 * - `center`: fills at both edges grow equally
 * - `space-between`: fills between children grow, edge fills don't
 */
function FillSegment({
  grow,
  char,
  color,
  dimColor,
  fillStr,
}: {
  grow: number
  char: string
  color?: string
  dimColor?: boolean
  fillStr: string
}) {
  if (grow === 0) {
    return (
      <Box flexShrink={0}>
        <Text color={color} dimColor={dimColor}>
          {char}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexGrow={1} width={0} overflow="hidden" height={1}>
      <Text color={color} dimColor={dimColor}>
        {fillStr}
      </Text>
    </Box>
  )
}

export function BorderFill({
  char = '─',
  color,
  dimColor,
  justifyContent = 'start',
  gap = 1,
  children,
}: BorderFillProps) {
  const ref = useRef<DOMElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (ref.current) {
      const measured = measureElement(ref.current)
      if (measured.width !== width) {
        setWidth(measured.width)
      }
    }
  }, [width])

  const items = React.Children.toArray(children)
  const fillStr = char.repeat(Math.max(0, width))

  // Compute flexGrow for each fill segment (items.length + 1 segments)
  const fills = items.length + 1
  const growFor = (index: number): number => {
    switch (justifyContent) {
      case 'start':
        return index === fills - 1 ? 1 : 0
      case 'end':
        return index === 0 ? 1 : 0
      case 'center':
        return index === 0 || index === fills - 1 ? 1 : 0
      case 'space-between':
        return index > 0 && index < fills - 1 ? 1 : 0
    }
  }

  const spacer = gap > 0 ? ' '.repeat(gap) : ''

  return (
    <Box ref={ref} height={1} overflow="hidden">
      {items.flatMap((child, i) => [
        <FillSegment
          key={`f${i}`}
          grow={growFor(i)}
          char={char}
          color={color}
          dimColor={dimColor}
          fillStr={fillStr}
        />,
        ...(i > 0 && spacer
          ? [
              <Box key={`s${i}`} flexShrink={0}>
                <Text color={color} dimColor={dimColor}>
                  {spacer}
                </Text>
              </Box>,
            ]
          : []),
        <Box key={`c${i}`} flexShrink={0}>
          {child}
        </Box>,
      ])}
      <FillSegment
        key={`f${items.length}`}
        grow={growFor(items.length)}
        char={char}
        color={color}
        dimColor={dimColor}
        fillStr={fillStr}
      />
    </Box>
  )
}

// ── TitledBox ───────────────────────────────────────────────

const INNER_PROP_NAMES = new Set([
  'children',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'gap',
  'rowGap',
  'columnGap',
  'display',
])

const BORDER_FLAG_NAMES = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] as const

export type TitledBoxProps = Omit<BoxProps, 'borderStyle'> & {
  /** Header row rendered as the top border. Use BorderFill for fill-aware layout. */
  header?: ReactNode
  borderStyle: BorderStyle
  children?: ReactNode
}

function splitProps(props: TitledBoxProps) {
  const inner: Record<string, unknown> = {}
  const outer: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (key === 'header' || key === 'borderStyle') continue
    if (INNER_PROP_NAMES.has(key)) {
      inner[key] = value
    } else {
      outer[key] = value
    }
  }

  // Border flags and colors go to the inner box
  for (const key of Object.keys(props)) {
    if (key.startsWith('border')) {
      inner[key] = (props as Record<string, unknown>)[key]
    }
  }

  // Set default border flags
  for (const flag of BORDER_FLAG_NAMES) {
    if (inner[flag] === undefined) inner[flag] = true
  }

  return {inner, outer}
}

export function TitledBox({header, borderStyle = 'single', children, ...rest}: TitledBoxProps) {
  const allProps = {header, borderStyle, children, ...rest} as TitledBoxProps
  const {inner, outer} = splitProps(allProps)

  const borderTop = inner.borderTop !== false
  const showCustomTop = header != null && borderTop

  return (
    <Box flexDirection="column" {...(outer as BoxProps)}>
      {showCustomTop && header}
      <Box
        borderStyle={borderStyle as BoxProps['borderStyle']}
        flexGrow={1}
        {...(inner as BoxProps)}
        borderTop={showCustomTop ? false : (inner.borderTop as boolean)}
      >
        {children}
      </Box>
    </Box>
  )
}

import {Text} from 'ink'
import type {ReactNode} from 'react'

import {describeError, UserError} from '../lib/errorMessage.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {resolveEntry} from '../lib/resolveEntry.js'

type Props = {
  entry: string | undefined
  children: (entry: string) => ReactNode
}

/** Resolves the entry before the command renders. Thrown during render, a missing
 *  entry would reach Ink's error screen instead: a stack trace and exit code 0. */
export function EntryGate(props: Props) {
  let entry: string
  try {
    entry = resolveEntry(props.entry)
  } catch (err) {
    if (!(err instanceof UserError)) throw err
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">Error: {describeError(err)}</Text>
      </RenderAndExit>
    )
  }
  return <>{props.children(entry)}</>
}

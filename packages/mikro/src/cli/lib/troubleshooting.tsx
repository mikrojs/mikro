import {Text} from 'ink'
import React from 'react'

export const TROUBLESHOOTING_URL = 'https://mikrojs.dev/troubleshooting'

/** How long an unresolved "waiting for device / connecting" UI lingers
 * before we surface the troubleshooting link. Long enough that a normal
 * connect doesn't show it, short enough that a stuck connect doesn't
 * leave the user staring at a spinner with no next step. */
export const TROUBLESHOOTING_HINT_DELAY_MS = 8_000

export function TroubleshootingHint({prefix}: {prefix?: string} = {}) {
  return (
    <Text dimColor>
      {prefix ? `${prefix} ` : ''}See {TROUBLESHOOTING_URL} for help.
    </Text>
  )
}

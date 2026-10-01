import figures from 'figures'
import {Text, useInput} from 'ink'
import {useState} from 'react'

import {isExitKey, plainKey} from './keys.js'

/** Leaves on Ctrl+C, Ctrl+D or Ctrl+Q while `isActive`. Ink runs with
 *  exitOnCtrlC off, so a screen that handles no keys cannot be left. */
export function useExitKeys(isActive = true, onExit: () => void = () => process.exit(0)) {
  useInput(
    (ch, key) => {
      if (isExitKey(ch, key)) onExit()
    },
    {isActive},
  )
}

/** `useExitKeys` for a component that returns early: rendered with the screen. */
export function ExitKeys() {
  useExitKeys()
  return null
}

/** For while esptool writes to flash: an exit key asks first, and `y` then
 *  calls `onAbort`. Returns whether the question is up, for `AbortQuestion`. */
export function useConfirmAbort(isActive: boolean, onAbort: () => void): boolean {
  const [asking, setAsking] = useState(false)
  useInput(
    (input, key) => {
      if (!asking) {
        if (isExitKey(input, key)) setAsking(true)
        return
      }
      const ch = plainKey(input, key).toLowerCase()
      if (ch === 'y') {
        onAbort()
      } else if (ch === 'n' || key.escape) {
        setAsking(false)
      }
    },
    {isActive},
  )
  return asking
}

/** What stopping esptool now does to the device. */
const ABORT_WARNINGS = {
  flash: 'Aborting mid-flash can leave the device unbootable and require a manual re-flash.',
  erase: 'Aborting mid-erase leaves the device without working firmware until it is flashed.',
}

export function AbortQuestion({during}: {during: keyof typeof ABORT_WARNINGS}) {
  return (
    <>
      <Text color="yellow">
        {figures.warning} {ABORT_WARNINGS[during]}
      </Text>
      <Text>
        Abort anyway? <Text bold>(y/N)</Text>
      </Text>
    </>
  )
}

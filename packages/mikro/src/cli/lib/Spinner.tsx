import type {Spinner as SpinnerData} from 'cli-spinners'
import {Text} from 'ink'
import React, {type ComponentProps, useEffect, useState} from 'react'

export type SpinnerProps = ComponentProps<typeof Text> & {spinner: SpinnerData}

/**
 * Spinner.
 */
export function Spinner({spinner, ...rest}: SpinnerProps) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((previousFrame) => {
        const isLastFrame = previousFrame === spinner.frames.length - 1
        return isLastFrame ? 0 : previousFrame + 1
      })
    }, spinner.interval)

    return () => {
      clearInterval(timer)
    }
  }, [spinner])

  return <Text {...rest}>{spinner.frames[frame]}</Text>
}

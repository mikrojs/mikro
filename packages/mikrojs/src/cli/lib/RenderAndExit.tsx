import {type ReactNode, useEffect} from 'react'

export function RenderAndExit(props: {children: ReactNode; exitCode: number}) {
  useEffect(() => {
    process.exit(props.exitCode)
  }, [props.exitCode])

  return props.children
}

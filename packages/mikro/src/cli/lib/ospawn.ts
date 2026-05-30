import {spawn, type SpawnOptionsWithoutStdio} from 'node:child_process'

import {catchError, map, Observable, of, scan} from 'rxjs'
import {concatUint8Arrays} from 'uint8array-extras'

export type Output = {
  type: 'err' | 'out'
  output: Uint8Array
}

export type OutputEvent = {
  type: 'output'
  output: Output
}
export type ErrorEvent = {
  type: 'error'
  error: Error
}

export type CompletedEvent = {
  type: 'complete'
}

export type SpawnEvent = OutputEvent | ErrorEvent | CompletedEvent

export type SpawnState = {
  output: Output[]
  error: Error | SpawnError | undefined
  completed: boolean
}

export class SpawnError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.exitCode = exitCode
  }
}

export const INITIAL_SPAWN_STATE: SpawnState = {
  output: [],
  error: undefined,
  completed: false,
}

export function ospawn(
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) {
  return new Observable<OutputEvent | CompletedEvent>((observer) => {
    const abortController = new AbortController()

    const onStdOut = (data: Uint8Array) => {
      observer.next({type: 'output', output: {type: 'out', output: data}})
    }

    const onStdErr = (data: Uint8Array) => {
      observer.next({type: 'output', output: {type: 'err', output: data}})
    }

    const onError = (err: Error) => {
      if (!abortController.signal.aborted) {
        observer.error(err)
      }
    }

    const onExit = (exitCode: number) => {
      if (exitCode) {
        observer.error(new SpawnError('Process exited with non-zero exit code', exitCode))
      } else {
        observer.next({type: 'complete'})
        observer.complete()
      }
    }

    //console.log([command].concat(args || []).join(' '), options)
    const childProcess = spawn(command, args, {
      ...options,
      signal: abortController.signal,
    })

    childProcess.stdout?.on('data', onStdOut)
    childProcess.stdout?.on('error', onError)
    childProcess.stderr?.on('error', onError)
    childProcess.stderr?.on('data', onStdErr)
    childProcess.on('error', onError)
    childProcess.on('close', onExit)
    return () => {
      abortController.abort()
      childProcess.stdout?.off('data', onStdOut)
      childProcess.stderr?.off('data', onStdErr)
      childProcess.off('error', onError)
      childProcess.off('close', onExit)
    }
  }).pipe(
    map((ev) =>
      ev.type === 'output' ? ({type: 'output', output: ev.output} satisfies OutputEvent) : ev,
    ),
    catchError((err: Error): Observable<ErrorEvent> => of({type: 'error', error: err})),
    scan((state: SpawnState, event: SpawnEvent) => {
      if (event.type === 'error') {
        return {
          ...state,
          error: event.error,
          completed: true,
        }
      }
      if (event.type === 'complete') {
        return {
          ...state,
          completed: true,
        }
      }
      return {
        ...state,
        output: mergeOutput(state.output, event),
        error: undefined,
      }
    }, INITIAL_SPAWN_STATE),
  )
}

function mergeOutput(prevOutput: Output[], nextOutput: OutputEvent): Output[] {
  const lastOutput = prevOutput.at(-1)
  if (lastOutput && lastOutput.type === nextOutput.output.type) {
    return [
      {
        ...lastOutput,
        output: concatUint8Arrays([lastOutput.output, nextOutput.output.output]),
      },
    ]
  }
  return prevOutput.concat(nextOutput.output)
}

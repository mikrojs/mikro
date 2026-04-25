import {readdir, stat} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {command, constant, message, object, optional, withDefault} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text} from 'ink'
import React, {useEffect, useMemo, useReducer} from 'react'
import {lastValueFrom} from 'rxjs'

import type {LogLevel, Minifier, MinifyLevel} from '../../_exports/index.js'
import {agentError, agentResult, isAgentMode} from '../lib/agent.js'
import {build, type BuildEvent} from '../lib/build.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {resolveEntry} from '../lib/resolveEntry.js'
import {Spinner} from '../lib/Spinner.js'

export const args = command(
  'build',
  object({
    action: constant('build'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    outDir: withDefault(
      argument(path({metavar: 'OUTDIR', allowCreate: true, type: 'directory'})),
      'build',
    ),
    noMinify: optional(flag('--no-minify', {description: message`Skip minification`})),
    minifier: optional(
      option('--minifier', string({metavar: 'NAME'}), {
        description: message`Minifier: esbuild, terser, or swc (default: esbuild)`,
      }),
    ),
    minifyLevel: optional(
      option('--minify-level', string({metavar: 'LEVEL'}), {
        description: message`Minify level: default or max`,
      }),
    ),
    noBytecode: optional(flag('--no-bytecode', {description: message`Skip bytecode compilation`})),
    logLevel: optional(
      option('--loglevel', string({metavar: 'LEVEL'}), {
        description: message`Log level: none, error, warn, info, debug. Console calls below this level are eliminated at build time.`,
      }),
    ),
    json: optional(flag('--json', {description: message`Output as JSON`})),
    agent: optional(flag('--agent', {description: message`Output as JSON (agent mode)`})),
  }),
)

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

export async function run(config: InferValue<typeof args>) {
  const entry = resolveEntry(config.entry)
  const {outDir, noMinify, noBytecode} = config
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)
  const logLevel = parseLogLevel(config.logLevel) ?? 'warn'
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  try {
    await lastValueFrom(
      build(entry, outDir, {
        minify: !noMinify,
        bytecode: !noBytecode,
        minifier,
        minifyLevel,
        logLevel,
      }),
      {defaultValue: undefined},
    )
    const entries = await readdir(outDir, {recursive: true})
    const files: {path: string; size: number}[] = []
    for (const e of entries) {
      const full = pathlib.join(outDir, e)
      const s = await stat(full)
      if (s.isFile()) files.push({path: '/' + e, size: s.size})
    }
    if (jsonOutput) {
      agentResult('build', {entry, outDir, files}, [
        {command: 'mikro deploy', description: 'Deploy build to device'},
        {command: `mikro build ${entry} --no-bytecode`, description: 'Rebuild without bytecode'},
      ])
    } else {
      const totalSize = files.reduce((sum, f) => sum + f.size, 0)
      // eslint-disable-next-line no-console
      console.log(`Built ${files.length} file(s) to ${outDir}, ${formatSize(totalSize)} total`)
      for (const file of files) {
        // eslint-disable-next-line no-console
        console.log(`  ${file.path} ${formatSize(file.size)}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (jsonOutput) {
      agentError('build', msg, {fix: `Check that ${entry} exists and has valid syntax`})
    } else {
      // eslint-disable-next-line no-console
      console.error(`Error: ${msg}`)
    }
    process.exit(1)
  }
}

type Props = {
  args: InferValue<typeof args>
}

export default function Build(props: Props) {
  const {outDir, noMinify, noBytecode} = props.args
  const minifier = parseMinifier(props.args.minifier)
  const minifyLevel = parseMinifyLevel(props.args.minifyLevel)
  const logLevel = parseLogLevel(props.args.logLevel)
  const entry = resolveEntry(props.args.entry)

  return (
    <Run
      entry={entry}
      outDir={outDir}
      minify={!noMinify}
      bytecode={!noBytecode}
      minifier={minifier}
      minifyLevel={minifyLevel}
      logLevel={logLevel}
    />
  )
}

type BuildState = {
  phase: string
  files: {path: string; size: number}[]
  done: boolean
  error: string | null
}

type BuildAction = BuildEvent | {type: 'error'; message: string}

function buildReducer(state: BuildState, event: BuildAction): BuildState {
  switch (event.type) {
    case 'phase':
      return {...state, phase: event.phase}
    case 'file':
      return {...state, files: [...state.files, {path: event.path, size: event.size}]}
    case 'done':
      return {...state, done: true}
    case 'error':
      return {...state, error: event.message}
    default:
      return state
  }
}

const initialState: BuildState = {
  phase: 'Starting',
  files: [],
  done: false,
  error: null,
}

function Run(props: {
  entry: string
  outDir: string
  minify: boolean
  bytecode: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  logLevel?: LogLevel
}) {
  const {entry, outDir, minify, bytecode, minifier, minifyLevel, logLevel} = props
  const [state, dispatch] = useReducer(buildReducer, initialState)

  const _build = useMemo(
    () => build(entry, outDir, {minify, bytecode, minifier, minifyLevel, logLevel}),
    [entry, outDir, minify, bytecode, minifier, minifyLevel, logLevel],
  )

  useEffect(() => {
    const sub = _build.subscribe({
      next: (event) => dispatch(event),
      error: (err) =>
        dispatch({type: 'error', message: err instanceof Error ? err.message : String(err)}),
    })
    return () => sub.unsubscribe()
  }, [_build])

  if (state.error) {
    return (
      <RenderAndExit exitCode={1}>
        <Text color="red">
          {figures.cross} {state.error}
        </Text>
      </RenderAndExit>
    )
  }

  if (state.done) {
    const totalSize = state.files.reduce((sum, f) => sum + f.size, 0)
    return (
      <RenderAndExit exitCode={0}>
        <Box flexDirection="column">
          <Text color="green">
            {figures.tick} Built {state.files.length} file(s) to <Text color="cyan">{outDir}</Text>,{' '}
            {formatSize(totalSize)} total
          </Text>
          {state.files.map((file) => (
            <Text key={file.path} dimColor>
              {'  '}
              {file.path} <Text color="cyan">{formatSize(file.size)}</Text>
            </Text>
          ))}
        </Box>
      </RenderAndExit>
    )
  }

  return (
    <Text>
      <Spinner spinner={spinners.dots} /> {state.phase}…
    </Text>
  )
}

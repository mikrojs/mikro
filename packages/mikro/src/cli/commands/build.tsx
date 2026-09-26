import * as pathlib from 'node:path'

import type {DuplicatePackage} from '@mikrojs/analyze-imports'
import {command, constant, message, object, optional} from '@optique/core'
import type {InferValue} from '@optique/core/parser'
import {argument, flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'
import {path} from '@optique/run'
import spinners from 'cli-spinners'
import figures from 'figures'
import {Box, Text} from 'ink'
import React, {useEffect, useMemo, useReducer} from 'react'
import {lastValueFrom, tap} from 'rxjs'

import type {LogLevel, Minifier, MinifyLevel} from '../../_exports/index.js'
import {EntryGate} from '../components/EntryGate.js'
import {agentError, agentResult, isAgentMode} from '../lib/agent.js'
import {build, type BuildEvent, type BuildFeatures} from '../lib/build.js'
import {displayPath} from '../lib/displayPath.js'
import {formatDuplicatePackagesNotice} from '../lib/duplicatePackages.js'
import {agentFeatures, formatFeaturesLine} from '../lib/featureGate.js'
import {formatSize} from '../lib/formatSize.js'
import {parseLogLevel, parseMinifier, parseMinifyLevel} from '../lib/parseMinifier.js'
import {resolveProjectRoot} from '../lib/projectRoot.js'
import {RenderAndExit} from '../lib/RenderAndExit.js'
import {resolveEntry} from '../lib/resolveEntry.js'
import {Spinner} from '../lib/Spinner.js'

export const args = command(
  'build',
  object({
    action: constant('build'),
    entry: optional(argument(path({metavar: 'ENTRY', mustExist: true, type: 'file'}))),
    outDir: optional(
      option('-o', '--out-dir', path({metavar: 'DIR', allowCreate: true, type: 'directory'}), {
        description: message`Output directory (default: .mikro/build in the project root)`,
      }),
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

/** The default lives in the project's `.mikro/`, leaving `./build` to ESP-IDF
 *  when the app root also holds a firmware project. */
function resolveOutDir(outDir: string | undefined): string {
  return outDir ?? pathlib.join(resolveProjectRoot(), '.mikro', 'build')
}

export async function run(config: InferValue<typeof args>) {
  const entry = resolveEntry(config.entry)
  const outDir = resolveOutDir(config.outDir)
  const {noMinify, noBytecode} = config
  const minifier = parseMinifier(config.minifier)
  const minifyLevel = parseMinifyLevel(config.minifyLevel)
  const logLevel = parseLogLevel(config.logLevel)
  const jsonOutput = config.json === true || isAgentMode(config.agent)
  try {
    let duplicatePackages: DuplicatePackage[] | undefined
    let features: BuildFeatures | undefined
    const files: {path: string; size: number}[] = []
    await lastValueFrom(
      build(entry, outDir, {
        minify: !noMinify,
        bytecode: !noBytecode,
        minifier,
        minifyLevel,
        logLevel,
        env: 'production',
        markOutDir: config.outDir !== undefined,
      }).pipe(
        tap((event) => {
          if (event.type === 'duplicatePackages') duplicatePackages = event.packages
          if (event.type === 'features') features = event
          if (event.type === 'file') files.push({path: event.path, size: event.size})
        }),
      ),
      {defaultValue: undefined},
    )
    if (jsonOutput) {
      // duplicatePackages and features are omitted when empty (undefined drops out of the JSON).
      agentResult(
        'build',
        {
          entry,
          outDir: pathlib.resolve(outDir),
          files,
          duplicatePackages,
          features: agentFeatures(features),
        },
        [
          {command: 'mikro deploy', description: 'Deploy build to device'},
          {command: `mikro build ${entry} --no-bytecode`, description: 'Rebuild without bytecode'},
        ],
      )
    } else {
      const totalSize = files.reduce((sum, f) => sum + f.size, 0)
      // eslint-disable-next-line no-console
      console.log(
        `Built ${files.length} file(s) to ${displayPath(outDir)}, ${formatSize(totalSize)} total`,
      )
      for (const file of files) {
        // eslint-disable-next-line no-console
        console.log(`  ${file.path} ${formatSize(file.size)}`)
      }
      const notice = formatDuplicatePackagesNotice(duplicatePackages ?? [])
      // eslint-disable-next-line no-console
      if (notice !== undefined) console.error(notice)
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
  const {noMinify, noBytecode} = props.args
  const minifier = parseMinifier(props.args.minifier)
  const minifyLevel = parseMinifyLevel(props.args.minifyLevel)
  const logLevel = parseLogLevel(props.args.logLevel)
  const outDir = resolveOutDir(props.args.outDir)

  return (
    <EntryGate entry={props.args.entry}>
      {(entry) => (
        <Run
          entry={entry}
          outDir={outDir}
          markOutDir={props.args.outDir !== undefined}
          minify={!noMinify}
          bytecode={!noBytecode}
          minifier={minifier}
          minifyLevel={minifyLevel}
          logLevel={logLevel}
        />
      )}
    </EntryGate>
  )
}

type BuildState = {
  phase: string
  files: {path: string; size: number}[]
  duplicatePackages: DuplicatePackage[]
  features: BuildFeatures | null
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
    case 'duplicatePackages':
      return {...state, duplicatePackages: event.packages}
    case 'features':
      return {...state, features: event}
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
  duplicatePackages: [],
  features: null,
  done: false,
  error: null,
}

function Run(props: {
  entry: string
  outDir: string
  markOutDir: boolean
  minify: boolean
  bytecode: boolean
  minifier?: Minifier
  minifyLevel?: MinifyLevel
  logLevel?: LogLevel
}) {
  const {entry, outDir, markOutDir, minify, bytecode, minifier, minifyLevel, logLevel} = props
  const [state, dispatch] = useReducer(buildReducer, initialState)

  const _build = useMemo(
    () =>
      build(entry, outDir, {
        minify,
        bytecode,
        minifier,
        minifyLevel,
        logLevel,
        env: 'production',
        markOutDir,
      }),
    [entry, outDir, markOutDir, minify, bytecode, minifier, minifyLevel, logLevel],
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
    const notice = formatDuplicatePackagesNotice(state.duplicatePackages)
    const featuresLine = state.features ? formatFeaturesLine(state.features) : undefined
    return (
      <RenderAndExit exitCode={0}>
        <Box flexDirection="column">
          <Text color="green">
            {figures.tick} Built {state.files.length} file(s) to{' '}
            <Text color="cyan">{displayPath(outDir)}</Text>, {formatSize(totalSize)} total
          </Text>
          {featuresLine !== undefined ? (
            <Text dimColor>
              {'  '}
              {featuresLine}
            </Text>
          ) : null}
          {state.files.map((file) => (
            <Text key={file.path} dimColor>
              {'  '}
              {file.path} <Text color="cyan">{formatSize(file.size)}</Text>
            </Text>
          ))}
          {notice !== undefined ? (
            <Text color="yellow">
              {figures.warning} {notice}
            </Text>
          ) : null}
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

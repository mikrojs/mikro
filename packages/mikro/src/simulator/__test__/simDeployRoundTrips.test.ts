/**
 * Deploys through the real simulator process and counts the protocol
 * commands the CLI sends: a deploy that changes nothing costs the same few
 * round trips however many files the app has, and a change stages the
 * unchanged files with one KEEP_MANY rather than a KEEP per file.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {lastValueFrom} from 'rxjs'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  CMD_DEPLOY_ABORT,
  CMD_DEPLOY_CHECKSUM,
  CMD_DEPLOY_CHECKSUM_LIST,
  CMD_DEPLOY_KEEP,
  CMD_DEPLOY_KEEP_MANY,
  CMD_RUNTIME_PAUSE,
  CMD_RUNTIME_RESUME,
} from '../../cli/lib/protocol.js'
import {connectRepl, type DeployFile, type ReplSession} from '../../cli/lib/session.js'
import {createSimTransport} from '../../cli/lib/simTransport.js'
import type {Transport} from '../../cli/lib/transport.js'

const FILE_COUNT = 40

const files: DeployFile[] = Array.from({length: FILE_COUNT}, (_, i) => ({
  path: `/app/mod${i}.js`,
  data: Buffer.from(`export const v${i} = ${i}\n`),
}))

describe('sim deploy round trips', () => {
  let fsRoot: string
  let session: ReplSession | undefined
  const sent: number[] = []

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'mikro-sim-deploy-'))
    // The sim entry is TypeScript in the workspace; the CLI launcher sets the
    // same two for every sim it spawns.
    process.env['MIKROJS_WORKSPACE'] = '1'
    process.env['NODE_OPTIONS'] = '--import=tsx'
    const inner = createSimTransport({fsRoot})
    const transport: Transport = {
      write(data) {
        sent.push(data[0]!)
        return inner.write(data)
      },
      data: inner.data,
      close: () => inner.close(),
    }
    session = connectRepl(transport)
    session.messages$.subscribe(() => {})
  })

  afterAll(async () => {
    session?.close()
    await rm(fsRoot, {recursive: true, force: true})
  })

  async function deploy(app: DeployFile[]) {
    sent.length = 0
    const last = await lastValueFrom(session!.deploy({files: app, restart: false}))
    return {last, types: [...sent]}
  }

  it('puts every file of a new app after one checksum list', {timeout: 20_000}, async () => {
    const {last, types} = await deploy(files)
    expect(last).toEqual({type: 'complete', deployed: true, stats: {put: FILE_COUNT, kept: 0}})
    expect(types.filter((t) => t === CMD_DEPLOY_CHECKSUM_LIST)).toHaveLength(1)
    expect(types).not.toContain(CMD_DEPLOY_CHECKSUM)
  })

  it('finds nothing changed in four commands, whatever the file count', async () => {
    const {last, types} = await deploy(files)
    expect(last).toEqual({type: 'complete', deployed: false, stats: {put: 0, kept: FILE_COUNT}})
    expect(types).toEqual([
      CMD_RUNTIME_PAUSE,
      CMD_DEPLOY_CHECKSUM_LIST,
      CMD_DEPLOY_ABORT,
      CMD_RUNTIME_RESUME,
    ])
  })

  it('keeps the unchanged files with one command when one file changed', async () => {
    const changed = files.map((f, i) => (i === 0 ? {...f, data: Buffer.from('changed\n')} : f))
    const {last, types} = await deploy(changed)
    expect(last).toEqual({
      type: 'complete',
      deployed: true,
      stats: {put: 1, kept: FILE_COUNT - 1},
    })
    expect(types.filter((t) => t === CMD_DEPLOY_KEEP_MANY)).toHaveLength(1)
    expect(types).not.toContain(CMD_DEPLOY_KEEP)
  })
})

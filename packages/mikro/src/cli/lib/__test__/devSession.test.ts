import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as pathlib from 'node:path'

import {filter, firstValueFrom, of, Subject} from 'rxjs'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {createDevSession, type DevSessionHandle} from '../serial/devSession.js'
import type {ReadyEvent, ReplEvent, ReplSession} from '../session.js'

describe('dev session feature gate', () => {
  let originalCwd: string
  let tempDir: string
  let handle: DevSessionHandle | undefined

  beforeEach(() => {
    originalCwd = process.cwd()
    tempDir = realpathSync(mkdtempSync(pathlib.join(tmpdir(), 'dev-gate-')))
    writeFileSync(
      pathlib.join(tempDir, 'package.json'),
      JSON.stringify({name: 'fixture', version: '0.0.0', type: 'module', main: './app/main.ts'}),
    )
    mkdirSync(pathlib.join(tempDir, 'app'), {recursive: true})
    process.chdir(tempDir)
  })

  afterEach(() => {
    handle?.close()
    handle = undefined
    process.chdir(originalCwd)
    rmSync(tempDir, {recursive: true, force: true})
  })

  /** Session that answers the gate's handshake with `ready` and marks any
   * deploy attempt with a sentinel error, so a test can tell whether the
   * gate stopped the run before the deploy. */
  function gateSession(ready: Partial<ReadyEvent>): ReplSession {
    return {
      messages$: new Subject<ReplEvent>().asObservable(),
      ready$: new Subject<ReadyEvent>().asObservable(),
      awaitReady$: () =>
        of({type: 'ready', chip: 'esp32c6', id: null, version: null, ...ready} as ReadyEvent),
      deploy() {
        throw new Error('deploy called')
      },
      restart() {},
      close() {},
    } as unknown as ReplSession
  }

  /** The message the first build-and-deploy attempt ends with. */
  async function firstError(session: ReplSession): Promise<string> {
    handle = createDevSession({
      session,
      entry: 'app/main.ts',
      forceDeploy: false,
      minify: false,
      bytecode: false,
      watch: false,
      noHooks: true,
      noAutoEnv: true,
    })
    const state = await firstValueFrom(
      handle.state$.pipe(filter((s) => s.status.type === 'error' || s.status.type === 'watching')),
    )
    return state.status.type === 'error' ? state.status.message : 'no error'
  }

  it('refuses to deploy an app needing a feature the device lacks', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), `import 'mikro/ble'\n`)
    const message = await firstError(gateSession({board: 'esp32c6-generic', features: ['wifi']}))
    expect(message).toMatch(/mikro\/ble which needs the 'ble' firmware feature.*esp32c6-generic/s)
  })

  it('skips the gate on legacy firmware (no features reported)', async () => {
    writeFileSync(pathlib.join(tempDir, 'app', 'main.ts'), `import 'mikro/ble'\n`)
    // Reaching the deploy sentinel proves the gate let the deploy through.
    expect(await firstError(gateSession({}))).toBe('deploy called')
  })
})

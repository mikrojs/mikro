import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  browserLoginPrompt,
  canOpenBrowser,
  ensureFileIgnored,
  isRegistryResponse,
  startLoginSession,
} from '../../commands/ota/setup.js'

const agent = vi.hoisted(() => ({mode: false}))
vi.mock('../../lib/agent.js', () => ({isAgentMode: () => agent.mode}))

const REGISTRY = 'http://192.168.1.20:4873'

function respondWith(body: unknown, status = 201) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}),
    )
}

function session(over: Record<string, unknown> = {}) {
  return {
    loginUrl: `${REGISTRY}/login`,
    code: 'sess-code',
    userCode: 'BCDF-GHJK',
    expiresIn: 600,
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startLoginSession', () => {
  it('accepts a login url on the registry origin', async () => {
    respondWith(session())
    const result = await startLoginSession(REGISTRY, undefined)
    expect(result.status).toBe('ok')
  })

  // http is only allowed on a private network and the response is
  // unauthenticated there anyway, so we do not pin the login to the registry's
  // origin: it is trusted to the same degree as everything else on that
  // connection.
  it('accepts a cross-origin login url on an http registry', async () => {
    respondWith(session({loginUrl: 'http://192.168.1.99/login'}))
    expect((await startLoginSession(REGISTRY, undefined)).status).toBe('ok')
  })

  // On https the response is TLS-authenticated, so a split api/dashboard
  // deployment may approve on a separate origin.
  it('accepts a cross-origin https login url', async () => {
    respondWith(session({loginUrl: 'https://hq.example.com/approve'}))
    expect((await startLoginSession('https://api.example.com', undefined)).status).toBe('ok')
  })

  // Cross-origin is fine on https, but a downgrade to a plaintext page for the
  // operator to enter the credential into is not.
  it('refuses an http login url from an https registry', async () => {
    respondWith(session({loginUrl: 'http://registry.example.com/login'}))
    expect((await startLoginSession('https://registry.example.com', undefined)).status).toBe(
      'failed',
    )
  })

  // The downgrade check branches on the parsed protocol, so an uppercase scheme
  // cannot slip a plaintext page past it.
  it('refuses an uppercase-scheme http login url from an https registry', async () => {
    respondWith(session({loginUrl: 'HTTP://registry.example.com/login'}))
    expect((await startLoginSession('https://registry.example.com', undefined)).status).toBe(
      'failed',
    )
  })

  // The operator opens the login url in a browser, so a non-http(s) scheme is
  // unusable and (on the http path) a phishing vector.
  it('refuses a non-http login url', async () => {
    respondWith(session({loginUrl: 'data:text/html,<script>alert(1)</script>'}))
    expect((await startLoginSession(REGISTRY, undefined)).status).toBe('failed')
  })

  it('refuses a login url that is not an absolute url', async () => {
    respondWith(session({loginUrl: '/login'}))
    expect((await startLoginSession(REGISTRY, undefined)).status).toBe('failed')
  })

  // A registry with no browser login answers 404/405, which is a discovery
  // signal rather than a failure, and must stay distinguishable from one.
  it('reports an absent browser login as unsupported', async () => {
    respondWith({}, 404)
    expect((await startLoginSession(REGISTRY, undefined)).status).toBe('unsupported')
  })
})

describe('isRegistryResponse', () => {
  const jsonRes = (body: unknown) =>
    new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}})

  it('accepts the registry identity document', async () => {
    expect(await isRegistryResponse(jsonRes({name: 'mikro-registry'}))).toBe(true)
    // A build version alongside the name is fine; only the name is checked.
    expect(await isRegistryResponse(jsonRes({name: 'mikro-registry', version: 'abc123'}))).toBe(
      true,
    )
  })

  it('rejects json without the name marker', async () => {
    expect(await isRegistryResponse(jsonRes({name: 'something-else'}))).toBe(false)
    expect(await isRegistryResponse(jsonRes({hello: 'world'}))).toBe(false)
  })

  it('rejects a non-json response', async () => {
    expect(await isRegistryResponse(new Response('mikro-registry'))).toBe(false)
  })
})

describe('browserLoginPrompt', () => {
  const HTTPS = session({loginUrl: 'https://updates.test/login'})
  const text = (prompt: {lines: string[]}) => prompt.lines.join('\n')

  it('keeps the code out of the line that opens the browser', () => {
    const prompt = browserLoginPrompt(HTTPS, 'blinky', true)
    expect(text(prompt)).toContain('First copy your one-time code:')
    expect(text(prompt)).toContain('BCDF-GHJK')
    // Ordering here is structural, not textual: every line is printed before
    // the gate is awaited, so keeping the prompt out of `lines` is what puts
    // the code on screen before anything can take focus.
    expect(text(prompt)).not.toContain('Press Enter')
    expect(prompt.gate?.prompt).toContain('Press Enter to open the page')
    expect(prompt.gate?.url).toBe('https://updates.test/login')
  })

  // `open` can resolve without a browser appearing, in which case the catch in
  // loginViaBrowser never fires; the printed url is all the operator has left.
  it('prints the url even though pressing Enter would open it', () => {
    const prompt = browserLoginPrompt(HTTPS, 'blinky', true)
    expect(prompt.lines).toContain('  https://updates.test/login')
  })

  it('prints the code exactly as the registry sent it', () => {
    const odd = session({loginUrl: 'https://updates.test/login', userCode: 'bcdfghjk'})
    // Reformatting a value that is sent back would make a paste depend on the
    // registry stripping characters we invented.
    expect(text(browserLoginPrompt(odd, undefined, true))).toContain('bcdfghjk')
    expect(text(browserLoginPrompt(odd, undefined, true))).not.toContain('BCDF')
  })

  it('never offers to open a browser without a tty', () => {
    const prompt = browserLoginPrompt(HTTPS, 'blinky', false)
    expect(prompt.gate).toBeUndefined()
    expect(text(prompt)).toContain('Open this url in a browser to approve access for blinky:')
    expect(text(prompt)).toContain('  https://updates.test/login')
    expect(text(prompt)).toContain('Enter this when the page asks for a code:')
    expect(text(prompt)).toContain('BCDF-GHJK')
  })

  it('leads with the plaintext warning in both modes', () => {
    for (const interactive of [true, false]) {
      const lines = browserLoginPrompt(session(), undefined, interactive).lines
      expect(lines[1]).toContain('This registry is insecure')
    }
    expect(text(browserLoginPrompt(HTTPS, undefined, true))).not.toContain(
      'This registry is insecure',
    )
  })

  it('still gates on a registry that sends no user code', () => {
    const bare = session({loginUrl: 'https://updates.test/login', userCode: undefined})
    const prompt = browserLoginPrompt(bare, undefined, true)
    expect(prompt.gate?.url).toBe('https://updates.test/login')
    expect(text(prompt)).not.toContain('one-time code')
  })
})

describe('canOpenBrowser', () => {
  it('opens only for an interactive local terminal', () => {
    expect(canOpenBrowser({}, true)).toBe(true)
    expect(canOpenBrowser({}, undefined)).toBe(false)
    expect(canOpenBrowser({}, false)).toBe(false)
  })

  it('refuses over ssh, where the browser would open on the far end', () => {
    expect(canOpenBrowser({SSH_TTY: '/dev/pts/0'}, true)).toBe(false)
    expect(canOpenBrowser({SSH_CONNECTION: '10.0.0.2 22 10.0.0.1 22'}, true)).toBe(false)
  })

  it('refuses in agent mode, where nobody presses anything', () => {
    agent.mode = true
    try {
      expect(canOpenBrowser({}, true)).toBe(false)
    } finally {
      agent.mode = false
    }
  })
})

describe('ensureFileIgnored', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mikro-ignore-'))
    spawnSync('git', ['init', '-q'], {cwd: dir})
    // A committed identity so nothing here depends on the machine's git config.
    spawnSync('git', ['config', 'user.email', 't@t'], {cwd: dir})
    spawnSync('git', ['config', 'user.name', 't'], {cwd: dir})
  })
  afterEach(() => rmSync(dir, {recursive: true, force: true}))

  const ignored = (target: string): boolean =>
    spawnSync('git', ['check-ignore', '-q', target], {cwd: dir}).status === 0

  // The hole this closes: a partial .mikro/.gitignore that ignores something
  // else but not the token file left the fleet credential committable.
  it('covers the file when a pre-existing .gitignore does not', () => {
    const mikro = join(dir, '.mikro')
    mkdirSync(mikro)
    writeFileSync(join(mikro, '.gitignore'), 'build/\n')
    const target = join(mikro, 'registry.json')
    expect(ignored(target)).toBe(false)

    ensureFileIgnored(mikro, target)

    expect(ignored(target)).toBe(true)
    // The unrelated rule it already had is untouched.
    expect(readFileSync(join(mikro, '.gitignore'), 'utf8')).toContain('build/')
  })

  it('does nothing when a broad rule already covers the file', () => {
    const mikro = join(dir, '.mikro')
    mkdirSync(mikro)
    writeFileSync(join(mikro, '.gitignore'), '*\n')
    const target = join(mikro, 'registry.json')

    ensureFileIgnored(mikro, target)

    expect(readFileSync(join(mikro, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('does not duplicate its entry across repeated runs', () => {
    const mikro = join(dir, '.mikro')
    mkdirSync(mikro)
    const target = join(mikro, 'registry.json')
    ensureFileIgnored(mikro, target)
    ensureFileIgnored(mikro, target)
    const lines = readFileSync(join(mikro, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === 'registry.json')
    expect(lines).toHaveLength(1)
    expect(ignored(target)).toBe(true)
  })
})

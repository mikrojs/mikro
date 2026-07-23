import {spawnSync} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import * as pathlib from 'node:path'
import {createInterface} from 'node:readline/promises'
import {Writable} from 'node:stream'
import {setTimeout as sleep} from 'node:timers/promises'

import {command, constant, message, optional} from '@optique/core'
import {object} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {joinUrl} from '../../lib/otaPublish.js'
import {readProjectApp} from '../../lib/projectApp.js'
import {getMikroDir} from '../../lib/projectRoot.js'
import {readRegistryFile, REGISTRY_FILE} from '../../lib/registryConfig.js'

export const args = command(
  'setup',
  object({
    subcommand: constant('setup' as const),
    registry: optional(
      option('--registry', string({metavar: 'URL'}), {
        description: message`Registry base URL (skips the url prompt)`,
      }),
    ),
    token: optional(
      option('--token', string({metavar: 'TOKEN'}), {
        description: message`Registry token (skips the token prompt; with --registry, setup runs without prompts)`,
      }),
    ),
    user: optional(
      flag('--user', {
        description: message`Write ~/.mikro/registry.json (all projects) instead of the project's .mikro/registry.json`,
      }),
    ),
    force: optional(
      flag('--force', {
        description: message`Configure the url even if it does not identify as a Mikro.js registry`,
      }),
    ),
  }),
  {description: message`Configure which update registry to use (url and token)`},
)

type Args = InferValue<typeof args>

/** Prompt for one line. With `hidden`, keystrokes are not echoed (readline
 *  still manages the terminal; toggling raw mode by hand next to readline
 *  races the tty restore and can leak the secret to the screen). */
async function ask(prompt: string, options?: {hidden?: boolean}): Promise<string> {
  const output = options?.hidden === true ? new Writable({write: (_c, _e, cb) => cb()}) : undefined
  const rl = createInterface({
    input: process.stdin,
    output: output ?? process.stdout,
    terminal: true,
  })
  try {
    if (output !== undefined) process.stdout.write(prompt)
    const answer = (await rl.question(output === undefined ? prompt : '')).trim()
    if (output !== undefined) process.stdout.write('\n')
    return answer
  } catch {
    // Ctrl+C / Ctrl+D during the prompt
    // eslint-disable-next-line no-console
    console.error('\nAborted; nothing written.')
    process.exit(1)
  } finally {
    rl.close()
  }
}

/** Project paths relative to cwd, home paths as ~/…, anything else as is. */
function displayPath(path: string): string {
  const relative = pathlib.relative(process.cwd(), path)
  if (relative !== '' && !relative.startsWith('..')) return relative
  const home = homedir()
  return path.startsWith(home + pathlib.sep) ? `~${path.slice(home.length)}` : path
}

/**
 * Make sure `target` is ignored by git, so a secret written there cannot be
 * committed. Asks git rather than reparsing gitignore semantics, which honours a
 * `*`, a broader rule, or a project's own setup: only when git reports the file
 * is *not* ignored is a specific line appended to `<dir>/.gitignore`.
 */
export function ensureFileIgnored(dir: string, target: string): void {
  const ignorePath = pathlib.join(dir, '.gitignore')
  const check = spawnSync('git', ['check-ignore', '-q', target], {cwd: dir})
  // status 0: already ignored — leave everything as it is.
  if (check.status === 0) return
  // git missing, or not a git repo (status 128 / spawn error): nothing to leak
  // into today, but seed an ignore so a later `git init` does not expose it.
  if (check.error !== undefined || check.status === null || check.status === 128) {
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n', {mode: 0o600})
    return
  }
  // status 1: in a repo, and the file is not covered. Append a specific entry
  // rather than `*`, adding protection without claiming the whole directory.
  const base = pathlib.basename(target)
  const prev = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
  const alreadyListed = prev.split('\n').some((line) => line.trim() === base)
  if (alreadyListed) return
  const sep = prev === '' || prev.endsWith('\n') ? '' : '\n'
  writeFileSync(ignorePath, `${prev}${sep}${base}\n`, {mode: 0o600})
}

/** Reject obvious typos before the reachability probe: must parse as http(s). */
function validateUrl(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return `${input} is not a valid URL`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `The registry url must be http(s), got ${url.protocol}//`
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    // Devices refuse plaintext offers from a public host (see the allowInsecure
    // derivation in the ota example), so this would enroll a fleet that then
    // ignores every update. Catch it here rather than on the device.
    return `${url.hostname} is not on a private network, so http:// would leave build downloads unauthenticated. Use https://.`
  }
  return undefined
}

/** LAN/loopback/mDNS host: where the development registry runs. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  const p = host.split('.').map((s) => parseInt(s, 10))
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 10 || p[0] === 127) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  return p[0] === 172 && p[1]! >= 16 && p[1]! <= 31
}

/** A Mikro.js registry answers `GET <base>` with a JSON identity document whose
 *  `name` is `mikro-registry`. Recognize one by that marker alone; the rest of
 *  the document (e.g. a build version) is informational. Exported for its tests. */
export async function isRegistryResponse(res: Response): Promise<boolean> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false
  const body = (await res.json().catch(() => undefined)) as {name?: unknown} | undefined
  return body?.name === 'mikro-registry'
}

/** Probe reachability and registry identity in one request against the base url.
 *  `reachable` is true when anything answered; `isRegistry` is the identity-
 *  document check on that same response. */
async function probe(
  url: string,
): Promise<{reachable: boolean; isRegistry: boolean; detail?: string}> {
  try {
    // The identity document lives at the base url itself (like registry.npmjs.org),
    // so fetch what the user configured, not a subpath.
    const res = await fetch(url, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(5000),
    })
    return {reachable: true, isRegistry: await isRegistryResponse(res)}
  } catch (err) {
    const cause = err instanceof Error ? (err.cause ?? err) : err
    return {
      reachable: false,
      isRegistry: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

interface LoginSession {
  loginUrl: string
  code: string
  /** Short code the operator types on the approve page, binding this CLI to
   *  that browser. Absent on registries predating the binding. */
  userCode?: string
  expiresIn: number
  interval?: number
}

/** `unsupported` is the registry telling us it has no browser login (the
 *  404/405 discovery signal). A transport failure is NOT that, and must not be
 *  reported as a missing feature. Nor is `busy`: a registry caps how many
 *  logins may be pending at once (spec §5), and answering that with "pass a
 *  token instead" would send people hunting for one they do not need. */
type LoginStart =
  | {status: 'ok'; session: LoginSession}
  | {status: 'unsupported'}
  | {status: 'busy'; retryAfter?: number}
  | {status: 'failed'; detail: string}

/** Start a browser-login session (spec §5). Exported for its tests: the
 *  downgrade check below (an https registry must not point the login at a
 *  plaintext page) is a security boundary and deserves direct coverage. */
export async function startLoginSession(url: string, app: string | undefined): Promise<LoginStart> {
  let response: Response
  try {
    response = await fetch(joinUrl(url, 'api/v1/auth/sessions'), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(app === undefined ? {} : {app}),
      signal: AbortSignal.timeout(5000),
    })
  } catch (startError) {
    const cause = startError instanceof Error ? (startError.cause ?? startError) : startError
    return {status: 'failed', detail: cause instanceof Error ? cause.message : String(cause)}
  }
  if (response.status === 404 || response.status === 405) return {status: 'unsupported'}
  if (response.status === 429) {
    // Retry-After is seconds here (spec §5); a http-date form is not parsed,
    // and simply leaves the wait unquantified rather than misreported.
    const after = parseInt(response.headers.get('retry-after') ?? '', 10)
    return {status: 'busy', ...(Number.isInteger(after) && after > 0 ? {retryAfter: after} : {})}
  }
  if (!response.ok) {
    return {status: 'failed', detail: `the registry answered ${response.status}`}
  }
  const body = (await response.json().catch(() => ({}))) as Partial<LoginSession>
  if (typeof body.loginUrl !== 'string' || typeof body.code !== 'string') {
    return {status: 'failed', detail: 'the registry returned an unusable login session'}
  }
  // The only login url we refuse is a downgrade: an https registry must not send
  // the operator to a plaintext http:// page to type the credential into (that
  // credential mints publish and enroll tokens for the whole fleet). We do not
  // pin the login to the registry's origin. On https a split api/dashboard
  // deployment legitimately approves on another origin, and TLS authenticates
  // that the registry we chose named it. On http the response is unauthenticated
  // anyway, and http is only allowed on a private network, so the login url is
  // trusted to the same degree as everything else on that connection; an origin
  // pin there would only police one hole in an already-open channel.
  let loginUrl: URL
  try {
    loginUrl = new URL(body.loginUrl)
  } catch {
    return {
      status: 'failed',
      detail: `the registry returned an unusable login url: ${body.loginUrl}`,
    }
  }
  // The operator opens this in a browser, so it must be http(s). Reject data:,
  // javascript:, file: and the like, which parse to a defined "null" origin and
  // so slip past the parse above. Branch on the parsed protocol, not the raw
  // string, so an uppercase HTTP:// cannot bypass the downgrade check below.
  if (loginUrl.protocol !== 'http:' && loginUrl.protocol !== 'https:') {
    return {
      status: 'failed',
      detail: `the registry returned an unusable login url: ${body.loginUrl}`,
    }
  }
  if (new URL(url).protocol === 'https:' && loginUrl.protocol === 'http:') {
    return {
      status: 'failed',
      detail: `the registry pointed the login at an insecure page (${loginUrl.origin}); the login url must use https`,
    }
  }
  return {
    status: 'ok',
    session: {
      loginUrl: body.loginUrl,
      code: body.code,
      ...(typeof body.userCode === 'string' ? {userCode: body.userCode} : {}),
      expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 600,
      ...(typeof body.interval === 'number' ? {interval: body.interval} : {}),
    },
  }
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

/** The user code, boxed on its own line. Printed exactly as the registry sent
 *  it: the operator sends this string back, so injecting spaces for legibility
 *  would make a paste depend on the registry stripping characters we invented,
 *  rather than only the ones it chose to emit. Prominence comes from the box
 *  and the surrounding blank lines instead. Width is measured on the unstyled
 *  string, since the escapes take no columns. */
function codeBlock(code: string): string[] {
  const rule = '─'.repeat(code.length + 6)
  return [`┌${rule}┐`, `│   ${bold(code)}   │`, `└${rule}┘`]
}

/* eslint-disable no-console -- interactive flow; console is its UI */

/** Show the auth url, then poll until the login is approved in the browser
 *  and the registry hands over the minted token. */
async function loginViaBrowser(
  url: string,
  session: LoginSession,
  app: string | undefined,
): Promise<string> {
  console.log('')
  // The device side warns about a plaintext registry on every boot. This flow
  // carries more than a device credential does: the password typed into that
  // page mints publish and enroll tokens for the whole fleet, and both it and
  // the minted token cross the wire in the clear. Say so at the point it
  // happens rather than leaving it to the reader of a docs page.
  if (new URL(session.loginUrl).protocol === 'http:') {
    console.log(
      '\x1b[33m!\x1b[0m This registry is http://, so the password you enter and the token it ' +
        'mints travel unencrypted.\n  Anyone on this network can read them. Use https:// for ' +
        'anything but local development.',
    )
    console.log('')
  }
  console.log(
    `Open this url in a browser to approve access${app === undefined ? '' : ` for ${app}`}:`,
  )
  console.log('')
  console.log(`  ${session.loginUrl}`)
  if (session.userCode !== undefined) {
    // The page asks for this. It is what stops someone else's login url from
    // being approved by you: a link you did not start shows a code you never saw.
    console.log('')
    console.log('Enter this when the page asks for a code:')
    console.log('')
    for (const line of codeBlock(session.userCode)) console.log(`  ${line}`)
  }
  console.log('')
  console.log('Waiting for approval… (Ctrl+C to abort)')

  const deadline = Date.now() + session.expiresIn * 1000
  const interval = Math.max(1, session.interval ?? 3) * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    const response = await fetch(joinUrl(url, `api/v1/auth/sessions/${session.code}/token`), {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
    // Not yet approved, unreachable for a moment, rate-limited, or a server
    // hiccup: none of these mean the login failed, so keep polling until the
    // session's own deadline decides.
    if (response === undefined || response.status === 202) continue
    if (response.status === 429 || response.status >= 500) continue
    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as {token?: unknown}
      if (typeof body.token === 'string' && body.token !== '') {
        console.log('Approved.')
        return body.token
      }
    }
    console.error('Error: the login was denied or expired; re-run mikro ota setup.')
    process.exit(1)
  }
  console.error('Error: the login expired before it was approved; re-run mikro ota setup.')
  process.exit(1)
}

/* eslint-enable no-console */

export async function run(config: Args): Promise<void> {
  /* eslint-disable no-console -- interactive command; console is its UI */
  const filePath = config.user
    ? pathlib.join(homedir(), '.mikro', REGISTRY_FILE)
    : pathlib.join(getMikroDir(), REGISTRY_FILE)
  const app = config.user ? undefined : readProjectApp()
  const scope = config.user ? 'every project (user-level)' : (app ?? 'this project')
  const existing = readRegistryFile(filePath)

  console.log(`Configuring the update registry for ${scope}`)

  let url = config.registry ?? ''
  if (url === '') {
    if (!process.stdin.isTTY) {
      console.error(
        'Error: pass --registry, or run setup in an interactive terminal so it can prompt for the url.',
      )
      process.exit(1)
    }
    const urlPrompt =
      existing.url === undefined ? 'Registry url: ' : `Registry url [${existing.url}]: `
    url = await ask(urlPrompt)
    if (url === '' && existing.url !== undefined) url = existing.url
  }
  if (url === '') {
    console.error('Error: a registry url is required')
    process.exit(1)
  }
  const urlError = validateUrl(url)
  if (urlError !== undefined) {
    console.error(`Error: ${urlError}`)
    process.exit(1)
  }
  url = url.replace(/\/+$/, '')

  const {reachable, isRegistry, detail} = await probe(url)
  if (!reachable) {
    console.warn(`Warning: could not reach ${url} (${detail})`)
    if (!config.force && process.stdin.isTTY) {
      const save = await ask('Save anyway? (y/N) ')
      if (save.toLowerCase() !== 'y') {
        console.error('Aborted; nothing written.')
        process.exit(1)
      }
    }
  } else if (!isRegistry) {
    // A reachable url with no registry identity document is most likely a typo or
    // the wrong host, caught here rather than at the first publish or enroll. Warn
    // rather than hard-fail: it could sit behind a proxy that rewrites the root, so
    // --force (or "yes" at the prompt) proceeds anyway.
    console.warn(`Warning: ${url} responded but does not identify as a Mikro.js registry`)
    if (!config.force) {
      if (process.stdin.isTTY) {
        const cont = await ask('Configure it anyway? (y/N) ')
        if (cont.toLowerCase() !== 'y') {
          console.error('Aborted; nothing written.')
          process.exit(1)
        }
      } else {
        console.error(
          'Error: this does not look like a registry; pass --force to configure it anyway.',
        )
        process.exit(1)
      }
    }
  }

  // Token: --token, else browser login when the registry offers it, else a
  // hidden prompt. A user-level token spans projects, so no app context then.
  let token = config.token ?? ''
  if (token === '') {
    const started = await startLoginSession(url, app)
    // A transport failure is a real error, not "no browser login here". Saying
    // otherwise sends people hunting for a token they do not need.
    if (started.status === 'failed') {
      console.error(`Error: could not reach ${url} to start a login: ${started.detail}`)
      process.exit(1)
    }
    if (started.status === 'busy') {
      const wait =
        started.retryAfter === undefined ? 'in a moment' : `in ${started.retryAfter} seconds`
      console.error(`Error: ${url} has too many logins waiting; run mikro ota setup again ${wait}.`)
      process.exit(1)
    }
    if (started.status === 'ok') {
      token = await loginViaBrowser(url, started.session, app)
    } else {
      if (!process.stdin.isTTY) {
        console.error(
          'Error: this registry does not offer browser login; pass --token, or run setup in an interactive terminal to enter one.',
        )
        process.exit(1)
      }
      const tokenPrompt =
        existing.token === undefined
          ? 'Registry token: '
          : 'Registry token (leave empty to keep the current one): '
      token = await ask(tokenPrompt, {hidden: true})
      if (token === '' && existing.token !== undefined) token = existing.token
      if (token === '') {
        console.error('Error: a registry token is required')
        process.exit(1)
      }
    }
  }

  // The file holds a secret: owner-only, and ignored by git on the way in.
  // writeFileSync's `mode` only applies when it creates the file, so an existing
  // (or hand-created) 0644 file would keep its mode on every later setup run.
  const dir = pathlib.dirname(filePath)
  mkdirSync(dir, {recursive: true, mode: 0o700})
  // The file holds a fleet-wide publish and enrol token, so it must not be
  // committable. `.mikro/` is only gitignored in create-mikro scaffolds; a repo
  // that adopted mikro later, or one with a partial `.mikro/.gitignore` that
  // does not cover this file, would commit it in plaintext, and file mode does
  // not stop that. Gating on whether a `.gitignore` merely exists missed the
  // partial case, so ask git itself.
  ensureFileIgnored(dir, filePath)
  writeFileSync(filePath, `${JSON.stringify({url, token}, null, 2)}\n`, {mode: 0o600})
  chmodSync(filePath, 0o600)

  console.log(`Saved ${displayPath(filePath)}`)
  console.log('mikro ota enroll and mikro ota push will use it from here.')
  /* eslint-enable no-console */
  process.exit(0)
}

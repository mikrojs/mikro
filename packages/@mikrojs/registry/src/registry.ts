import semver from 'semver'

import type {BuildRecord, DeviceRecord, Registry, RegistryOptions, TokenRecord} from './types.js'
import {
  bearerToken,
  CLIENT_IP_HEADER,
  error,
  escapeHtml,
  html,
  isSameOriginPost,
  json,
  normalizeUserCode,
  randomSecret,
  randomUserCode,
  readCappedBody,
  REGISTRY_NAME,
  secretsMatch,
  sha256Hex,
} from './util.js'

const CHECKSUM_RE = /^[0-9a-f]{64}$/

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000
/** Live browser logins held at once. Creating one is unauthenticated, so
 *  without a ceiling anyone can grow the map indefinitely. Far above what real
 *  use reaches: each lives ten minutes and one operator starts one at a time. */
const MAX_LOGIN_SESSIONS = 500
/** Pending logins one address may hold. A workstation runs one `ota setup` at
 *  a time; the slack is for a retried or abandoned run whose session has not
 *  yet expired. */
const MAX_LOGIN_SESSIONS_PER_IP = 5
const LOGIN_POLL_INTERVAL_S = 3

/** Minted tokens expire, so a leaked one stops working even when nobody
 *  noticed it leaked. Long enough not to interrupt a project mid-cycle. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** `lastUsedAt` is a coarse "still in use" signal, not an audit trail: one
 *  storage write per token per minute instead of one per request. */
const TOKEN_USE_WRITE_INTERVAL_MS = 60 * 1000

/** Free approval attempts before backoff, per address and process-wide. The
 *  global counter is what a distributed guess runs into. */
const APPROVE_IP_FREE_ATTEMPTS = 3
const APPROVE_GLOBAL_FREE_ATTEMPTS = 30
const APPROVE_BACKOFF_MAX_MS = 60 * 1000
/** Idle time after which a failure count is forgotten. Long enough that
 *  waiting out the capped backoff does not reset the count. */
const APPROVE_FORGET_MS = 60 * 60 * 1000
/** Addresses tracked at once. Buckets are created by unauthenticated requests,
 *  so an attacker with a wide address range would otherwise grow the map
 *  without bound; the least recently active is dropped first. */
const MAX_APPROVE_BUCKETS = 10_000

/** Ceiling for the login routes, which are unauthenticated and buffer a body
 *  before anything can validate it. Publish is exempt: it carries a build, and
 *  the host adapter caps that one. Generous next to a session or approve form. */
const MAX_LOGIN_BODY_BYTES = 64 * 1024

/** Caps on device-reported strings; a device must not be able to grow its own
 *  record without bound. Generous next to real values. */
const MAX_DEVICE_ID_LENGTH = 128
const MAX_NAME_LENGTH = 64
const MAX_APP_LENGTH = 64
const MAX_VERSION_LENGTH = 64
const MAX_REASON_LENGTH = 64
const MAX_DETAIL_LENGTH = 256
const MAX_NOTE_LENGTH = 512
/** Retained failure reports per device, newest kept. */
const MAX_FAILED_CHECKSUMS = 16
/** Highest name revision a device may report. Rule 4b answers a tie with
 *  `ourRev + 1`, which stops incrementing near `MAX_SAFE_INTEGER`, so a device
 *  reporting a huge revision could otherwise pin a name the registry can never
 *  win back. Astronomically above what renaming reaches. */
const MAX_NAME_REV = Number.MAX_SAFE_INTEGER / 2

/** What an accepted bearer may do. `app` present: publishing and device access
 *  are limited to that app. `admin` is the configured registry secret (or
 *  `verifyAdmin`); minted tokens are never admins, so they cannot manage
 *  other tokens. */
interface Grant {
  app?: string
  admin: boolean
}

/** A pending browser login. Held in memory: sessions live minutes, and an
 *  interrupted one is just re-run. The minted token is stored hashed; only
 *  the approved-but-unclaimed window holds its plaintext, here. */
interface LoginSession {
  app?: string
  /** Short code the CLI displays and the operator retypes on the approve page.
   *  This is what binds the approving browser to the CLI that started the
   *  session: a forwarded `loginUrl` is useless without it. */
  userCode: string
  expiresAt: number
  token?: string
  /** Set alongside `token`, so a session that expires before the CLI claims it
   *  can take the now-unreachable token record with it. */
  tokenHash?: string
  /** Peer address that opened the session, when the host surfaces one. Only
   *  used to bound how many slots one address may hold. */
  ip?: string
}

/** Failed approval attempts for one bucket (an address, or the process). */
interface Attempts {
  fails: number
  until: number
  lastFail: number
}

/**
 * Create a registry as a portable fetch handler. Implements the required
 * contract (publish, build download with Range, enroll + re-mint, browser
 * login) and the advisory reference check-in protocol from
 * docs/registry-spec.md. No orgs, no config sync; the `create` publish field
 * is accepted and ignored (apps are created implicitly on first publish).
 */
export function createRegistry(options: RegistryOptions): Registry {
  const {storage} = options
  if (options.token === undefined && options.verifyAdmin === undefined) {
    throw new Error('createRegistry needs a `token` or a `verifyAdmin` implementation')
  }
  // Browser login authenticates approvals with the static secret, so it is
  // only served under built-in token auth; its 404 under custom auth is the
  // spec's "not supported" signal.
  const loginEnabled = options.verifyAdmin === undefined
  const loginSessions = new Map<string, LoginSession>()
  /** Normalized userCode -> session code. The approve page looks sessions up by
   *  the code the operator typed, and minting has to check the code is unused;
   *  both would otherwise scan every live session, making an unauthenticated
   *  endpoint quadratic. */
  const loginByUserCode = new Map<string, string>()
  const approveByIp = new Map<string, Attempts>()
  /** Bearer auth for the static admin secret is throttled per address, on its
   *  own buckets: a lockout earned guessing the API must not touch the approve
   *  page, or vice versa. No global bucket here — see grantFor for why a shared
   *  one would let a guesser lock every operator out. */
  const authByIp = new Map<string, Attempts>()
  const approveGlobal: Attempts = {fails: 0, until: 0, lastFail: 0}

  async function sweepLoginSessions(): Promise<void> {
    const now = Date.now()
    for (const [code, session] of loginSessions) {
      if (session.expiresAt <= now) {
        loginSessions.delete(code)
        loginByUserCode.delete(normalizeUserCode(session.userCode))
        // Approved but never claimed: the plaintext dies with the session, so
        // the record is unusable and would only accumulate in token listings.
        if (session.tokenHash !== undefined) await storage.deleteToken(session.tokenHash)
      }
    }
  }

  async function grantFor(request: Request): Promise<Grant | undefined> {
    if (options.verifyAdmin) {
      return (await options.verifyAdmin(request)) ? {admin: true} : undefined
    }
    const bearer = bearerToken(request)
    if (bearer === undefined || bearer === '') return undefined
    const now = Date.now()

    // Minted tokens are 256-bit and looked up by hash in O(1): unguessable, so
    // never rate-limited, and checked FIRST. A valid operator token must
    // authenticate even while someone is guessing the admin secret — charging
    // the token path against a shared bucket is what let junk `Bearer x`
    // requests lock every operator out.
    const minted = await storage.getTokenByHash(await sha256Hex(bearer))
    if (minted !== undefined) {
      const expiresAt = Date.parse(minted.expiresAt ?? '')
      // An unparseable or missing expiry reads as expired, so a record written
      // before expiries existed fails closed rather than living forever.
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined
      const lastUsedAt = Date.parse(minted.lastUsedAt ?? '')
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt >= TOKEN_USE_WRITE_INTERVAL_MS) {
        await storage.putToken({...minted, lastUsedAt: new Date(now).toISOString()})
      }
      return minted.app === undefined ? {admin: false} : {app: minted.app, admin: false}
    }

    // The operator-chosen static secret is the only guessable credential, so it
    // is the only path throttled. Per address, never globally: a run of wrong
    // guesses slows further guesses from the same address, but no address — and
    // no distributed guess — can refuse a request from another, so operators are
    // never locked out (registry-spec, approve-path rule: a correct credential
    // passes regardless of a bucket's state). A host that surfaces no client
    // address gets no throttle here, the same limitation the approve page
    // documents; the answer is a strong generated secret, per the README.
    if (options.token === undefined) return undefined
    sweepApproveAttempts(now)
    const ip = request.headers.get(CLIENT_IP_HEADER)
    let perIp = ip !== null ? authByIp.get(ip) : undefined
    if (perIp !== undefined && perIp.until > now) return undefined
    if (await secretsMatch(bearer, options.token)) {
      if (perIp !== undefined) refundFailure(perIp, APPROVE_IP_FREE_ATTEMPTS, now)
      return {admin: true}
    }
    if (ip !== null) {
      if (perIp === undefined) {
        perIp = {fails: 0, until: 0, lastFail: 0}
        evictApproveBucket(authByIp)
        authByIp.set(ip, perIp)
      }
      recordFailure(perIp, APPROVE_IP_FREE_ATTEMPTS, now)
    }
    return undefined
  }

  async function deviceIdFor(request: Request): Promise<string | undefined> {
    if (options.verifyDevice) return options.verifyDevice(request)
    const credential = bearerToken(request)
    if (credential === undefined) return undefined
    const device = await storage.getDeviceByCredentialHash(await sha256Hex(credential))
    return device?.deviceId
  }

  // ── Publish ──────────────────────────────────────────────────────

  async function handlePublish(request: Request): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return error('Expected multipart/form-data', 400)
    }
    const text = (name: string) => {
      const value = form.get(name)
      return typeof value === 'string' ? value : undefined
    }

    const app = text('app')
    const version = text('version')
    const checksum = text('checksum')
    const size = parseInt(text('size') ?? '', 10)
    const firmwareVersion = text('firmwareVersion')
    const bytecodeVersion = parseInt(text('bytecodeVersion') ?? '', 10)
    const note = text('note')
    const file = form.get('build')

    if (!app || !version || !firmwareVersion) {
      return error('Missing app, version, or firmwareVersion', 400)
    }
    if (grant.app !== undefined && grant.app !== app) {
      return error(`This token may only publish ${grant.app}`, 403)
    }
    // Cap what goes into the index, the same way check-in fields are capped.
    // These are stored verbatim and re-serialised on every publish and read on
    // every check-in, so an uncapped field turns a publish token — scoped to
    // one app — into a lever on the whole registry's availability.
    if (app.length > MAX_APP_LENGTH) {
      return error(`app must be at most ${MAX_APP_LENGTH} characters`, 400)
    }
    if (version.length > MAX_VERSION_LENGTH) {
      return error(`version must be at most ${MAX_VERSION_LENGTH} characters`, 400)
    }
    if (firmwareVersion.length > MAX_VERSION_LENGTH) {
      return error(`firmwareVersion must be at most ${MAX_VERSION_LENGTH} characters`, 400)
    }
    // Validated with the same library that compares it, so the two cannot
    // disagree about what a version is. This is the only place a bad value can
    // be caught -- the device does not second-guess compatibility -- and an
    // unvalidated one would not fail, it would silently widen the gate.
    if (semver.valid(firmwareVersion) === null) {
      return error('firmwareVersion must be a semver version like 1.2.3', 400)
    }
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
      return error(`note must be at most ${MAX_NOTE_LENGTH} characters`, 400)
    }
    if (!checksum || !CHECKSUM_RE.test(checksum)) return error('Invalid checksum', 400)
    if (!Number.isInteger(size) || size < 0) return error('Invalid size', 400)
    if (!Number.isInteger(bytecodeVersion)) return error('Invalid bytecodeVersion', 400)
    if (!(file instanceof Blob)) return error('Missing build file', 400)

    // Release immutability: same (app, version, bytecodeVersion) with the
    // same checksum is an idempotent success (CI retry-safe); a different
    // checksum is a conflict, so bump the version instead.
    const builds = await storage.listBuilds()
    // Builds are stored by checksum, so identical bytes under two apps would
    // leave one record and silently strand the other app's devices — they would
    // be offered nothing, with no error anywhere. Reproducible packing makes
    // that reachable: two apps scaffolded from the same starter and packed
    // before they diverge produce the same archive byte for byte. Refuse loudly
    // rather than storing something that cannot represent both.
    const owned = builds.find((b) => b.checksum === checksum && b.app !== app)
    if (owned !== undefined) {
      return error(`This build is already published under ${owned.app}`, 409)
    }
    // Strictly after every build already published for this (app, bytecode),
    // so promotion is a total order even when two publishes land in the same
    // millisecond. A wall-clock timestamp alone leaves ties, and a tie is the
    // one case where "the current build" has no answer.
    // reduce, not Math.max(...spread): the argument list is the build history
    // for this app, and a spread of it blows the call stack once that history
    // is large enough, which would break publishing permanently rather than
    // slowly (nothing deletes builds, so the count only grows).
    const promotedAt = new Date(
      builds.reduce((latest, b) => {
        if (b.app !== app || b.bytecodeVersion !== bytecodeVersion) return latest
        const at = Date.parse(b.promotedAt ?? b.createdAt) + 1
        return Number.isFinite(at) && at > latest ? at : latest
      }, Date.now()),
    ).toISOString()

    const existing = builds.find(
      (b) => b.app === app && b.version === version && b.bytecodeVersion === bytecodeVersion,
    )
    if (existing) {
      if (existing.checksum !== checksum) {
        return error(
          `Release ${app}@${version} (bytecode ${bytecodeVersion}) already exists with a different checksum`,
          409,
        )
      }
      // Re-store the bytes when the record outlived its blob (an index restored
      // from backup, a half-finished migration). Re-publishing is the obvious
      // response to downloads 404ing, so it must not be a silent no-op.
      if ((await storage.getBlob(checksum)) === undefined) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if ((await sha256Hex(bytes)) !== checksum) {
          return error('Uploaded build does not match the checksum field', 400)
        }
        await storage.putBlob(checksum, bytes)
      }
      // Idempotent in what it stores, but it still promotes: re-publishing an
      // earlier release is how a fleet is rolled back.
      await storage.putBuild({...existing, promotedAt})
      return json({ok: true})
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    if ((await sha256Hex(bytes)) !== checksum) {
      return error('Uploaded build does not match the checksum field', 400)
    }
    if (bytes.byteLength !== size) {
      return error('Uploaded build does not match the size field', 400)
    }

    await storage.putBlob(checksum, bytes)
    const record: BuildRecord = {
      checksum,
      app,
      version,
      bytecodeVersion,
      firmwareVersion,
      size,
      createdAt: new Date().toISOString(),
      promotedAt,
    }
    if (note !== undefined) record.note = note
    await storage.putBuild(record)
    return json({ok: true}, 201)
  }

  // ── Download ─────────────────────────────────────────────────────

  /**
   * A device credential, not a token: only enrolled devices pull builds, and
   * only their own app's. A checksum is not a secret — it appears in publish
   * output and CI logs — so without the credential anyone holding one reads the
   * build, and without the app check any *one* enrolled device reads every
   * other app's on a shared
   * registry. This is the binding selectOffer enforces, applied to the transfer
   * itself.
   *
   * 404 rather than 403 once past auth: which builds exist is not something a
   * device that may not have this one should be able to probe for. An unbound
   * device matches nothing, the same answer selectOffer gives it.
   *
   * A registry serving builds from object storage should hand out a signed url
   * at check-in rather than relaxing this: `offer.url` is opaque to the device,
   * so that needs no protocol change.
   */
  async function handleDownload(request: Request, checksum: string): Promise<Response> {
    const deviceId = await deviceIdFor(request)
    if (deviceId === undefined) return error('Unauthorized', 401)
    if (!CHECKSUM_RE.test(checksum)) return error('Not found', 404)

    // Authorize before touching the bytes. The answer is the same either way,
    // but reading first means an enrolled device can make the registry load a
    // whole build it will never receive — a synchronous read of up to the full
    // file on the file-backed storage — once per request, for any checksum.
    const build = await storage.getBuild(checksum)
    const device = await storage.getDevice(deviceId)
    if (build === undefined || device?.app === undefined || device.app !== build.app) {
      return error('Not found', 404)
    }

    const blob = await storage.getBlob(checksum)
    if (blob === undefined) return error('Not found', 404)

    const etag = `"${checksum}"`
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, {status: 304, headers: {etag}})
    }

    const headers: Record<string, string> = {
      'content-type': 'application/gzip',
      'accept-ranges': 'bytes',
      etag,
    }

    const range = request.headers.get('range')
    const total = blob.byteLength
    // A Range this endpoint cannot parse (another unit, a multi-range set, or
    // plain junk) is ignored rather than rejected, per RFC 9110 section 14.2.
    // Only a well-formed but unsatisfiable one gets a 416.
    const match = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match && !(match[1] === '' && match[2] === '')) {
      const suffix = match[1] === ''
      // A suffix longer than the blob means the whole blob, not an error.
      const start = suffix ? Math.max(0, total - parseInt(match[2]!, 10)) : parseInt(match[1]!, 10)
      const end =
        !suffix && match[2] !== '' ? Math.min(parseInt(match[2]!, 10), total - 1) : total - 1
      if (start > end || start >= total) {
        return new Response(null, {status: 416, headers: {'content-range': `bytes */${total}`}})
      }
      const slice = blob.slice(start, end + 1)
      return new Response(slice, {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': String(slice.byteLength),
        },
      })
    }

    return new Response(blob, {
      headers: {...headers, 'content-length': String(blob.byteLength)},
    })
  }

  // ── Enroll + re-mint ─────────────────────────────────────────────

  function deviceView(device: DeviceRecord): Record<string, unknown> {
    const {credentialHash: _hash, ...view} = device
    return view
  }

  /** Resolve a device an app-scoped grant is allowed to act on. A device
   *  outside the grant's app reads as absent, so a scoped token cannot use
   *  these routes to learn that another app's devices exist. */
  async function deviceForGrant(grant: Grant, deviceId: string): Promise<DeviceRecord | undefined> {
    const device = await storage.getDevice(deviceId)
    if (device === undefined) return undefined
    if (grant.app !== undefined && device.app !== grant.app) return undefined
    return device
  }

  /** Every device handler does read → await → write, so two of them overlapping
   *  means the second write is computed from a record the first already
   *  replaced and its whole update is lost. Concretely: a check-in reads the
   *  device, awaits several more times, then writes back a record still
   *  carrying the OLD credentialHash — silently undoing a re-mint that landed in
   *  between, so a revoked (possibly leaked) credential starts working again and
   *  the operator's replacement does not. Enroll has its own version: two
   *  concurrent enrolls of one id both clear the 409 and both write, and the
   *  loser's CLI walks away holding a credential the registry no longer accepts.
   *
   *  Serializing keeps each read adjacent to its write without adding a
   *  compare-and-set to RegistryStorage. One queue for all devices rather than
   *  one per device: a reference registry for a small fleet does not need the
   *  concurrency, and a single queue cannot deadlock or leak entries.
   *  Single-process only, like the login flow. */
  let deviceWriteQueue: Promise<unknown> = Promise.resolve()
  function serializeDeviceWrite(run: () => Promise<Response>): Promise<Response> {
    const next = deviceWriteQueue.then(run, run)
    deviceWriteQueue = next.catch(() => undefined)
    return next
  }

  async function handleEnroll(request: Request): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)

    let body: {deviceId?: unknown; name?: unknown; app?: unknown}
    try {
      body = (await request.json()) as typeof body
    } catch {
      return error('Expected a JSON body', 400)
    }
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    if (deviceId === '') return error('deviceId must be a non-empty string', 400)
    if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return error(`deviceId must be at most ${MAX_DEVICE_ID_LENGTH} characters`, 400)
    }
    const requestedApp = typeof body.app === 'string' ? body.app.trim() : ''
    if (grant.app !== undefined && requestedApp !== '' && requestedApp !== grant.app) {
      return error(`This token may only enroll devices for ${grant.app}`, 403)
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length > MAX_NAME_LENGTH) {
      return error(`name must be at most ${MAX_NAME_LENGTH} characters`, 400)
    }
    // Deliberately a global lookup, unlike the other device routes: enrolling
    // a device that already exists must never overwrite it, whoever asks. The
    // cost is that 409-vs-201 tells an app-scoped caller that some id is taken
    // outside its app. Closing that would mean keying devices by (app,
    // deviceId), which is wrong for what a deviceId is: a hardware id, unique
    // across the fleet. The disclosure is accepted instead, since it needs a
    // valid token and a guessed hardware id, and reveals only that the id is
    // in use.
    if (await storage.getDevice(deviceId)) {
      return error('A device with this id is already enrolled. Re-mint its credential instead', 409)
    }

    const credential = `dvc_${randomSecret()}`
    const device: DeviceRecord = {
      deviceId,
      credentialHash: await sha256Hex(credential),
      failedChecksums: [],
    }
    // Enrollment is the only place a binding is ever set: it is never inferred
    // later from what the device reports. Enrolling without one is allowed and
    // leaves the device offered nothing until it is re-enrolled with an app.
    const app = grant.app ?? (requestedApp === '' ? undefined : requestedApp)
    if (app !== undefined) device.app = app
    if (name !== '') device.name = name
    await storage.putDevice(device)
    // The credential appears exactly once, here; only its hash is stored.
    return json({device: deviceView(device), credential}, 201)
  }

  async function handleRemint(request: Request, deviceId: string): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)
    const device = await deviceForGrant(grant, deviceId)
    if (device === undefined) return error('Unknown device', 404)

    const credential = `dvc_${randomSecret()}`
    await storage.putDevice({...device, credentialHash: await sha256Hex(credential)})
    return json({credential})
  }

  /** Clear a device's failure list, so a build that failed for a reason since
   *  fixed (a full filesystem, a bad network) can be offered again. */
  async function handleClearFailures(request: Request, deviceId: string): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)
    const device = await deviceForGrant(grant, deviceId)
    if (device === undefined) return error('Unknown device', 404)
    await storage.putDevice({...device, failedChecksums: []})
    return json({ok: true})
  }

  async function handleListDevices(request: Request): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)
    const devices = await storage.listDevices()
    const visible = grant.app === undefined ? devices : devices.filter((d) => d.app === grant.app)
    return json({devices: visible.map(deviceView)})
  }

  // ── Token management ─────────────────────────────────────────────

  async function handleListTokens(request: Request): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)
    if (!grant.admin) return error('Only the registry secret may manage tokens', 403)
    // Hashes, not tokens: this is how an operator addresses one to revoke it.
    return json({tokens: await storage.listTokens()})
  }

  async function handleRevokeToken(request: Request, tokenHash: string): Promise<Response> {
    const grant = await grantFor(request)
    if (grant === undefined) return error('Unauthorized', 401)
    if (!grant.admin) return error('Only the registry secret may manage tokens', 403)
    if ((await storage.getTokenByHash(tokenHash)) === undefined) {
      return error('Unknown token', 404)
    }
    await storage.deleteToken(tokenHash)
    return json({ok: true})
  }

  // ── Browser login (spec §5) ──────────────────────────────────────

  async function handleCreateLoginSession(request: Request): Promise<Response> {
    await sweepLoginSessions()
    // The global cap alone is a lockout lever, not a defence: this endpoint is
    // unauthenticated, so anyone who can reach it can fill all 500 slots and
    // hold every legitimate `mikro ota setup` at 429 for the session lifetime,
    // re-arming as fast as the sweep frees them. Bound each address first, so
    // exhausting the global cap takes a distributed effort rather than a loop.
    const ip = request.headers.get(CLIENT_IP_HEADER)
    if (ip !== null) {
      let mine = 0
      for (const session of loginSessions.values()) if (session.ip === ip) mine++
      if (mine >= MAX_LOGIN_SESSIONS_PER_IP) {
        return error('Too many pending logins from this address', 429, {'retry-after': '60'})
      }
    }
    if (loginSessions.size >= MAX_LOGIN_SESSIONS) {
      return error('Too many pending logins, try again shortly', 429, {'retry-after': '60'})
    }
    // Claim the slot before the first await, or the caps above bound round
    // trips rather than sessions: everything below yields, so concurrent
    // callers would each pass the check and insert together, and a burst from
    // one address takes the whole table. Same rule the approve buckets follow.
    const code = randomSecret()
    const session: LoginSession = {
      userCode: freshUserCode(),
      expiresAt: Date.now() + LOGIN_SESSION_TTL_MS,
    }
    if (ip !== null) session.ip = ip
    loginSessions.set(code, session)
    loginByUserCode.set(normalizeUserCode(session.userCode), code)

    function releaseSlot(): void {
      loginSessions.delete(code)
      loginByUserCode.delete(normalizeUserCode(session.userCode))
    }

    const raw = await readCappedBody(request, MAX_LOGIN_BODY_BYTES)
    if (raw === undefined) {
      releaseSlot()
      return error('Request body too large', 413)
    }
    try {
      const body = JSON.parse(new TextDecoder().decode(raw)) as {app?: unknown}
      if (typeof body.app === 'string' && body.app.trim() !== '') {
        const candidate = body.app.trim()
        // Bounded and charset-constrained, unlike the other fields here,
        // because this endpoint is unauthenticated and the value is both
        // retained for the session's lifetime and rendered into the sentence
        // the operator reads before approving. Escaping stops it being markup;
        // this stops it being prose.
        if (candidate.length > MAX_APP_LENGTH || !/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
          releaseSlot()
          return error('Invalid app', 400)
        }
        session.app = candidate
      }
    } catch {
      // No body / not JSON: a session without app context.
    }
    const origin = options.baseUrl ?? new URL(request.url).origin
    // `userCode` is displayed by the CLI that asked for the session and typed
    // by the operator; the endpoint is unauthenticated, so this pair is the
    // only thing tying the approving browser back to that CLI.
    return json(
      {
        loginUrl: `${origin}/login`,
        code,
        userCode: session.userCode,
        expiresIn: LOGIN_SESSION_TTL_MS / 1000,
        interval: LOGIN_POLL_INTERVAL_S,
      },
      201,
      {'cache-control': 'no-store'},
    )
  }

  /** Backoff for a bucket that has just failed again, or 0 while it still has
   *  free attempts. Doubles per failure past the threshold, up to the cap. */
  function recordFailure(attempts: Attempts, freeAttempts: number, now: number): void {
    attempts.fails += 1
    attempts.lastFail = now
    const over = attempts.fails - freeAttempts
    attempts.until = over <= 0 ? 0 : now + Math.min(1000 * 2 ** (over - 1), APPROVE_BACKOFF_MAX_MS)
  }

  /** Give back the attempt an admitted request reserved, once it turns out not
   *  to have been a guess. Net zero rather than a reset: replaying such a step
   *  between password guesses must not walk the backoff back. */
  function refundFailure(attempts: Attempts, freeAttempts: number, now: number): void {
    attempts.fails = Math.max(0, attempts.fails - 1)
    const over = attempts.fails - freeAttempts
    attempts.until = over <= 0 ? 0 : now + Math.min(1000 * 2 ** (over - 1), APPROVE_BACKOFF_MAX_MS)
  }

  function sweepApproveAttempts(now: number): void {
    for (const buckets of [approveByIp, authByIp]) {
      for (const [ip, attempts] of buckets) {
        if (now - attempts.lastFail > APPROVE_FORGET_MS) buckets.delete(ip)
      }
    }
    if (approveGlobal.fails > 0 && now - approveGlobal.lastFail > APPROVE_FORGET_MS) {
      approveGlobal.fails = 0
      approveGlobal.until = 0
    }
  }

  /** Make room for one more address bucket. Map iteration is insertion-ordered
   *  and a bucket is inserted on first sight and thereafter mutated in place,
   *  so the front of the map is the one seen first, not the one seen least
   *  recently; a bucket still serving out its backoff is skipped so that
   *  filling the map cannot clear someone's penalty. */
  function evictApproveBucket(buckets = approveByIp): void {
    if (buckets.size < MAX_APPROVE_BUCKETS) return
    const now = Date.now()
    for (const [ip, attempts] of buckets) {
      if (attempts.until <= now) {
        buckets.delete(ip)
        return
      }
    }
    // Every bucket is actively blocking: drop the oldest anyway rather than
    // grow past the cap.
    const oldest = buckets.keys().next()
    if (!oldest.done) buckets.delete(oldest.value)
  }

  /** A user code no live session is already using: it is the lookup key on the
   *  approve page, so a collision would make two sessions indistinguishable. */
  function freshUserCode(): string {
    for (;;) {
      const candidate = randomUserCode()
      if (!loginByUserCode.has(normalizeUserCode(candidate))) return candidate
    }
  }

  /** The live session an operator-typed code refers to, compared the same way
   *  the approval compares it. */
  function sessionByUserCode(userCode: string): {code: string; session: LoginSession} | undefined {
    const code = loginByUserCode.get(normalizeUserCode(userCode))
    if (code === undefined) return undefined
    const session = loginSessions.get(code)
    return session === undefined ? undefined : {code, session}
  }

  function grantDescription(app: string | undefined): string {
    return `publish ${app === undefined ? '<strong>any app</strong>' : `<strong>${escapeHtml(app)}</strong>`} and enroll devices`
  }

  /** Step 1. The url is constant and carries no session, so there is nothing to
   *  look up yet and nothing to disclose to someone who merely has the link. */
  function handleLoginPage(): Response {
    return html(`<h1>Approve CLI access</h1>
<p>Enter the code shown in the terminal where you ran <code>mikro ota setup</code>.
If you did not just run it, or you cannot see a code, close this page: someone else
started this login.</p>
<form method="post" action="/login">
  <label>Code from the CLI: <input name="userCode" autocomplete="off" autofocus></label>
  <button type="submit">Continue</button>
</form>`)
  }

  /** Step 2. Only now, once the operator has proved they can see the CLI's
   *  code, is it safe to say what approving would grant. */
  function confirmPage(session: LoginSession, userCode: string): Response {
    return html(`<h1>Approve CLI access</h1>
<p>A CLI asked to <em>${grantDescription(session.app)}</em> on this registry. Approving
mints a token with exactly that access and hands it to the waiting CLI.</p>
<form method="post" action="/login">
  <input type="hidden" name="userCode" value="${escapeHtml(userCode)}">
  <label>Registry password: <input type="password" name="secret" autofocus></label>
  <button type="submit">Approve</button>
</form>`)
  }

  async function handleLoginApprove(request: Request): Promise<Response> {
    // Step 1 -> 2 takes no password, so without this a third-party page can
    // drive that transition and land the operator on a genuine confirm page
    // bound to a session the attacker started. The code the operator retypes is
    // the only thing tying the approving browser to the CLI that asked, and
    // being steered here skips it.
    if (!isSameOriginPost(request)) {
      return html('<h1>Bad request</h1><p>Start the login from your own terminal.</p>', 403)
    }
    await sweepLoginSessions()
    const now = Date.now()
    sweepApproveAttempts(now)

    const tooMany = (until: number) =>
      html('<h1>Too many attempts</h1><p>Wait a moment, then go back and try again.</p>', 429, {
        'retry-after': String(Math.ceil((until - now) / 1000)),
      })

    // A host that does not surface a peer address gets no per-address bucket
    // rather than one shared under a placeholder key. A correct password does
    // not clear this bucket (deliberately: it caps guessing from one address),
    // so a shared one is a lockout lever, and only the `serve` adapter sets the
    // header. The global bucket still caps guessing on those hosts.
    const ip = request.headers.get(CLIENT_IP_HEADER)
    // Inserted before the first await and mutated in place, so concurrent
    // requests share one bucket rather than each starting from zero.
    let perIp: Attempts | undefined
    if (ip !== null) {
      perIp = approveByIp.get(ip)
      if (perIp === undefined) {
        perIp = {fails: 0, until: 0, lastFail: 0}
        evictApproveBucket()
        approveByIp.set(ip, perIp)
      }
      if (perIp.until > now) return tooMany(perIp.until)
      // Counted on admission, not on failure: everything below awaits, and a
      // count recorded at the end cannot constrain a concurrent burst. Cleared
      // on success.
      recordFailure(perIp, APPROVE_IP_FREE_ATTEMPTS, now)
    }

    const raw = await readCappedBody(request, MAX_LOGIN_BODY_BYTES)
    if (raw === undefined) return html('<h1>Request body too large</h1>', 413)
    let form: FormData
    try {
      form = await new Response(raw, {
        headers: {'content-type': request.headers.get('content-type') ?? ''},
      }).formData()
    } catch {
      return html('<h1>Bad request</h1>', 400)
    }
    const field = (name: string) => {
      const value = form.get(name)
      return typeof value === 'string' ? value : ''
    }
    const userCode = field('userCode')
    const secret = field('secret')
    const found = sessionByUserCode(userCode)
    const wrong = () => html('<h1>Wrong code or password</h1><p>Go back and try again.</p>', 401)

    // Both checks run before either is acted on, and one message covers both,
    // so neither the code nor the password is an oracle.
    const secretOk =
      secret !== '' && options.token !== undefined && (await secretsMatch(secret, options.token))

    // A wrong password and a code naming no session are both guesses, so both
    // count against the global bucket. Starting a session is unauthenticated,
    // so holding a live code proves nothing about the caller and cannot stand
    // in for a rate limit. A correct password and step 1's bare code skip the
    // bucket, which keeps a sustained guess from holding login closed for
    // everyone.
    if (!secretOk && (secret !== '' || found === undefined)) {
      if (approveGlobal.until > now) return tooMany(approveGlobal.until)
      recordFailure(approveGlobal, APPROVE_GLOBAL_FREE_ATTEMPTS, now)
    }

    if (found === undefined) return wrong()

    // Step 1 -> 2: a bare code. Still counts as an attempt (see above), so
    // guessing codes is rate-limited like guessing passwords, and
    // reaching the confirm page does not clear the count: starting a session is
    // unauthenticated, so anyone can hold a code they know is good and replay
    // this step between password guesses to keep resetting their own backoff.
    if (secret === '') {
      if (perIp !== undefined) refundFailure(perIp, APPROVE_IP_FREE_ATTEMPTS, now)
      return confirmPage(found.session, userCode)
    }
    if (!secretOk) return wrong()
    const {session} = found
    if (ip !== null) approveByIp.delete(ip)
    // The caller holds the registry secret, so the failures counted in the
    // global bucket were somebody else's.
    approveGlobal.fails = 0
    approveGlobal.until = 0

    const token = `tok_${randomSecret()}`
    const record: TokenRecord = {
      tokenHash: await sha256Hex(token),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    }
    if (session.app !== undefined) record.app = session.app
    await storage.putToken(record)
    session.token = token
    session.tokenHash = record.tokenHash
    // Operator visibility only; the token itself reaches the CLI via the
    // exchange and is stored hashed.
    // eslint-disable-next-line no-console
    console.log(`login: minted a token (publish ${session.app ?? 'any app'} + enroll devices)`)
    return html(
      `<h1>Approved</h1><p>The CLI can now ${grantDescription(session.app)}. You can close this page.</p>`,
    )
  }

  async function handleClaimToken(code: string): Promise<Response> {
    await sweepLoginSessions()
    const session = loginSessions.get(code)
    // `no-store` on every answer, not just the one carrying the token: a
    // polling CLI hits the 202 repeatedly and an intermediary that cached it
    // would hide the approval.
    const noStore = {'cache-control': 'no-store'}
    if (session === undefined) return error('Unknown or expired login session', 404, noStore)
    if (session.token === undefined) return new Response(null, {status: 202, headers: noStore})
    // The token leaves exactly once; from here only its hash exists.
    loginSessions.delete(code)
    loginByUserCode.delete(normalizeUserCode(session.userCode))
    return json({token: session.token}, 200, {'cache-control': 'no-store'})
  }

  // ── Check-in ─────────────────────────────────────────────────────

  interface CheckinBody {
    deviceId?: unknown
    firmware?: unknown
    bytecode?: unknown
    /** `{checksum?, version?, trial?}` once validated. */
    running?: unknown
    /** Bytes free to download and stage one build. */
    free?: unknown
    lastInstall?: unknown
    /** `[rev, name?]`; absent means firmware without name sync. */
    name?: unknown
  }

  /** A `[rev, name?]` pair from a check-in, or undefined if malformed. */
  function parseNamePair(value: unknown): {rev: number; name?: string} | undefined {
    if (!Array.isArray(value)) return undefined
    const rev: unknown = value[0]
    if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > MAX_NAME_REV) {
      return undefined
    }
    const name: unknown = value[1]
    if (name === undefined || name === '') return {rev}
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) return undefined
    return {rev, name}
  }

  /** `{reason, detail?}` per the spec. Rejected rather than trimmed: it is
   *  device-supplied, stored verbatim, and shown to operators. */
  function parseLastInstall(value: unknown): {reason: string; detail?: string} | undefined {
    if (typeof value !== 'object' || value === null) return undefined
    const {reason, detail} = value as {reason?: unknown; detail?: unknown}
    if (typeof reason !== 'string' || reason === '' || reason.length > MAX_REASON_LENGTH) {
      return undefined
    }
    if (detail === undefined) return {reason}
    if (typeof detail !== 'string' || detail.length > MAX_DETAIL_LENGTH) return undefined
    return {reason, detail}
  }

  function namePair(record: {name?: string; nameRev?: number}): [number, string?] {
    const rev = record.nameRev ?? 0
    return record.name === undefined ? [rev] : [rev, record.name]
  }

  /** Pick the build to offer, or undefined. The app comes from the device
   * record: a device bound to one app must not be able to pull another's build
   * by reporting its checksum. */
  async function selectOffer(device: DeviceRecord): Promise<BuildRecord | undefined> {
    const {app, lastBytecode: bytecode, lastFirmware: firmware, lastFree: free} = device
    if (app === undefined || bytecode === undefined || firmware === undefined) return undefined

    // Most recently promoted wins, with the checksum breaking ties so two
    // builds promoted in the same millisecond do not pick a winner by whatever
    // the engine's sort happens to do.
    // Codepoint order, not `localeCompare`: these are machine strings, and
    // locale collation gives punctuation like the separators in an ISO
    // timestamp its own rules.
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
    const promoted = (b: BuildRecord) => b.promotedAt ?? b.createdAt
    const current = (await storage.listBuilds())
      .filter((b) => b.app === app && b.bytecodeVersion === bytecode)
      .sort((a, b) => cmp(promoted(b), promoted(a)) || cmp(a.checksum, b.checksum))[0]
    if (current === undefined) return undefined
    if (current.checksum === device.runningChecksum) return undefined
    // At or above the build's firmware, and within the same major. A floor
    // alone would offer a build compiled against 1.x to a 2.0 device, where a
    // major bump means exactly the breaking changes it may not survive.
    // `bytecodeVersion` does not cover this: it tracks the engine, so a release
    // that removes a `mikro/*` API without changing QuickJS still matches.
    //
    // Caret semantics, exactly as npm ranges define them: at or above the
    // build's firmware, within its left-most non-zero segment. For 1.x that is
    // the major (^1.3 serves 1.9, not 2.0); for 0.x, where semver makes the
    // minor the breaking boundary, it is the minor (^0.16 serves 0.16.x, not
    // 0.17). A hand-rolled "same major" is inert during 0.x — every 0.x
    // firmware shares major 0 — which is the whole of the current release line.
    // includePrerelease so a device on a prerelease firmware still matches its
    // own line rather than being offered nothing.
    if (semver.valid(firmware) === null) return undefined
    if (!semver.satisfies(firmware, `^${current.firmwareVersion}`, {includePrerelease: true})) {
      return undefined
    }
    if ((device.failedChecksums ?? []).includes(current.checksum)) return undefined
    // Withhold rather than substitute an older build that would fit: the device
    // is asking for the newest build it can hold, not the largest that fits.
    // A device that has never reported `free` is not gated.
    if (free !== undefined && current.size > free) return undefined
    return current
  }

  async function handleCheckin(request: Request): Promise<Response> {
    const deviceId = await deviceIdFor(request)
    if (deviceId === undefined) return error('Unauthorized', 401)
    const device = await storage.getDevice(deviceId)
    if (device === undefined) return error('Unauthorized', 401)

    let body: CheckinBody
    try {
      body = (await request.json()) as CheckinBody
    } catch {
      return error('Expected a JSON body', 400)
    }

    // Ground truth from the device, recorded on every check-in. Every field is
    // untrusted input that lands in a stored record, so a malformed one is a
    // 400 rather than something silently kept or dropped.
    const updated: DeviceRecord = {
      ...device,
      // Defensive: required by the type, but records reach us from whatever
      // `RegistryStorage` the host injected.
      failedChecksums: device.failedChecksums ?? [],
      lastSeen: new Date().toISOString(),
    }
    const bad = (field: string) => error(`Invalid ${field}`, 400)

    if (body.running !== undefined) {
      if (typeof body.running !== 'object' || body.running === null) return bad('running')
      const {checksum, version, trial} = body.running as {
        checksum?: unknown
        version?: unknown
        trial?: unknown
      }
      if (checksum !== undefined) {
        if (typeof checksum !== 'string' || !CHECKSUM_RE.test(checksum)) {
          return bad('running.checksum')
        }
        updated.runningChecksum = checksum
      }
      if (version !== undefined) {
        if (typeof version !== 'string' || version.length > MAX_VERSION_LENGTH) {
          return bad('running.version')
        }
        updated.runningVersion = version
      }
      // Required whenever `running` is reported, unlike its siblings: success
      // is "running.checksum matches what we offered and trial is false", so a
      // report that omits it would leave the previous check-in's `true`
      // standing and the device would read as trialing forever.
      if (typeof trial !== 'boolean') return bad('running.trial')
      updated.trial = trial
    }

    // The offer this device is still answering for. A failure report is
    // attributed to whatever was last offered, so this has to be cleared once
    // the device confirms it took (spec, "Success tracking"): a settled
    // checksum left here would blacklist the build the device is running.
    let openOffer = device.lastOfferedChecksum
    if (
      openOffer !== undefined &&
      updated.runningChecksum === openOffer &&
      updated.trial === false
    ) {
      openOffer = undefined
      delete updated.lastOfferedChecksum
    }
    if (body.firmware !== undefined) {
      if (typeof body.firmware !== 'string' || body.firmware.length > MAX_VERSION_LENGTH) {
        return bad('firmware')
      }
      updated.lastFirmware = body.firmware
    }
    if (body.bytecode !== undefined) {
      if (typeof body.bytecode !== 'number' || !Number.isInteger(body.bytecode)) {
        return bad('bytecode')
      }
      updated.lastBytecode = body.bytecode
    }
    if (body.free !== undefined) {
      if (typeof body.free !== 'number' || !Number.isInteger(body.free) || body.free < 0) {
        return bad('free')
      }
      updated.lastFree = body.free
    }
    if (body.lastInstall !== undefined && body.lastInstall !== null) {
      const lastInstall = parseLastInstall(body.lastInstall)
      if (lastInstall === undefined) return bad('lastInstall')
      updated.lastInstall = lastInstall
      // A failure report refers to the build we last offered; never re-offer
      // it. Bounded, oldest dropped: a device failing forever must not grow its
      // record without bound, and `DELETE .../failures` clears the list.
      if (openOffer !== undefined && !updated.failedChecksums.includes(openOffer)) {
        updated.failedChecksums = [...updated.failedChecksums, openOffer].slice(
          -MAX_FAILED_CHECKSUMS,
        )
      }
    }

    // The app is the device's, not the check-in's: it is bound at enrollment and
    // never inferred here. `running.checksum` is a state report, and a device
    // that names another app's build is logged and still offered only its own.
    // A device enrolled without an app stays unbound and is offered nothing,
    // which an operator fixes by re-enrolling it.
    if (updated.runningChecksum !== undefined) {
      const runningBuild = await storage.getBuild(updated.runningChecksum)
      if (runningBuild !== undefined && runningBuild.app !== updated.app) {
        // eslint-disable-next-line no-console
        console.warn(
          `checkin: device ${deviceId} is bound to app ${updated.app ?? '(none)'} but reports running ${runningBuild.app}`,
        )
      }
    }

    // Name sync (see docs/registry-spec.md, "Name sync"). Both sides carry a logical
    // revision and the higher one wins; the device only reports, the registry
    // decides. An absent field is firmware without name sync, so leave it alone.
    const reported = body.name === undefined ? undefined : parseNamePair(body.name)
    if (body.name !== undefined && reported === undefined) return bad('name')
    let respondName: [number, string?] | undefined
    if (reported !== undefined) {
      const ourRev = device.nameRev ?? 0
      if (reported.rev > ourRev) {
        // 1. The device is ahead (renamed over the cable): adopt its pair and
        //    send nothing back. This is how someone redoes a rename that lost a
        //    tie, so any record of that loss is now resolved.
        updated.name = reported.name
        updated.nameRev = reported.rev
        delete updated.discardedName
      } else if (reported.rev < ourRev) {
        // 2. The registry is ahead (renamed here): send ours down to be adopted.
        respondName = namePair(device)
      } else if (reported.name !== device.name && device.name === undefined && ourRev === 0) {
        // 4a. Equal revisions, but the registry has never named this device at
        //     all (enrolled without a name, nothing set since). There is no
        //     registry name to defend, so adopt the device's rather than
        //     ordering it to clear the only name either side has. `nameRev` is
        //     the discriminator: a registry that deliberately cleared a name
        //     carries a revision and falls to 4b.
        updated.name = reported.name
        delete updated.discardedName
      } else if (reported.name !== device.name) {
        // 4b. Equal revisions but different names: both sides were renamed
        //    before either synced. The registry wins the tie at a bumped
        //    revision, so the pair converges instead of ping-ponging.
        updated.nameRev = ourRev + 1
        respondName = namePair(updated)
        // Keep what the device lost. Whoever renamed at the serial port only
        // sees their name flip back, so without this the concurrent edit is
        // invisible and looks like the rename silently failed.
        updated.discardedName = reported.name
        // eslint-disable-next-line no-console
        console.warn(
          `checkin: device ${device.deviceId} renamed to ${JSON.stringify(reported.name)} ` +
            `at revision ${reported.rev}; registry name ${JSON.stringify(device.name)} ` +
            `wins the tie`,
        )
      } else {
        // 3. Equal revisions and the same name: in sync. Drop any record of an
        //    earlier tie, which has since converged.
        delete updated.discardedName
      }
    }

    const offer = await selectOffer(updated)
    if (offer !== undefined) updated.lastOfferedChecksum = offer.checksum
    await storage.putDevice(updated)

    // A name to hand back still has to reach the device when there's no update,
    // and `parseOffer` reads a body with no offer fields as "no update".
    if (offer === undefined) return json(respondName === undefined ? null : {name: respondName})
    const origin = options.baseUrl ?? new URL(request.url).origin
    return json({
      // What to fetch and how to verify it, and nothing the device would have to
      // re-decide with: `firmwareVersion` and `bytecodeVersion` selected this build
      // above and are not sent, because only the registry can act on them — it
      // holds the other builds. `version` is for operators reading a response.
      url: `${origin}/api/v1/builds/${offer.checksum}.tgz`,
      checksum: offer.checksum,
      size: offer.size,
      version: offer.version,
      ...(respondName === undefined ? {} : {name: respondName}),
    })
  }

  // ── Router ───────────────────────────────────────────────────────

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Identity document at the root, so `mikro ota setup` can recognize a
    // registry (by `name`) before it commits a token. `version` is an optional
    // build id (e.g. a commit sha); clients never key on it.
    if (path === '/' && request.method === 'GET') {
      return json({
        name: REGISTRY_NAME,
        ...(options.version !== undefined ? {version: options.version} : {}),
      })
    }

    if (path === '/api/v1/builds' && request.method === 'POST') return handlePublish(request)

    const download = /^\/api\/v1\/builds\/([0-9a-f]{64})\.tgz$/.exec(path)
    if (download && request.method === 'GET') return handleDownload(request, download[1]!)

    if (path === '/api/v1/devices' && request.method === 'POST') {
      return serializeDeviceWrite(() => handleEnroll(request))
    }
    if (path === '/api/v1/devices' && request.method === 'GET') return handleListDevices(request)

    // A malformed escape throws out of `decodeURIComponent`, which on a bare
    // `{fetch}` export is an unhandled rejection reachable before any auth.
    const deviceIdFromPath = (segment: string): string | undefined => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return undefined
      }
    }

    const remint = /^\/api\/v1\/devices\/([^/]+)\/credential$/.exec(path)
    if (remint && request.method === 'POST') {
      const id = deviceIdFromPath(remint[1]!)
      return id === undefined
        ? error('Unknown device', 404)
        : serializeDeviceWrite(() => handleRemint(request, id))
    }

    const failures = /^\/api\/v1\/devices\/([^/]+)\/failures$/.exec(path)
    if (failures && request.method === 'DELETE') {
      const id = deviceIdFromPath(failures[1]!)
      return id === undefined
        ? error('Unknown device', 404)
        : serializeDeviceWrite(() => handleClearFailures(request, id))
    }

    if (path === '/api/v1/checkin' && request.method === 'POST') {
      return serializeDeviceWrite(() => handleCheckin(request))
    }

    if (path === '/api/v1/auth/tokens' && request.method === 'GET') return handleListTokens(request)
    const revoke = /^\/api\/v1\/auth\/tokens\/([0-9a-f]{64})$/.exec(path)
    if (revoke && request.method === 'DELETE') return handleRevokeToken(request, revoke[1]!)

    if (loginEnabled) {
      if (path === '/api/v1/auth/sessions' && request.method === 'POST') {
        return handleCreateLoginSession(request)
      }
      const claim = /^\/api\/v1\/auth\/sessions\/([A-Za-z0-9_-]+)\/token$/.exec(path)
      if (claim && request.method === 'GET') return handleClaimToken(claim[1]!)
      if (path === '/login' && request.method === 'GET') return handleLoginPage()
      if (path === '/login' && request.method === 'POST') return handleLoginApprove(request)
    }

    return error('Not found', 404)
  }

  return {fetch: handle}
}

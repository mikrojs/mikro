/**
 * The over-the-air update machinery: an authenticated check-in at startup,
 * download + staging of an offered build, and trial confirmation. Everything
 * in this file is plumbing you can copy unchanged into your own project.
 *
 * The download streams to flash and resumes from `update.resumeOffset`, so a
 * build never has to fit in heap and an interrupted transfer picks up where it
 * left off instead of spending one of its three attempts starting over.
 */
import {request} from 'mikro/http/request'
import {type Offer, ota} from 'mikro/ota'
import {err, ok} from 'mikro/result'
import {
  deviceId,
  deviceName,
  firmware,
  restart,
  setDeviceName,
  storageUsage,
  version,
} from 'mikro/sys'

// Registry url + credential are provisioned as a pair by `mikro ota enroll`.
// A plaintext registry is accepted only on a private network, which is where
// the development flow puts it (`registry/server.ts` serves on the LAN address
// so devices can reach it). Beyond that the scheme is not a judgement call: on
// http the offer's checksum is worthless, because whoever can rewrite the url
// on the wire rewrites the checksum in the same response, and the device
// installs whatever they serve. That must not be reachable by enrolling
// against a public host once and forgetting.
const registryUrl = ota.registry()
const allowInsecure = isPrivateHttp(registryUrl)

/** True when both urls share a scheme and authority. Deliberately literal: with
 *  no URL parser here, a spelled-out default port does not compare equal. Used
 *  to decide whether the credential may ride the download request. */
function sameOrigin(a: string, b: string | undefined): boolean {
  if (b === undefined) return false
  const origin = (url: string): string | undefined => {
    const sep = url.indexOf('://')
    if (sep < 0) return undefined
    const start = sep + 3
    const end = url.indexOf('/', start)
    const authority = end < 0 ? url.slice(start) : url.slice(start, end)
    return authority === '' ? undefined : (url.slice(0, start) + authority).toLowerCase()
  }
  const left = origin(a)
  return left !== undefined && left === origin(b)
}

/** True for http:// on a LAN/loopback/mDNS host: development, not the internet. */
function isPrivateHttp(url: string | undefined): boolean {
  if (url === undefined || !url.startsWith('http://')) return false
  const host = (url.slice(7).split('/')[0] ?? '').split(':')[0] ?? ''
  if (host === 'localhost' || host.endsWith('.local')) return true
  const p = host.split('.').map((s) => parseInt(s, 10))
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 10 || p[0] === 127) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  return p[0] === 172 && p[1]! >= 16 && p[1]! <= 31
}

if (allowInsecure) {
  // Every boot, not once at enrollment: a device that quietly runs a forgeable
  // update channel should say so for as long as it does.
  console.warn('ota: registry is http:// on a private network — updates are NOT authenticated')
}

// On every boot, find out what happened to a previous update. The firmware
// has already installed, trialed, or rolled back any pending build before
// this module loads.
const lastBoot = ota.reconcile()
const running = ota.running()
console.log(
  'ota: running build %s%s',
  running.checksum?.slice(0, 12) ?? 'none',
  running.trial ? ' (on trial)' : '',
)
if (lastBoot.reverted) {
  console.warn('ota: the previous update crashed its trial and was rolled back')
}
if (lastBoot.installed) {
  console.log('ota: installed build %s on this boot', lastBoot.installed.slice(0, 12))
}

/**
 * Run the app inside the update cycle: check in once at startup (a pending
 * update installs before your main program runs, restarting the device),
 * then run the app. Updates published later are picked up at the next
 * startup check.
 */
export async function withUpdates(app: () => void | Promise<void>): Promise<void> {
  const checked = await checkForUpdate()

  // Confirm first, and independently of whether an offer arrived. A check-in
  // that completed is proof this build's network path works, which is the whole
  // signal requireConfirm waits for — and it is proof of that whether or not
  // the registry also had a newer build to hand. Gating the confirm on "no
  // offer arrived" would let a healthy build lapse and roll back purely because
  // a newer one happened to be published during its trial window.
  //
  // Doing it before staging also means the offer below can be taken on this
  // same pass: confirming resolves the trial, and applyOffer skips every offer
  // while a trial is unresolved.
  //
  // Note what the check-in gates: not "is this build healthy" but "can this
  // build still be updated". Those differ, and recoverability is the one worth
  // gating on. A build that checks in and then crashes in app() is not rolled
  // back -- confirming cleared the trial the firmware would have reverted --
  // but an uncaught error halts the runtime, which restarts the device after a
  // grace window, and the next boot checks in again before app() runs. So the
  // fix ships forward. A build that cannot reach the registry has no such route
  // and is the one that must revert, which is exactly the branch below.
  if (checked.checkedIn) {
    // Only a check-in that actually completed shows the app and its network
    // path work. If this build is still on trial, that is the signal to keep it
    // (matters with requireConfirm).
    //
    // Know what this confirms and what it does not. It fires seconds into boot,
    // so it proves the build boots and reaches the registry — not that `app()`
    // then does its job. A build that checks in and afterwards HANGS (an await
    // that never settles, a wedged state machine) has already been confirmed, so
    // the trial will not revert it: a hang is not a crash, nothing reboots, and
    // the rollback the firmware would do never triggers. If your app has a state
    // it can wedge in that a reboot would not clear, do not confirm here — move
    // `ota.confirm()` past the point where the build has proven it actually
    // works (a completed sensor read, a first successful job), or drive a
    // hardware watchdog `app()` must keep feeding. Confirming at check-in is the
    // right default only when a stuck app always ends in a reboot.
    if (running.trial) console.log('ota: check-in passed, confirming this build as healthy')
    ota.confirm()
  } else if (running.trial) {
    // Deliberately no confirm. A build that cannot reach the registry has not
    // proved itself, and confirming here would keep it forever — the exact
    // failure requireConfirm exists to catch. Staying silent lets the trial
    // lapse and the firmware roll back.
    console.warn('ota: check-in did not complete; leaving this build unconfirmed')
  }

  if (checked.offer && (await stageUpdate(checked.offer))) {
    console.log('ota: restarting to install…')
    restart()
  }

  await app()
}

/**
 * Ask the registry whether a newer build is available for this device.
 *
 * `checkedIn` says whether the registry actually answered, which is a separate
 * question from whether it offered anything: every failure here also produces
 * no offer, and treating the two alike would let a build that cannot reach the
 * registry confirm itself.
 */
async function checkForUpdate(): Promise<{checkedIn: boolean; offer?: Offer}> {
  // Check-ins authenticate with the device credential, provisioned over the
  // cable by `mikro ota enroll`. Credentials never arrive over the network.
  const bearer = ota.bearer()
  const named = deviceName()
  // Room to download and stage one build. Registries may use it to withhold an
  // offer that wouldn't fit; omitting it leaves any previously reported value
  // standing, so only send a figure we actually have.
  const storage = storageUsage()
  if (registryUrl === undefined || bearer === undefined) {
    console.error('ota: device not enrolled; run `mikro ota enroll` to provision it')
    return {checkedIn: false}
  }
  // Diagnostics: these are the inputs the registry uses to decide on an offer,
  // so logging them makes a "no update" result explainable (bytecode/firmware
  // mismatch, already running the latest, etc.).
  console.log(
    'ota: checking %s (running %s v%s, bytecode %d, fw %s)',
    `${registryUrl}/api/v1/checkin`,
    running.checksum?.slice(0, 12) ?? 'none',
    running.version ?? '?',
    firmware.bytecodeVersion,
    version,
  )
  const res = await request(`${registryUrl}/api/v1/checkin`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${bearer}`},
    body: JSON.stringify({
      deviceId,
      firmware: version,
      firmwareHash: firmware.hash,
      bytecode: firmware.bytecodeVersion,
      running,
      lastInstall: lastBoot.lastInstall,
      // The device's name and the revision that orders renames. The registry
      // does all the arbitration — the device just reports where it stands and
      // adopts whatever comes back.
      name: named.name === undefined ? [named.rev] : [named.rev, named.name],
      ...(storage === undefined ? {} : {free: storage.free}),
    }),
  })
  if (!res.ok) {
    console.error('ota checkin failed:', res.error)
    return {checkedIn: false}
  }
  if (res.value.status === 401) {
    // The credential no longer authenticates (re-minted, device deleted).
    // Only a 401 means this; transient failures keep the normal cadence.
    // There is no fallback secret: re-enroll over the cable.
    console.error(
      'ota: registry rejected the credential; re-enroll with `mikro ota enroll --re-enroll`',
    )
    return {checkedIn: false}
  }
  if (!res.value.ok) {
    console.error('ota checkin returned status:', res.value.status)
    return {checkedIn: false}
  }
  const body = await res.value.json()
  if (!body.ok) {
    console.error('ota checkin: invalid response body:', body.error)
    return {checkedIn: false}
  }
  adoptName(body.value)
  const offer = ota.parseOffer(body.value, {allowInsecure})
  if (!offer) console.log('ota: up to date, running the latest build')
  return {checkedIn: true, ...(offer ? {offer} : {})}
}

/**
 * Adopt a name the registry sent down, as `[rev, name]` (or `[rev]` when it was
 * cleared). No `name` field means "no change" and never "clear it": a response
 * lost after the registry adopted the device's own name looks exactly the same
 * as one that never arrived, and re-sending the pair next check-in settles it.
 */
function adoptName(body: unknown): void {
  if (typeof body !== 'object' || body === null) return
  const pair = (body as {name?: unknown}).name
  if (!Array.isArray(pair)) return
  const rev = pair[0]
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return
  const value = pair[1]
  const next = typeof value === 'string' && value !== '' ? {rev, name: value} : {rev}
  setDeviceName(next)
  console.log('ota: registry renamed this device to %s', next.name ?? '(no name)')
}

/** Download the offered build and stage it. Returns true when staged. The
 *  download callback is the only transport code; here it is a single HTTPS
 *  request, but it could be any link. */
async function stageUpdate(offer: Offer): Promise<boolean> {
  console.log(
    'ota: new build %s available (%d bytes), downloading…',
    offer.checksum.slice(0, 12),
    offer.size,
  )
  const result = await ota.applyOffer(
    offer,
    async (update) => {
      // Resume where a previous attempt stopped. The staged bytes survive a
      // reboot, so this is what makes a power loss mid-download cost nothing.
      const from = update.resumeOffset
      // Already complete. A finish that failed for a transient reason (an
      // unreadable staging file, a failed rename) leaves every byte on flash
      // and the offer still pending, so resuming would ask for `bytes=<size>-`
      // and take the 416 as a failed download -- forever, since the budget
      // comes back each boot. Hand it straight to finish to re-verify.
      if (from >= offer.size) return ok()
      // Same-origin only. `offer.url` is whatever the registry named, and it may
      // legitimately point at another host (a CDN, an object store), so the
      // credential goes out only when the download is on the registry's own
      // origin. A build fetched elsewhere is a public artifact the checksum
      // vouches for; a store that needs auth carries it in a signed url instead.
      const headers: Record<string, string> = {}
      if (from > 0) headers.range = `bytes=${from}-`
      const credential = ota.bearer()
      if (credential !== undefined && sameOrigin(offer.url, registryUrl)) {
        headers.authorization = `Bearer ${credential}`
      }
      const res = await request(offer.url, {headers})
      if (!res.ok) return err(new Error('download failed', {cause: res.error}))
      const response = res.value
      if (!response.ok) return err(new Error(`download failed with status ${response.status}`))

      // A server free to ignore Range answers 200 with the whole build. Drop the
      // prefix we already hold rather than restarting, which would trip the size
      // cap and throw away the partial.
      let skip = response.status === 206 ? 0 : from
      // Streamed to flash chunk by chunk: buffering the whole build first would
      // need more heap than the device has for anything but a tiny app.
      for await (const chunk of response.body) {
        if (!chunk.ok) return err(new Error('reading the download failed', {cause: chunk.error}))
        let bytes = chunk.value
        if (skip > 0) {
          if (bytes.length <= skip) {
            skip -= bytes.length
            continue
          }
          bytes = bytes.subarray(skip)
          skip = 0
        }
        // Returning the write error keeps its message, but not its type:
        // applyOffer folds every download failure into DownloadFailed, so a
        // StagingFull here is retried like any transient download problem
        // (bounded by the retry budget) rather than being distinguished.
        const written = update.write(bytes)
        if (!written.ok) return written
      }
      return ok()
    },
    // Require an explicit ota.confirm() (in the check-in loop, after a
    // successful check-in) before this build is kept. The firmware already
    // auto-reverts a build that crashes at startup; requireConfirm adds a
    // deeper check — a build that boots but can't reach the registry never
    // confirms, so it reverts too.
    {requireConfirm: true},
  )
  if (!result.ok) {
    console.error('ota update failed:', result.error)
    return false
  }
  if (result.value === 'staged') {
    console.log('ota: download verified and staged')
    return true
  }
  console.log('ota: update not staged (%s)', result.value)
  return false
}

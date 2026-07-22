import {err, ok} from 'mikro/result'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {createOta, type NativeOta, type OtaStore, parseOffer} from '../policy.js'
import type {DownloadFn, Offer, Update} from '../types.js'

const validOffer: Offer = {
  url: 'https://updates.example.com/app-2.tgz',
  checksum: 'abc123',
  size: 1024,
}

describe('parseOffer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('accepts a well-formed offer', () => {
    expect(parseOffer({...validOffer})).toEqual(validOffer)
  })

  it('rejects non-objects', () => {
    expect(parseOffer(undefined)).toBeUndefined()
    expect(parseOffer(null)).toBeUndefined()
    expect(parseOffer('https://x.tgz')).toBeUndefined()
  })

  it('treats null/undefined (the no-update signal) as quiet, not a warning', () => {
    const warn = vi.spyOn(console, 'warn')
    warn.mockClear()
    expect(parseOffer(null)).toBeUndefined()
    expect(parseOffer(undefined)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    // a present-but-non-object value is still warned about
    expect(parseOffer('nope')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-https url', () => {
    expect(parseOffer({...validOffer, url: 'http://updates.example.com/app.tgz'})).toBeUndefined()
  })

  it('accepts an http url only with allowInsecure', () => {
    const httpOffer = {...validOffer, url: 'http://192.168.1.10:4873/app.tgz'}
    expect(parseOffer(httpOffer)).toBeUndefined()
    expect(parseOffer(httpOffer, {allowInsecure: true})).toEqual(httpOffer)
    // allowInsecure still requires a .tgz
    expect(
      parseOffer({...httpOffer, url: 'http://x/app.zip'}, {allowInsecure: true}),
    ).toBeUndefined()
  })

  it('rejects a url that is not a .tgz', () => {
    expect(parseOffer({...validOffer, url: 'https://updates.example.com/app.zip'})).toBeUndefined()
  })

  // A registry serving builds from object storage signs the url and hangs the
  // expiry and signature off a query. Only the path has to name a .tgz, or the
  // protocol would forbid that for no gain.
  it('accepts a query after the .tgz path, and still checks the path', () => {
    const signed = {...validOffer, url: 'https://updates.example.com/app-2.tgz?exp=123&sig=abc'}
    expect(parseOffer(signed)).toEqual(signed)
    expect(
      parseOffer({...validOffer, url: 'https://updates.example.com/app.zip?x=.tgz'}),
    ).toBeUndefined()
  })

  it('rejects an empty checksum', () => {
    expect(parseOffer({...validOffer, checksum: ''})).toBeUndefined()
  })

  it('rejects a non-numeric size', () => {
    expect(parseOffer({...validOffer, size: '1024'})).toBeUndefined()
  })

  // `firmwareVersion` and `bytecodeVersion` are deliberately not read here. The
  // registry selects on them, against the versions the device reports at
  // check-in and the whole set of builds it holds; a device can only ever say
  // "not this one", never "that one instead". Extra fields are ignored, not
  // rejected, so a registry sending them costs nothing.
  it('ignores compatibility fields a registry still sends', () => {
    const offer = parseOffer({...validOffer, firmwareVersion: 'banana', bytecodeVersion: 'x'})
    expect(offer).toEqual({url: validOffer.url, checksum: validOffer.checksum, size: 1024})
  })
})

function fakeStore(
  initial?: Partial<{
    url: string
    attempt: string
    tries: number
    bad: string
    inFlight: boolean
  }>,
): OtaStore {
  const state: {
    url?: string
    attempt?: string
    tries: number
    bad?: string
    inFlight?: boolean
  } = {
    tries: 0,
    ...initial,
  }
  return {
    getUrl: () => state.url,
    setUrl: (url) => {
      state.url = url
    },
    getAttempt: () => state.attempt,
    setAttempt: (checksum) => {
      state.attempt = checksum
    },
    getTries: () => state.tries,
    setTries: (n) => {
      state.tries = n
    },
    getBad: () => state.bad,
    setBad: (checksum) => {
      state.bad = checksum
    },
    getInFlight: () => state.inFlight === true,
    setInFlight: (value) => {
      state.inFlight = value
    },
  }
}

function fakeNative(overrides: Partial<NativeOta> = {}): NativeOta {
  return {
    stageBegin: () => ({ok: true, resumeOffset: 0}),
    stageWrite: () => ({ok: true}),
    stageFinish: () => ({ok: true}),
    stageAbort: () => {},
    markValid: () => {},
    revert: () => ({ok: true}),
    running: () => ({trial: false, checksum: 'old'}),
    reconcile: () => ({reverted: false}),
    ...overrides,
  }
}

function deps(native: NativeOta, store: OtaStore) {
  return {
    native,
    store,
    readAppVersion: () => '1.0.0' as string | undefined,
    bearer: () => undefined as string | undefined,
    registry: () => undefined as string | undefined,
  }
}

const drainDownload: DownloadFn = async (update) => {
  update.write(new Uint8Array([1, 2, 3])).orPanic('write failed')
  return ok()
}

describe('applyOffer', () => {
  it('stages a compatible, fresh offer (happy path)', async () => {
    const store = fakeStore()
    const stageFinish = vi.fn(() => ({ok: true as const}))
    const native = fakeNative({stageFinish})
    const ota = createOta(deps(native, store))

    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.ok).toBe(true)
    expect(result.value).toBe('staged')
    expect(stageFinish).toHaveBeenCalledWith(1, false, false)
    // The budget counts *consecutive* failures, so a staged build clears it.
    expect(store.getTries()).toBe(0)
    expect(store.getUrl()).toBe(validOffer.url)
  })

  it('returns DownloadFailed and does not abandon when the download fails', async () => {
    const store = fakeStore()
    const stageAbort = vi.fn()
    const stageFinish = vi.fn(() => ({ok: true as const}))
    const ota = createOta(deps(fakeNative({stageAbort, stageFinish}), store))

    const failingDownload: DownloadFn = async () => err({message: 'network down'})
    const result = await ota.applyOffer(validOffer, failingDownload)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.name).toBe('DownloadFailed')
    expect(stageAbort).toHaveBeenCalled()
    expect(stageFinish).not.toHaveBeenCalled()
    // transient: the checksum is not abandoned, and the bumped try is kept
    expect(store.getBad()).not.toBe(validOffer.checksum)
    expect(store.getTries()).toBe(1)
  })

  it('forwards install options to stageFinish', async () => {
    const store = fakeStore()
    const stageFinish = vi.fn(() => ({ok: true as const}))
    const ota = createOta(deps(fakeNative({stageFinish}), store))

    await ota.applyOffer(validOffer, drainDownload, {
      trialBoots: 3,
      requireConfirm: true,
      install: 'now',
    })
    expect(stageFinish).toHaveBeenCalledWith(3, true, true)
  })

  // Reported distinctly from every other skip: it is the one case where the
  // caller must still confirm the build it is running. Collapsing it into a
  // generic "skipped" is what lets a healthy build lapse and roll back when a
  // newer one is published during its trial window.
  it('reports trial-pending when a trial is unresolved', async () => {
    const ota = createOta(deps(fakeNative({running: () => ({trial: true})}), fakeStore()))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.value).toBe('trial-pending')
  })

  // Pins the order of the two checks, not just each one alone: the offer that
  // matches the build on trial satisfies both, and answering 'current' is what
  // lets the caller treat it as handled and the trial lapse.
  it('reports trial-pending even when the offer is the build on trial', async () => {
    const native = fakeNative({running: () => ({trial: true, checksum: validOffer.checksum})})
    const ota = createOta(deps(native, fakeStore()))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.value).toBe('trial-pending')
  })

  it('reports current when the offer is already running', async () => {
    const native = fakeNative({running: () => ({trial: false, checksum: validOffer.checksum})})
    const ota = createOta(deps(native, fakeStore()))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.value).toBe('current')
  })

  // The device no longer second-guesses compatibility: it stages whatever the
  // registry offered. A build the registry should not have offered fails to
  // load, the trial reverts it, and `lastInstall` reports that back on the next
  // check-in, so the registry stops offering it. That path is self-correcting
  // and visible to an operator; a silent device-side refusal was neither.
  it('stages what it is offered, leaving compatibility to the registry', async () => {
    const ota = createOta(deps(fakeNative(), fakeStore()))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.value).toBe('staged')
  })

  it('reports abandoned for a checksum the device has given up on', async () => {
    const store = fakeStore({bad: validOffer.checksum})
    const ota = createOta(deps(fakeNative(), store))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.value).toBe('abandoned')
  })

  // Driven as a real sequence rather than a pre-seeded `tries: 3`, because the
  // bug this guards against is about *how* a device reached the limit: a flaky
  // link must not be treated the same as a corrupt build.
  it('stops attempting a url once the budget is spent, without abandoning the build', async () => {
    const store = fakeStore()
    const ota = createOta(deps(fakeNative(), store))
    const failingDownload: DownloadFn = async () => err({message: 'network down'})

    for (let cycle = 0; cycle < 3; cycle++) {
      const attempt = await ota.applyOffer(validOffer, failingDownload)
      expect(attempt.ok).toBe(false)
    }
    expect(store.getTries()).toBe(3)

    const spent = await ota.applyOffer(validOffer, failingDownload)
    expect(spent.value).toBe('exhausted')
    // The checksum stays eligible. Blacklisting it here would be permanent:
    // check (d) precedes the budget, so not even a re-publish could revive it.
    expect(store.getBad()).toBeUndefined()

    const republished = {...validOffer, url: 'https://cdn.example.com/b.tgz'}
    const revived = await ota.applyOffer(republished, drainDownload)
    expect(revived.value).toBe('staged')
  })

  // A native OOM panics into a restart, so an attempt can end without ever
  // returning. reconcile() hands the budget back every boot, which is right for
  // failures that return and fatal for the ones that do not: without the
  // in-flight flag the count is zeroed by the very crash it is meant to bound,
  // and the device reboots into the same attempt forever.
  it('counts an attempt that crashed the device instead of returning', async () => {
    const store = fakeStore()
    const crashingDownload: DownloadFn = async () => {
      throw new Error('device restarted mid-download')
    }
    for (let boot = 0; boot < 3; boot++) {
      const ota = createOta(deps(fakeNative(), store))
      ota.reconcile() // every boot starts here
      await expect(ota.applyOffer(validOffer, crashingDownload)).rejects.toThrow(/restarted/)
      // A thrown error still unwinds through `finally`; a panic does not. Put
      // the flag back to model the NVS state a real restart leaves behind.
      store.setInFlight(true)
    }
    expect(store.getTries()).toBe(3)

    // Budget spent: the loop is broken, and the device boots into its old build
    // instead of the same crash.
    const ota = createOta(deps(fakeNative(), store))
    ota.reconcile()
    expect((await ota.applyOffer(validOffer, drainDownload)).value).toBe('exhausted')
  })

  // The other half: an attempt that fails and returns leaves no flag, so the
  // reboot still hands the budget back. A device on flaky wifi must not be
  // latched out of a good build.
  it('still hands the budget back after a failure that returned', async () => {
    const store = fakeStore()
    const ota = createOta(deps(fakeNative(), store))
    const failingDownload: DownloadFn = async () => err({message: 'network down'})

    for (let cycle = 0; cycle < 3; cycle++) await ota.applyOffer(validOffer, failingDownload)
    expect((await ota.applyOffer(validOffer, failingDownload)).value).toBe('exhausted')

    ota.reconcile() // next boot
    expect(store.getTries()).toBe(0)
    expect((await ota.applyOffer(validOffer, drainDownload)).value).toBe('staged')
  })

  it('resets the budget when the url changes', async () => {
    const store = fakeStore({url: 'https://old.example.com/a.tgz', tries: 3})
    const ota = createOta(deps(fakeNative(), store))
    const failingDownload: DownloadFn = async () => err({message: 'network down'})

    const result = await ota.applyOffer(validOffer, failingDownload)
    expect(result.ok).toBe(false)
    expect(store.getUrl()).toBe(validOffer.url)
    expect(store.getTries()).toBe(1)
  })

  // Registries commonly serve a stable url ("/latest.tgz") and re-point it on
  // publish. Keying the budget on url alone meant a spent budget skipped every
  // future build at that url forever, since the reset on success is
  // unreachable once applyOffer returns 'skipped' before attempting.
  it('resets the budget when a new build arrives at an unchanged url', async () => {
    const store = fakeStore()
    const ota = createOta(deps(fakeNative(), store))
    const failingDownload: DownloadFn = async () => err({message: 'network down'})

    for (let cycle = 0; cycle < 3; cycle++) {
      await ota.applyOffer(validOffer, failingDownload)
    }
    expect((await ota.applyOffer(validOffer, failingDownload)).value).toBe('exhausted')

    const republished = {...validOffer, checksum: 'b'.repeat(64)}
    expect(republished.url).toBe(validOffer.url)
    const staged = await ota.applyOffer(republished, drainDownload)
    expect(staged.value).toBe('staged')
  })

  // Everything the budget counts is transient, so it must not be a permanent
  // latch: three OOM failures would otherwise strand the device on the old
  // build even after free heap recovered. A reboot is the only "conditions may
  // have changed" signal available, as there is no clock here.
  it('returns the budget on the next boot', async () => {
    const store = fakeStore()
    const ota = createOta(deps(fakeNative(), store))
    const failingDownload: DownloadFn = async () => err({message: 'out of memory'})

    for (let cycle = 0; cycle < 3; cycle++) {
      await ota.applyOffer(validOffer, failingDownload)
    }
    expect((await ota.applyOffer(validOffer, failingDownload)).value).toBe('exhausted')

    ota.reconcile()
    expect(store.getTries()).toBe(0)
    expect((await ota.applyOffer(validOffer, drainDownload)).value).toBe('staged')
  })

  it('marks a checksum bad, releases the staging file, and errors on a corrupt finish', async () => {
    const store = fakeStore()
    const stageAbort = vi.fn()
    const native = fakeNative({
      stageAbort,
      stageFinish: () => ({ok: false, error: 'hash mismatch', kind: 'corrupt'}),
    })
    const ota = createOta(deps(native, store))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('InstallFailed')
    expect(store.getBad()).toBe(validOffer.checksum)
    // Without this the verified-bad .tgz stays on the app partition until some
    // unrelated later offer happens to reclaim it.
    expect(stageAbort).toHaveBeenCalled()
  })

  it('keeps the checksum retryable on a transient finish failure', async () => {
    const store = fakeStore()
    const native = fakeNative({
      stageFinish: () => ({ok: false, error: 'flash busy', kind: 'transient'}),
    })
    const ota = createOta(deps(native, store))
    const result = await ota.applyOffer(validOffer, drainDownload)
    expect(result.ok).toBe(false)
    expect(store.getBad()).toBeUndefined()
    expect(store.getTries()).toBe(1)
  })
})

// Staging is only reachable through applyOffer, so the Update handed to the
// download callback is exercised the same way an app would meet it.
describe('the Update handed to the download callback', () => {
  /** Runs applyOffer and captures the Update the download callback receives. */
  async function withUpdate(
    native: NativeOta,
    body: (update: Update) => void,
    offer: Offer = validOffer,
  ) {
    let seen: Update | undefined
    const result = await createOta(deps(native, fakeStore())).applyOffer(offer, async (update) => {
      seen = update
      body(update)
      return ok()
    })
    return {result, update: seen}
  }

  it('reports StagingFailed when staging cannot begin, without calling the download callback', async () => {
    const native = fakeNative({
      stageBegin: () => ({ok: false, error: 'offered build is larger than the filesystem'}),
    })
    const {result, update} = await withUpdate(native, () => {})
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('StagingFailed')
    expect(update).toBeUndefined()
  })

  // The failure is a property of the offer, not of the build's bytes, so it must
  // not reach the permanent blacklist: nothing clears `bad`, and check (d) runs
  // before the retry budget, so a corrected re-publish could never revive it.
  it('does not abandon the checksum when staging cannot begin', async () => {
    const store = fakeStore()
    const native = fakeNative({
      stageBegin: () => ({ok: false, error: 'checksum must be 64 lowercase hex characters'}),
    })
    const ota = createOta(deps(native, store))
    await ota.applyOffer(validOffer, drainDownload)
    expect(store.getBad()).toBeUndefined()
  })

  it('enforces the offered size with TooLarge', async () => {
    await withUpdate(
      fakeNative(),
      (update) => {
        const write = update.write(new Uint8Array([1, 2, 3]))
        expect(write.ok).toBe(false)
        expect(write.error?.name).toBe('TooLarge')
      },
      {...validOffer, size: 2},
    )
  })

  it('maps a native write failure to StagingFull', async () => {
    const native = fakeNative({stageWrite: () => ({ok: false, error: 'no space', kind: 'oom'})})
    await withUpdate(native, (update) => {
      const write = update.write(new Uint8Array([1]))
      expect(write.ok).toBe(false)
      expect(write.error?.name).toBe('StagingFull')
    })
  })

  it('exposes the native resume offset so the download callback can range-fetch the remainder', async () => {
    const native = fakeNative({stageBegin: () => ({ok: true, resumeOffset: 512})})
    const {update} = await withUpdate(native, () => {})
    expect(update?.resumeOffset).toBe(512)
  })

  // The size cap counts the resumed bytes, so a download callback that range-fetches writes
  // exactly the remainder. A download callback that refetched the whole build from 0 would
  // trip TooLarge here and lose the partial it was meant to resume.
  it('counts already-staged bytes against the offered size', async () => {
    const native = fakeNative({stageBegin: () => ({ok: true, resumeOffset: 1000})})
    await withUpdate(native, (update) => {
      expect(update.write(new Uint8Array(24)).ok).toBe(true)
      expect(update.write(new Uint8Array(1)).error?.name).toBe('TooLarge')
    })
  })
})

describe('reconcile / running / revert', () => {
  it('maps the native diagnostic to lastInstall', () => {
    const native = fakeNative({
      reconcile: () => ({
        installed: 'new',
        reverted: true,
        diagnostic: {reason: 'ota_install_failed', detail: 'bad bytes'},
      }),
    })
    const ota = createOta(deps(native, fakeStore()))
    expect(ota.reconcile()).toEqual({
      installed: 'new',
      reverted: true,
      lastInstall: {reason: 'ota_install_failed', detail: 'bad bytes'},
    })
  })

  it('augments running() with the app version', () => {
    const ota = createOta(
      deps(fakeNative({running: () => ({trial: true, checksum: 'c'})}), fakeStore()),
    )
    expect(ota.running()).toEqual({trial: true, checksum: 'c', version: '1.0.0'})
  })

  it('reports a revert failure as InstallFailed', () => {
    const ota = createOta(
      deps(fakeNative({revert: () => ({ok: false, error: 'no target'})}), fakeStore()),
    )
    const r = ota.revert()
    expect(r.ok).toBe(false)
    expect(r.error?.name).toBe('InstallFailed')
  })
})

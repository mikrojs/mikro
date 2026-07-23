import {describe, expect, it, vi} from 'vitest'

import {
  buildEnrollRequest,
  buildRemintRequest,
  CREDENTIAL_KV,
  enrollDevice,
  remintCredential,
} from '../enroll.js'
import type {FetchLike} from '../otaPublish.js'

const input = {registry: 'https://updates.example.com/', deviceId: '0wvfa7cccg'}

describe('CREDENTIAL_KV', () => {
  it('fits the 15-byte NVS key name limit', () => {
    expect(Buffer.byteLength(CREDENTIAL_KV, 'utf-8')).toBeLessThanOrEqual(15)
  })
})

describe('buildEnrollRequest', () => {
  it('targets /devices with bearer auth and a JSON body', () => {
    const plan = buildEnrollRequest(input, 'tok_secret')
    expect(plan.url).toBe('https://updates.example.com/api/v1/devices')
    expect(plan.method).toBe('POST')
    expect(plan.headers.authorization).toBe('Bearer tok_secret')
    expect(JSON.parse(plan.body!)).toEqual({deviceId: '0wvfa7cccg'})
  })

  it('includes the name only when given', () => {
    const plan = buildEnrollRequest({...input, name: 'kitchen-sensor'}, 't')
    expect(JSON.parse(plan.body!)).toEqual({deviceId: '0wvfa7cccg', name: 'kitchen-sensor'})
  })

  // Binding the device to an app at enrollment is what stops it being offered
  // another app's build; without it the registry can only pin on first check-in.
  it('includes the app only when given', () => {
    expect(JSON.parse(buildEnrollRequest({...input, app: 'thermostat'}, 't').body!)).toEqual({
      deviceId: '0wvfa7cccg',
      app: 'thermostat',
    })
    expect(JSON.parse(buildEnrollRequest(input, 't').body!)).not.toHaveProperty('app')
  })

  // Absent channel = the registry's default (main).
  it('includes the channel only when given', () => {
    expect(JSON.parse(buildEnrollRequest({...input, channel: 'beta'}, 't').body!)).toEqual({
      deviceId: '0wvfa7cccg',
      channel: 'beta',
    })
    expect(JSON.parse(buildEnrollRequest(input, 't').body!)).not.toHaveProperty('channel')
  })
})

describe('buildRemintRequest', () => {
  it('targets the device credential path, url-encoding the id', () => {
    const plan = buildRemintRequest({registry: input.registry, deviceId: 'a/b'}, 't')
    expect(plan.url).toBe('https://updates.example.com/api/v1/devices/a%2Fb/credential')
    expect(plan.body).toBeUndefined()
  })
})

/** Records what actually reached the wire. The mock takes (url, init) rather
 *  than no arguments on purpose: a zero-parameter mock discards the request, so
 *  a change of url, method, or authorization header cannot fail any test that
 *  only inspects the outcome. */
function recordingFetch(
  status: number,
  body: unknown,
): {calls: {url: string; init: RequestInit}[]; fetchImpl: FetchLike} {
  const calls: {url: string; init: RequestInit}[] = []
  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    calls.push({url, init})
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }
  })
  return {calls, fetchImpl}
}

function fetchReturning(status: number, body: unknown): FetchLike {
  return recordingFetch(status, body).fetchImpl
}

describe('enrollDevice', () => {
  it('returns the credential on success', async () => {
    const outcome = await enrollDevice(
      input,
      't',
      fetchReturning(200, {device: {}, credential: 'dvc_abc.secret'}),
    )
    expect(outcome).toEqual({status: 'enrolled', credential: 'dvc_abc.secret'})
  })

  it('reports already-enrolled on 409 without throwing', async () => {
    const outcome = await enrollDevice(input, 't', fetchReturning(409, {error: 'exists'}))
    expect(outcome).toEqual({status: 'already-enrolled'})
  })

  it('throws with status and body on other failures', async () => {
    await expect(enrollDevice(input, 't', fetchReturning(403, {error: 'nope'}))).rejects.toThrow(
      /403.*nope/,
    )
  })

  it('throws when the response has no credential', async () => {
    await expect(enrollDevice(input, 't', fetchReturning(200, {device: {}}))).rejects.toThrow(
      /no credential/,
    )
  })

  // The plan is asserted above; this asserts the executor actually sends it.
  // A token posted to the wrong host is a credential handed to a stranger, and
  // nothing about the returned outcome would show it.
  it('sends the built request unaltered: url, method, auth and body', async () => {
    const {calls, fetchImpl} = recordingFetch(200, {credential: 'dvc_abc.secret'})
    await enrollDevice({...input, name: 'kitchen', app: 'thermostat'}, 'tok_secret', fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://updates.example.com/api/v1/devices')
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok_secret')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      deviceId: '0wvfa7cccg',
      name: 'kitchen',
      app: 'thermostat',
    })
  })

  it('propagates a transport failure instead of reporting a status', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(enrollDevice(input, 't', fetchImpl)).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('remintCredential', () => {
  it('returns the fresh credential', async () => {
    const credential = await remintCredential(
      input,
      't',
      fetchReturning(200, {credential: 'dvc_new.secret'}),
    )
    expect(credential).toBe('dvc_new.secret')
  })

  it('throws on 404', async () => {
    await expect(
      remintCredential(input, 't', fetchReturning(404, {error: 'Unknown device'})),
    ).rejects.toThrow(/404/)
  })

  // Re-minting invalidates the old credential, so an unauthenticated request
  // that somehow succeeded would be a device-bricking hole. Assert the header
  // reaches the wire rather than only that the plan contains it.
  it('sends bearer auth to the credential path', async () => {
    const {calls, fetchImpl} = recordingFetch(200, {credential: 'dvc_new.secret'})
    await remintCredential(input, 'tok_secret', fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://updates.example.com/api/v1/devices/0wvfa7cccg/credential')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok_secret',
    )
  })

  it('propagates a transport failure', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('ETIMEDOUT')
    })
    await expect(remintCredential(input, 't', fetchImpl)).rejects.toThrow(/ETIMEDOUT/)
  })
})

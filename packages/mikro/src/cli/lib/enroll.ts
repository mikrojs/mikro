import {type FetchLike, joinUrl} from './otaPublish.js'

/** System-store (`mik.sys`) key holding the device update key (15-byte NVS cap). */
export const UPDATE_KEY_KV = 'ota.updateKey'

/** System-store key holding the registry url the update key belongs to. */
export const REGISTRY_KV = 'ota.registry'

const API_PREFIX = 'api/v1'

export interface EnrollInput {
  registry: string
  deviceId: string
  /** Operator-friendly display name stored in the registry. */
  name?: string
  /** App this device belongs to. Binding it here is what keeps the device from
   *  being offered another app's build; a registry that is not told pins the
   *  device on its first check-in instead. */
  app?: string
  /** Channel the device follows. Absent = the registry's default (main). */
  channel?: string
}

export type EnrollOutcome =
  | {status: 'enrolled'; updateKey: string}
  /** The registry already knows this deviceId; rotate instead. */
  | {status: 'already-enrolled'}

export interface RequestPlan {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body?: string
}

export function buildEnrollRequest(input: EnrollInput, token: string): RequestPlan {
  return {
    url: joinUrl(input.registry, `${API_PREFIX}/devices`),
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      deviceId: input.deviceId,
      ...(input.name === undefined ? {} : {name: input.name}),
      ...(input.app === undefined ? {} : {app: input.app}),
      ...(input.channel === undefined ? {} : {channel: input.channel}),
    }),
  }
}

export function buildRotateKeyRequest(
  input: Pick<EnrollInput, 'registry' | 'deviceId'>,
  token: string,
): RequestPlan {
  return {
    url: joinUrl(input.registry, `${API_PREFIX}/devices/${encodeURIComponent(input.deviceId)}/key`),
    method: 'POST',
    headers: {authorization: `Bearer ${token}`},
  }
}

async function failWith(url: string, status: number, text: () => Promise<string>): Promise<never> {
  const body = await text().catch(() => '')
  const detail = body ? `: ${body}` : ''
  // Registry tokens expire, so a 401 on a token that used to work means gone,
  // not a transient blip worth retrying.
  const hint =
    status === 401 ? ' (the registry token is invalid or expired; run `mikro ota setup`)' : ''
  throw new Error(`Registry request to ${url} failed with ${status}${detail}${hint}`)
}

async function readUpdateKey(url: string, res: {text(): Promise<string>}): Promise<string> {
  const body = await res.text()
  let updateKey: unknown
  try {
    updateKey = (JSON.parse(body) as {credential?: unknown}).credential
  } catch {
    updateKey = undefined
  }
  if (typeof updateKey !== 'string' || updateKey.length === 0) {
    throw new Error(`Registry response from ${url} has no update key`)
  }
  return updateKey
}

/**
 * Register the device with the registry and receive its update key (returned
 * by the registry exactly once). A 409 is an expected outcome (the deviceId
 * is already enrolled) and is reported in the result, not thrown.
 */
export async function enrollDevice(
  input: EnrollInput,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<EnrollOutcome> {
  const plan = buildEnrollRequest(input, token)
  const res = await fetchImpl(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body: plan.body,
  })
  if (res.status === 409) return {status: 'already-enrolled'}
  if (!res.ok) await failWith(plan.url, res.status, () => res.text())
  return {status: 'enrolled', updateKey: await readUpdateKey(plan.url, res)}
}

/** Rotate the update key for an enrolled device; the old one stops
 * authenticating the moment this returns. */
export async function rotateUpdateKey(
  input: Pick<EnrollInput, 'registry' | 'deviceId'>,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const plan = buildRotateKeyRequest(input, token)
  const res = await fetchImpl(plan.url, {method: plan.method, headers: plan.headers})
  if (!res.ok) await failWith(plan.url, res.status, () => res.text())
  return readUpdateKey(plan.url, res)
}

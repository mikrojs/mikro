import {basename} from 'node:path'

import {readFile} from 'fs/promises'

import type {OtaManifest} from './ota.js'

export interface PublishInput {
  registry: string
  checksum: string
  size: number
  manifest: OtaManifest
  /** Optional free-text note stored with the build (e.g. what changed). */
  note?: string
  /** Create the app on first publish instead of failing on an unknown slug. */
  create?: boolean
  /** Channel to serve the build on. Absent = stored but served to nobody. */
  channel?: string
}

/** A described HTTP request, kept separate from execution so request shaping is
 * unit-testable without a network. */
export interface UploadRequestPlan {
  url: string
  method: 'POST'
  headers: Record<string, string>
  /** Multipart form fields (the file is added separately at execution time). */
  fields: {
    app: string
    version: string
    checksum: string
    size: string
    firmwareVersion: string
    bytecodeVersion: string
    /** Omitted from the form when absent. */
    note?: string
    /** Truthy flag field; omitted from the form when absent. */
    create?: string
    /** Channel to serve on; omitted from the form when absent (store-only). */
    channel?: string
  }
}

/** API version path segment. The user configures only the registry origin; the
 *  client appends this so `/api/v1` never has to be part of `--registry`. */
const API_PREFIX = 'api/v1'

/** Join a base registry URL with a path, tolerating a trailing slash on the base. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function authHeaders(token: string): Record<string, string> {
  return {authorization: `Bearer ${token}`}
}

/** Build the upload request (multipart: file + metadata). */
export function buildUploadRequest(input: PublishInput, token: string): UploadRequestPlan {
  return {
    url: joinUrl(input.registry, `${API_PREFIX}/builds`),
    method: 'POST',
    headers: authHeaders(token),
    fields: {
      app: input.manifest.app,
      version: input.manifest.version,
      checksum: input.checksum,
      size: String(input.size),
      firmwareVersion: input.manifest.firmwareVersion,
      bytecodeVersion: String(input.manifest.bytecodeVersion),
      note: input.note,
      create: input.create === true ? '1' : undefined,
      channel: input.channel,
    },
  }
}

export interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponse>

async function send(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<void> {
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const detail = body ? `: ${body}` : ''
    throw new Error(`Registry request to ${url} failed with ${res.status}${detail}`)
  }
}

/**
 * Upload the build to the registry. HTTP is confined to the injected
 * `fetchImpl` (defaults to global fetch) so callers can mock it.
 */
export async function publishBuild(
  input: PublishInput,
  buildPath: string,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  const upload = buildUploadRequest(input, token)
  const form = new FormData()
  form.set('app', upload.fields.app)
  form.set('version', upload.fields.version)
  form.set('checksum', upload.fields.checksum)
  form.set('size', upload.fields.size)
  form.set('firmwareVersion', upload.fields.firmwareVersion)
  form.set('bytecodeVersion', upload.fields.bytecodeVersion)
  if (upload.fields.note !== undefined) form.set('note', upload.fields.note)
  if (upload.fields.create !== undefined) form.set('create', upload.fields.create)
  if (upload.fields.channel !== undefined) form.set('channel', upload.fields.channel)
  const bytes = await readFile(buildPath)
  form.set('build', new Blob([bytes], {type: 'application/gzip'}), basename(buildPath))
  await send(fetchImpl, upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: form,
  })
}

export interface ReleaseInput {
  registry: string
  app: string
  version: string
  channel: string
}

/** A described release request, kept separate from execution for testability. */
export interface ReleaseRequestPlan {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

/** Build the release request (JSON: point a channel at a published build). */
export function buildReleaseRequest(input: ReleaseInput, token: string): ReleaseRequestPlan {
  return {
    url: joinUrl(input.registry, `${API_PREFIX}/releases`),
    method: 'POST',
    headers: {...authHeaders(token), 'content-type': 'application/json'},
    body: JSON.stringify({app: input.app, version: input.version, channel: input.channel}),
  }
}

/** Point a channel at an already-published build. Returns how many stored builds
 *  the channel was pointed at: one per bytecode version of `(app, version)`, not
 *  a device count. */
export async function releaseBuild(
  input: ReleaseInput,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{released: number}> {
  const plan = buildReleaseRequest(input, token)
  const res = await fetchImpl(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body: plan.body,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const detail = body ? `: ${body}` : ''
    throw new Error(`Registry request to ${plan.url} failed with ${res.status}${detail}`)
  }
  const parsed = (JSON.parse(await res.text()) as {released?: unknown}).released
  return {released: typeof parsed === 'number' ? parsed : 0}
}

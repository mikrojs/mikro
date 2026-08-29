import {readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import * as pathlib from 'node:path'

import {materializeDefaults, parseConfigSchema} from '@mikrojs/native/runtime/schema/shared'

import type {MikroJSConfig} from '../../_exports/index.js'
import {loadMikroConfig} from './loadMikroConfig.js'

/** Config schemas over this size are a mistake; matches the registry spec's
 *  publish cap. */
/* The schema is host-side only and never reaches a device, so this bounds
 * registry storage rather than anything on the wire to a board. Raised from 16
 * KiB when descriptions arrived: at the per-string ingest caps a fully
 * annotated field costs roughly 610 bytes, which left only about 22 usable
 * fields. The 4 KiB effective-document cap below is the one that governs device
 * NVS and is deliberately unchanged. */
const CONFIG_SCHEMA_MAX_BYTES = 32 * 1024

/** The registry spec's cap on a served config document (the device parses it
 *  out of a fixed check-in response buffer and stores it in NVS). Enforced at
 *  every authoring point so dev and fleet behavior stay in parity: a document
 *  that deploys over the cable must also be servable by a registry. */
const CONFIG_DOC_MAX_BYTES = 4 * 1024

/**
 * Serialize and vet the config schema declared in `mikro.config.ts`, or
 * undefined when the app declares none. Rejection here, not at the registry:
 * the build is where the author can still rename a field or add a default.
 */
export function serializeConfigSchema(config: MikroJSConfig | null): unknown {
  if (config?.otaConfigSchema === undefined) return undefined
  let serialized: unknown
  try {
    serialized = JSON.parse(JSON.stringify(config.otaConfigSchema))
  } catch (cause) {
    // A circular structure throws from stringify; keep the file named so the
    // author knows where to look.
    throw new Error(`mikro.config.ts: otaConfigSchema does not serialize to JSON`, {cause})
  }
  const checked = parseConfigSchema(serialized)
  if (!checked.ok) {
    const where = checked.error.path === '' ? '' : ` at ${checked.error.path}`
    throw new Error(
      `mikro.config.ts: otaConfigSchema is not a valid config schema${where}: ${checked.error.message}`,
    )
  }
  const bytes = Buffer.byteLength(JSON.stringify(serialized))
  if (bytes > CONFIG_SCHEMA_MAX_BYTES) {
    throw new Error(
      `mikro.config.ts: otaConfigSchema serializes to ${bytes} bytes, over the ${CONFIG_SCHEMA_MAX_BYTES}-byte cap`,
    )
  }
  // Defaults alone over the document cap means no document for this schema
  // could ever be served: every authored config would be rejected and rule 5
  // would pause every rollout. Catch it at build time, where the schema
  // author can trim.
  const docBytes = Buffer.byteLength(JSON.stringify(materializeDefaults(checked.value)))
  if (docBytes > CONFIG_DOC_MAX_BYTES) {
    throw new Error(
      `mikro.config.ts: otaConfigSchema's defaults alone encode to ${docBytes} bytes, ` +
        `over the ${CONFIG_DOC_MAX_BYTES}-byte config document cap`,
    )
  }
  return serialized
}

/** Config-pairing state a cable deploy resets: a staged or rollback document
 *  belongs to an OTA install cycle the cable deploy just replaced, and a
 *  trial or rollback report describes a document the deploy just replaced.
 *  (The delivered document itself, `ota.cfg`, is never touched by a deploy.)
 */
export const CONFIG_STALE_KVS = [
  'ota.cfgNext',
  'ota.cfgPrev',
  'ota.cfgTrial',
  'ota.cfgErr',
] as const

/**
 * Build the `configDefaults` a manifest carries, or undefined when the app
 * declares no schema. The single place both `mikro ota pack` and the dev
 * manifest go through, so a device reads the same defaults either way. The
 * result is partial: it holds every field a default covers and omits the rest
 * (defaultless leaves, units without a whole-value default).
 */
export function buildConfigDefaults(schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined
  const checked = parseConfigSchema(schema)
  if (!checked.ok) {
    throw new Error(`config schema is not valid: ${checked.error.message}`)
  }
  return materializeDefaults(checked.value)
}

/**
 * The dev-session half of config: the incremental file sync does not go
 * through `pack`, so the manifest `ota.config()` reads its defaults from has
 * to be written into the build tree here (development-resolved config,
 * matching the build). A no-op when the app declares no schema.
 */
export async function writeDevManifest(options: {
  projectRoot: string
  buildDir: string
}): Promise<void> {
  const config = await loadMikroConfig(options.projectRoot, 'development')
  const schema = serializeConfigSchema(config)
  const pkg = readProjectPackage(options.projectRoot)
  if (schema !== undefined) {
    // Inside the build tree's app/ directory: the deploy commit keeps only
    // the staged app/ subtree (firmware and sim alike), and the device reads
    // the manifest at /app/mikro.app.json — where a packed build's installer
    // also puts it. Created unconditionally, matching writeManifest, so a
    // build with no app/ directory neither crashes here nor installs without
    // a manifest. Only the materialized defaults ship: the device never
    // reads the schema, so the dev manifest stays small.
    const appDir = pathlib.join(options.buildDir, 'app')
    await mkdir(appDir, {recursive: true})
    await writeFile(
      pathlib.join(appDir, 'mikro.app.json'),
      JSON.stringify({
        app: pkg.name ?? 'app',
        version: pkg.version,
        configDefaults: buildConfigDefaults(schema),
      }),
    )
  }
}

function readProjectPackage(projectRoot: string): {name?: string; version: string} {
  try {
    const raw = readFileSync(pathlib.join(projectRoot, 'package.json'), 'utf-8')
    const parsed = JSON.parse(raw) as {name?: unknown; version?: unknown}
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    }
  } catch {
    return {version: '0.0.0'}
  }
}

interface KvWriter {
  delete(key: string, namespace: 'sys'): Promise<void>
}

/** Drop the config-pairing state a cable deploy obsoletes (see
 *  `CONFIG_STALE_KVS`). The delivered document itself is left alone: its
 *  version stamp makes it inert under a version-bumped deploy, and a registry
 *  that manages this device re-serves it either way. */
export async function clearStaleConfigState(kv: KvWriter): Promise<void> {
  for (const key of CONFIG_STALE_KVS) {
    await kv.delete(key, 'sys')
  }
}

// Registry existence checks. Queries the registry HTTP API directly via
// `fetch` (Node >= 24 global) so we don't depend on an `npm`/`pnpm` binary
// being on PATH — this is a pnpm workspace, and npm is not guaranteed present.

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

// Where to look up published versions. Defaults to the public npm registry
// (where this project publishes); `npm_config_registry` overrides it so a
// custom registry configured for the run is honored.
function registryBase(): string {
  return process.env.npm_config_registry || DEFAULT_REGISTRY
}

// Build the version-manifest URL. Each path segment is URL-encoded, so a
// scoped name (`@scope/pkg`) becomes `%40scope%2Fpkg` — the registry accepts
// it and it can't break on slashes or other reserved characters.
export function packageVersionUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

// True when the exact name@version exists on the registry. Uses HEAD: we only
// need the status, not the manifest body. 404 → not published; 2xx →
// published. Any other status (auth, outage, rate limit) is a real error and
// propagates rather than being silently read as "not published", which would
// risk a duplicate publish or a silently skipped one.
export async function isPublished(name: string, version: string): Promise<boolean> {
  const res = await fetch(packageVersionUrl(registryBase(), name, version), {method: 'HEAD'})
  if (res.status === 404) return false
  if (res.ok) return true
  throw new Error(`registry lookup for ${name}@${version} failed: HTTP ${res.status}`)
}

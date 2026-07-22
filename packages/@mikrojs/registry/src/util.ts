/** SHA-256 as lowercase hex via WebCrypto (portable across runtimes). */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 32 random bytes as base64url. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Compare a candidate against a secret without leaking a prefix through
 * timing: both sides are hashed and the digests compared, so how long the
 * comparison runs says nothing about how much of the secret was guessed.
 */
export async function secretsMatch(candidate: string, secret: string): Promise<boolean> {
  return (await sha256Hex(candidate)) === (await sha256Hex(secret))
}

/** No vowels (no words form) and no characters that read alike (0/O, 1/I/L),
 *  so a code read off one screen cannot be typed as a different valid one. */
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789'

/** A short, human-typable code, `XXXX-XXXX`. About 38 bits: not guessable
 *  within a session's few minutes given the approve path's rate limit. */
export function randomUserCode(): string {
  const values = crypto.getRandomValues(new Uint32Array(8))
  const chars = [...values].map((v) => USER_CODE_ALPHABET[v % USER_CODE_ALPHABET.length]!)
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

/** Compare user codes as typed: case and separators are not significant. */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
}

/** Header carrying the peer address, set by the `serve` adapter from the
 *  socket (overwriting anything the client sent). Hosts that do not set it
 *  share one rate-limit bucket. */
export const CLIENT_IP_HEADER = 'mikro-client-ip'

/** Marker in the `GET /` identity document. A client recognizes a registry by
 *  this exact `name`, so it can catch a wrong url before it commits a token. */
export const REGISTRY_NAME = 'mikro-registry'

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  })
}

export function error(
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({error: message}, status, headers)
}

/** A minimal self-contained HTML page (the browser-login approve flow).
 *  Never cached: every page in that flow carries or accepts a secret. */
export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mikro.js registry</title><style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5}input,button{font:inherit;padding:.4rem .6rem}form{margin-top:1.5rem;display:grid;gap:.75rem;justify-items:start}</style></head><body>${body}</body></html>`
  return new Response(page, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Approving on this page mints fleet-wide publish rights, so it must not
      // be reachable inside someone else's frame.
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      ...headers,
    },
  })
}

/** Escapes `&<>"` but not `'`, which is only safe because every interpolation
 *  into the login pages is element text or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
}

/**
 * Whether a form POST came from the registry's own pages. The step 1 -> step 2
 * transition of the login flow takes no password, so without this a third-party
 * page can drive it and land the operator on a genuine confirm page bound to a
 * session they never started.
 *
 * `Sec-Fetch-Site` is sent by every browser that can reach those pages; `Origin`
 * covers anything that sends one but not the other. A caller that sends neither
 * is not a browser and cannot be steered by one, so it passes.
 */
export function isSameOriginPost(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  // `none` is a direct navigation (typed url, bookmark), not a cross-site one.
  if (site !== null) return site === 'same-origin' || site === 'none'
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

/**
 * Read at most `max` bytes of a request body, or undefined if it is longer.
 * A body is buffered before anything can validate it, so the unauthenticated
 * routes need a ceiling of their own: `serve`'s cap does not exist on a bare
 * `{fetch}` export deployed to another host.
 */
export async function readCappedBody(
  request: Request,
  max: number,
): Promise<Uint8Array | undefined> {
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let over = false
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    // Drained rather than cancelled: cancelling a body the host is still
    // filling races its enqueue and surfaces as an unhandled rejection. Nothing
    // past the cap is retained either way, which is what the cap is for.
    if (total > max) {
      over = true
      chunks.length = 0
      continue
    }
    chunks.push(value)
  }
  if (over) return undefined
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

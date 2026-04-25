---
title: http/request
description: HTTP client
---

# http/request

```ts twoslash
import {request} from 'mikrojs/http/request'
```

Make HTTP requests against a network endpoint. Returns a [`Result`](/api/result) so network-level failures are handled explicitly instead of thrown.

## Functions

### request(url, options?)

```ts
function request(url: string, options?: RequestOptions): Promise<Result<Response, RequestError>>
```

```ts twoslash
// @noErrors
import {request} from 'mikrojs/http/request'
// ---cut---
const result = await request('https://api.example.com/data')
if (!result.ok) {
  console.error('Request failed: %s', result.error.name)
  return
}

const response = result.value
console.log('Status: %d', response.status)
const data = await response.json()
```

::: tip Result vs response.ok
`request` returns a [`Result`](/api/result) that indicates whether the network request succeeded at all. The `Response` inside has its own `.ok` property that indicates whether the HTTP status was 2xx. You need to check both:

```ts twoslash
// @noErrors
import {request} from 'mikrojs/http/request'
// ---cut---
const result = await request('https://api.example.com/data')
if (!result.ok) {
  // Network error (no connection, DNS failure, etc.)
  return
}
if (!result.value.ok) {
  // HTTP error (404, 500, etc.)
  console.error('HTTP %d', result.value.status)
  return
}
const data = await result.value.json()
```

:::

### POST request

```ts twoslash
import {request} from 'mikrojs/http/request'
// ---cut---
const result = await request('https://api.example.com/data', {
  method: 'POST',
  json: {temperature: 23.5},
})
```

`json:` serialises the value as JSON and sets `content-type: application/json` unless you override it. For raw bytes or UTF-8 text use `body:` instead.

### Request with timeout

```ts twoslash
import {request} from 'mikrojs/http/request'
// ---cut---
const result = await request('https://api.example.com/data', {
  timeoutMs: 5000,
})
if (!result.ok && result.error.name === 'Aborted') {
  console.error('Request timed out')
}
```

`timeoutMs` is a total wallclock deadline. Compose with `AbortSignal` when you need external cancellation.

On ESP32, cancelling a request terminates the underlying HTTP task between read chunks and frees TLS buffers immediately.

## Types

### RequestOptions

```ts
interface RequestOptions {
  method?: string
  headers?: [string, string][] | Record<string, string>
  json?: unknown
  body?: Uint8Array | string
  timeoutMs?: number
  signal?: AbortSignal
}
```

### Response

```ts
interface Response {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly redirected: boolean
  readonly headers: [string, string][]
  readonly ok: boolean // true if status is 200-299
  readonly body: AsyncIterable<Uint8Array>

  get(name: string): string | undefined
  getAll(name: string): string[]
  text(): Promise<string>
  json(): Promise<unknown>
  bytes(): Promise<Uint8Array>
  close(): Promise<void>
}
```

`get` and `getAll` look up headers case-insensitively. `text()`, `json()`, `bytes()`, and `body` are single-shot: calling more than one drains the body and a second call throws [`BodyConsumedError`](#bodyconsumederror).

::: warning Always close responses you don't read
Every response you don't drain with `text()`, `json()`, `bytes()`, or a `for await` loop needs an explicit `await response.close()`. Skipping this keeps memory tied up until the device reboots, and eventually new requests will fail with [`TooManyPending`](#requesterror).
:::

## Errors

### RequestError

Returned by `request` and any custom transport built on top of `mikrojs/http/helpers`.

| Variant           | Fields                        | Description                                                  |
| ----------------- | ----------------------------- | ------------------------------------------------------------ |
| `Hardware`        | `message: string`             | Underlying hardware/driver failure                           |
| `Network`         | `message: string`             | Request failed (DNS, TLS, connection, transport error, etc.) |
| `Timeout`         | `message: string`             | Request exceeded its deadline                                |
| `BodyTooLarge`    | `size: number`, `cap: number` | Request body exceeded the transport's limit                  |
| `InvalidResponse` | `message: string`             | Response was malformed or couldn't be parsed                 |
| `Aborted`         | `message: string`             | Request was cancelled via timeout or `AbortSignal`           |
| `TooManyPending`  | —                             | Transport's in-flight request slots are full                 |

### BodyConsumedError

Thrown by `Response.text()`, `json()`, `bytes()`, or a second iteration of `body` after the body has already been drained.

## Custom transports

The default `request` is backed by a WiFi-driven HTTP client. If you're driving HTTP through something else (e.g. an LTE modem exposing an AT-command HTTP stack), write a function with the same `Request` signature using helpers from `mikrojs/http/helpers` for the boring parts:

```ts twoslash
// @noErrors
import {makeResponse, prepareBody, type Request, RequestError} from 'mikrojs/http/helpers'
import {err, ok} from 'mikrojs/result'
// ---cut---
export const request: Request = async (url, opts = {}) => {
  const {body, headers} = prepareBody(opts)

  // Drive your physical transport here. On failure return
  // err(RequestError.Network(msg)).
  const raw = await driveTheTransport(url, opts.method ?? 'GET', body, headers)
  if (!raw.ok) return err(RequestError.Network(raw.error))

  return ok(
    makeResponse({
      status: raw.value.status,
      statusText: '',
      url,
      redirected: false,
      headers: raw.value.headers,
      body: raw.value.body, // AsyncIterable<Uint8Array>
    }),
  )
}
```

Import from `mikrojs/http/helpers` instead of `mikrojs/http/request` when you don't need the default implementation; that avoids paying for its WiFi/TLS machinery at startup.

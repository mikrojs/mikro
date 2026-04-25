---
title: sntp
description: Network time synchronization
---

# sntp

```ts twoslash
import {sntp} from 'mikrojs/sntp'
```

Synchronize the system clock with an NTP server. SNTP is a lightweight variant of NTP suitable for microcontrollers. The default export is an `Sntp` singleton.

## Usage

```ts twoslash
import {sntp} from 'mikrojs/sntp'

const result = await sntp.sync({
  timezone: 'CET-1CEST,M3.5.0,M10.5.0/3',
})

if (result.ok) {
  console.log('Time synced: %s', result.value.time.toISOString())
}
```

## Methods

### sntp.sync(options?)

```ts
sync(options?: SntpOptions): Promise<Result<SntpSyncResult, SntpError>>
sync(options: SntpOptions & {background: true}): Promise<Result<SntpSyncResultWithStop, SntpError>>
```

Synchronize the system clock. By default, syncs once and returns. With `background: true`, keeps syncing periodically and returns a `stop()` function.

```ts twoslash
import {sntp} from 'mikrojs/sntp'
// ---cut---
// One-shot sync
const result = await sntp.sync()

// Background sync (keeps running)
const bgResult = await sntp.sync({background: true})
if (bgResult.ok) {
  console.log('Initial sync: %s', bgResult.value.time)
  // Later, stop background sync:
  bgResult.value.stop()
}
```

### sntp.setTimezone(tz)

```ts
setTimezone(tz: string): void
```

Set the POSIX timezone string without syncing. Affects how `Date` objects display local time.

```ts twoslash
import {sntp} from 'mikrojs/sntp'
// ---cut---
sntp.setTimezone('CET-1CEST,M3.5.0,M10.5.0/3') // Central European Time
```

## Types

### SntpOptions

```ts
interface SntpOptions {
  servers?: string[] // NTP servers (default: ['pool.ntp.org'])
  timezone?: string // POSIX TZ string (default: 'UTC0')
  timeout?: number // ms before timeout (default: 60000)
}
```

### SntpSyncResult

```ts
interface SntpSyncResult {
  time: Date
}
```

### SntpSyncResultWithStop

```ts
interface SntpSyncResultWithStop extends SntpSyncResult {
  stop: () => void
}
```

## Errors

### SntpError

| Variant      | Fields    | Description                            |
| ------------ | --------- | -------------------------------------- |
| `InitFailed` | `message` | Failed to initialize SNTP              |
| `Timeout`    | `ms`      | Sync timed out after `ms` milliseconds |
| `Cancelled`  | —         | Sync was cancelled                     |

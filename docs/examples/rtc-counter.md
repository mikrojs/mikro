---
title: RTC Counter
description: Count wake-ups from deep sleep using RTC memory
---

# RTC Counter

Counts how many times the device has woken up from deep sleep. The counter is stored in RTC memory, so it survives deep sleep but resets on power loss. Uses the [kv](/api/kv), [schema](/api/schema), and [sleep](/api/sleep) APIs.

## Hardware

- Any ESP32 board
- USB cable

## Code

```ts twoslash
import {rtcStorage} from 'mikrojs/kv/rtc'
import * as s from 'mikrojs/schema'
import {deepSleep, sleep} from 'mikrojs/sleep'

// Read the wake counter from RTC memory (survives deep sleep).
// optional() because the key may not exist on first boot.
const count = rtcStorage.createValue('count', {schema: s.optional(s.number())})

console.log(`Wake #${count.get() ?? 0}`)
console.log(`RTC memory: ${rtcStorage.info().used}/${rtcStorage.info().total} bytes used`)

// Increment and store back
count.update((n) => (n ?? 0) + 1).orPanic('failed to store count')

console.log('Waiting for a few seconds before going to deep sleep...')
await sleep(5000)

// Sleep for 15 seconds, then wake up again
console.log('Going to deep sleep for 15s...')
deepSleep({timer: 15_000})
```

## Walkthrough

1. **RTC-backed key/value.** `rtcStorage.createValue('count', {schema})` returns a typed handle whose value lives in RTC memory. `optional(number())` makes the schema accept `undefined` so the first boot reads cleanly.

2. **Read.** `count.get()` returns the stored value or `undefined`. The `?? 0` defaults the first boot to `0`.

3. **Update.** `count.update(fn)` reads, transforms, and writes atomically. Returns a [`Result`](/api/result), so `.orPanic()` halts with a clear message if the write fails.

4. **Deep sleep.** `deepSleep({timer: 15_000})` powers down the CPU for 15 seconds (the value is in milliseconds). RTC memory is preserved; everything else is lost. On wake, the script runs from the top.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-rtc-counter --template rtc-counter
```

```sh [npm]
npm create mikrojs -- my-rtc-counter --template rtc-counter
```

```sh [yarn]
yarn create mikrojs my-rtc-counter --template rtc-counter
```

```sh [bun]
bun create mikrojs my-rtc-counter --template rtc-counter
```

:::

## Run it

```sh
cd my-rtc-counter
```

::: code-group

```sh [pnpm]
pnpm install
pnpm mikro flash  # only needed once per board
pnpm mikro dev
```

```sh [npm]
npm install
npx mikro flash  # only needed once per board
npx mikro dev
```

```sh [yarn]
yarn install
yarn mikro flash  # only needed once per board
yarn mikro dev
```

```sh [bun]
bun install
bunx mikro flash  # only needed once per board
bunx mikro dev
```

:::

You should see `Wake #0`, then after the deep sleep cycle `Wake #1`, `Wake #2`, and so on. Power-cycle the board to reset the counter.

[View source on GitHub](https://github.com/mikrojs/mikrojs/tree/main/examples/rtc-counter)

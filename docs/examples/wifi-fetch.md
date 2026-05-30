---
title: WiFi + HTTP
description: Connect to WiFi and request JSON from an API
---

# WiFi + HTTP

Connect to a WiFi network and make an HTTP request to a JSON API. Uses the [wifi](/api/wifi) and [http/request](/api/http-request) APIs.

## Hardware

- Any ESP32 board with WiFi
- USB cable
- A WiFi network with internet access

## Setup

Set your WiFi credentials as environment variables:

::: code-group

```sh [pnpm]
pnpm mikro env set WIFI_SSID YourNetworkName --no-secret
pnpm mikro env set WIFI_PASSPHRASE
```

```sh [npm]
npx mikro env set WIFI_SSID YourNetworkName --no-secret
npx mikro env set WIFI_PASSPHRASE
```

```sh [yarn]
yarn mikro env set WIFI_SSID YourNetworkName --no-secret
yarn mikro env set WIFI_PASSPHRASE
```

```sh [bun]
bunx mikro env set WIFI_SSID YourNetworkName --no-secret
bunx mikro env set WIFI_PASSPHRASE
```

:::

## Code

```ts twoslash
import {env} from 'mikro/env'
import {request} from 'mikro/http/request'
import {memoryUsage} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

// Connect to WiFi
console.log(`Connecting to ${ssid}...`)
const connectResult = await wifi.connect(ssid, passphrase)
if (!connectResult.ok) {
  console.error('WiFi connect failed: %s', connectResult.error.name)
} else {
  console.log('Connected! IP: %s', connectResult.value.ip)

  // Request JSON from an API
  const result = await request('https://jsonplaceholder.typicode.com/posts/1')
  if (result.ok) {
    if (!result.value.ok) {
      console.error(`HTTP error: ${result.value.status}`)
    } else {
      const data = await result.value.json()
      if (!data.ok) {
        console.error(`Body decode failed: ${data.error.name}`)
      } else {
        console.log('Fetched post: %o', data.value)
      }
    }
  } else {
    console.error('Request failed: %s', result.error.name)
  }
}

const mem = memoryUsage()
console.log('free heap: %dKB', (mem.heapTotal - mem.heapUsed) / 1000)
```

## Walkthrough

1. **Country code.** [`wifi.country`](/config#wifi-country) must be set before connecting. This configures the regulatory domain for your region's WiFi channels.

2. **Environment variables.** WiFi credentials come from `env.require()`, which panics with a clear message if a variable is missing. Environment variables are stored in NVS on device. Set them with `mikro env set`.

3. **Connect.** `wifi.connect()` returns a `Promise<Result>`. The outer [`Result`](/api/result) tells you if the connection succeeded; the `value` contains your IP address.

4. **Request.** `request()` also returns a `Promise<Result>`. Two levels of error checking:
   - `result.ok`: did the network request succeed at all?
   - `result.value.ok`: was the HTTP status in the 2xx range?

5. **Memory.** Prints free heap after the request completes, useful for tracking memory on constrained devices.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-wifi-fetch --template wifi-fetch
```

```sh [npm]
npm create mikrojs -- my-wifi-fetch --template wifi-fetch
```

```sh [yarn]
yarn create mikrojs my-wifi-fetch --template wifi-fetch
```

```sh [bun]
bun create mikrojs my-wifi-fetch --template wifi-fetch
```

:::

## Run it

```sh
cd my-wifi-fetch
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

You should see the WiFi connection, fetched JSON data, and memory usage in the console output.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/wifi-fetch)

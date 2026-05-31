---
title: WiFi Access Point
description: Turn the ESP32 into a WiFi hotspot
---

# WiFi Access Point

Configure the ESP32 as a WiFi access point (soft AP) that other devices can connect to. Logs connect/disconnect events and periodically lists connected clients. See the [wifi API reference](/api/wifi) for the full type surface.

## Hardware

- Any ESP32 board with WiFi
- USB cable
- A phone or laptop to connect to the AP

## Code

```ts twoslash
import {sleep} from 'mikro/sleep'
import {wifi} from 'mikro/wifi'

// Start the access point
wifi.ap
  .start({
    ssid: 'MikroJS-AP',
    passphrase: 'hello1234',
    channel: 6,
    maxConnections: 4,
  })
  .orPanic('Failed to start access point')

console.log('Access point started')
console.log('SSID: MikroJS-AP')
console.log('IP: %s', wifi.ap.ip)

// Log when stations connect/disconnect
wifi.ap.onStationConnect.subscribe((info) => {
  console.log('Station connected: %s', info.mac)
})

wifi.ap.onStationDisconnect.subscribe((info) => {
  console.log('Station disconnected: %s', info.mac)
})

// Periodically print connected stations
while (true) {
  await sleep(10000)
  const stations = wifi.ap.stations
  if (stations.length > 0) {
    console.log(`Connected stations (${stations.length}):`)
    for (const sta of stations) {
      console.log(`  ${sta.mac} (RSSI: ${sta.rssi})`)
    }
  }
}
```

## Walkthrough

1. **Country code.** [`wifi.country`](/config#wifi-country) must be set before any WiFi operation. It determines which channels and power levels are legal in your region.

2. **Access point config.** `wifi.ap.start()` takes an SSID, passphrase (minimum 8 characters), channel number, and maximum client count. `.orPanic()` crashes with a clear message if startup fails.

3. **Event streams.** `wifi.ap.onStationConnect` is an `Observable<ApStationInfo>` that emits whenever a device joins the network. Subscribe with `.subscribe(callback)`; the callback receives the client's MAC address. Disconnect works the same way via `onStationDisconnect`.

4. **Connected clients.** `wifi.ap.stations` returns an array of currently connected stations, each with a `mac` address and `rssi` signal strength. The example polls this every 10 seconds.

5. **No internet needed.** Unlike `wifi.connect()`, the access point does not require an existing network. Useful for device configuration portals, direct peer communication, or field deployments without infrastructure.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikro --template wifi-access-point
```

```sh [npm]
npm create mikro -- --template wifi-access-point
```

```sh [yarn]
yarn create mikro --template wifi-access-point
```

```sh [bun]
bun create mikro --template wifi-access-point
```

:::

## Run it

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

After deploying, look for the "MikroJS-AP" network on your phone or laptop. Connect with password `hello1234`. You should see the connection logged in the console.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/wifi-access-point)

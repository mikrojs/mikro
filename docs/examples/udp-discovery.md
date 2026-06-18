---
title: UDP Discovery
description: Find peer devices on the LAN via UDP multicast
---

# UDP Discovery

Periodically broadcast a "hello" datagram to a multicast group and listen for the same from peers. Deploy to two or more boards on the same WiFi network and watch them find each other. Uses the [wifi](/api/wifi), [udp](/api/udp), and [sys](/api/sys) APIs.

## Hardware

- Two or more ESP32 boards with WiFi (one is enough to see the announcer logs, but you need at least two for actual discovery)
- USB cables
- A WiFi network. Both boards must join the same SSID.

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
import {sleep} from 'mikro/sleep'
import {deviceId} from 'mikro/sys'
import {bind} from 'mikro/udp'
import {wifi} from 'mikro/wifi'

const GROUP = '224.0.0.251'
const PORT = 7654
const ANNOUNCE_MS = 2000

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

const connected = await wifi.connect({ssid, passphrase})
if (connected.ok) {
  const bound = await bind({port: PORT, family: 'ipv4'})
  if (bound.ok) {
    const sock = bound.value
    const joined = sock.joinMulticastGroup({address: GROUP})
    if (joined.ok) {
      sock.onMessage.subscribe(({msg, from}) => {
        const text = new TextDecoder().decode(msg)
        if (text === deviceId) return
        console.log('discovered %s at %s', text, from.address)
      })
      while (true) {
        await sock.send(deviceId, {address: GROUP, port: PORT, family: 'ipv4'})
        await sleep(ANNOUNCE_MS)
      }
    }
  }
}
```

## Walkthrough

1. **Multicast group.** `224.0.0.251` is the mDNS group. Home routers reliably forward it because Bonjour, AirPlay, and Chromecast all depend on it; less common groups in `224.0.0.0/24` get silently dropped by some APs. The example uses port `7654` so it doesn't collide with system mDNS responders on `5353`. Datagrams sent to the group are delivered to every host on the LAN that joined it, with no central server.

2. **Why join.** `joinMulticastGroup` tells the kernel and switch fabric to deliver matching datagrams to this socket. Without it, the socket would only see unicast packets sent to its bound port. The group must be joined after the network interface is up, which is why it lives inside the `wifi.connect` ok-branch.

3. **Self-filter.** Multicast loops back to the sender on the same host (and the same socket can join its own group), so `onMessage` will see the device's own announcements. Skip them by comparing against `deviceId`.

4. **Backpressure.** Each socket has a bounded receive queue. A busy responder can override the default with `bind({port, family, recvQueue: 32})`. Drops are observable via `socket.dropped`.

5. **Reach.** UDP multicast travels as far as the LAN allows: most home routers forward `224.0.0.0/4` within a single broadcast domain but not across VLANs or the public internet. For mesh-wide discovery, use Thread (IPv6 multicast routes across the mesh).

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

Deploy to a second board and watch each console log the other's `deviceId`.

## No second board? Run a Node peer

The example ships with `scripts/peer.ts`, a small Node program that joins the same multicast group, announces a name, and logs everything it hears. Requires Node 24+. Run it on a laptop attached to the same WiFi:

::: code-group

```sh [pnpm]
pnpm run peer                # name defaults to laptop-<pid>
pnpm run peer -- --name desk # custom name
```

```sh [npm]
npm run peer
npm run peer -- --name desk
```

```sh [yarn]
yarn run peer
yarn run peer --name desk
```

```sh [bun]
bun run peer
bun run peer -- --name desk
```

:::

The board will log `discovered laptop-... at 192.168.x.y` and the laptop will log the board's `deviceId`. Stop the peer with Ctrl-C.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/udp-discovery)

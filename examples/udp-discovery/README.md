# UDP Discovery

Periodically broadcasts a "hello" datagram to a multicast group and listens for the same from peers. Deploy to two or more boards on the same WiFi network and watch them find each other.

```sh
npm create mikrojs my-discovery --template udp-discovery
```

## Environment variables

This example reads `WIFI_SSID` and `WIFI_PASSPHRASE` using `env.require()` from `mikrojs/env`.

For local development, create a `.env` file:

```
WIFI_SSID=YourNetwork
WIFI_PASSPHRASE=YourPassword
```

To set env vars on the device (persisted in NVS):

```sh
npx mikro env set WIFI_SSID YourNetwork --no-secret
npx mikro env set WIFI_PASSPHRASE            # prompts for value (hidden)
```

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

Run the same example on a second board to see them discover each other.

## No second board? Run a Node peer

`scripts/peer.ts` is a small Node program that joins the same multicast group, announces a name, and logs other peers. Run it on a laptop on the same WiFi:

```sh
npm run peer                  # name defaults to laptop-<pid>
npm run peer -- --name desk   # custom name
```

The board will then log `discovered laptop-... at 192.168.x.y` and the laptop will log the board's `deviceId`.

## How it works

- Joins the IPv4 multicast group `224.0.0.251` (mDNS) on port `7654`.
- Sends its `mikrojs/sys.deviceId` to the group every two seconds.
- Logs any other device IDs heard on the group, with the sender's address.

UDP datagrams travel only as far as the LAN allows: most home routers forward multicast within a single broadcast domain but not across VLANs. For mesh-wide discovery use Thread (IPv6 multicast routes across the mesh).

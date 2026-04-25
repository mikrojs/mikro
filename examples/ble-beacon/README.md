# ble-beacon

Broadcasts a fake temperature reading in the BLE advertising packet's manufacturer-data field, refreshing every 5 seconds.

Scan for it with [nRF Connect](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-mobile) on a phone. The device appears as `mikrojs-beacon`.

## Run

```sh
npm install
npm run dev
```

## What this demonstrates

- Setting the global BLE device name via `ble.name`
- Broadcaster-mode advertising (no central connections)
- Custom manufacturer-specific data in the advertising payload
- Including the TX power in the advertising packet
- Stopping and restarting advertising to refresh the payload

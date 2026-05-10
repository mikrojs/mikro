# ble-gatt

A connectable BLE GATT peripheral with two services:

- **Battery Service** (`0x180F`) with a Battery Level characteristic (`0x2A19`) that supports reads and notifications. The app drains a fake battery from 87% down to 0% and wraps back to 100%, pushing an update every 2 seconds.
- **Custom vendor service** (`7f3a1b00-4a2f-4e5b-9a3c-1e2d3f4a5b6c`) with:
  - A read-only info string.
  - A writable "command" characteristic. Writes from the central fire an `onWrite` handler on the JS loop thread that hex-dumps the received bytes to the serial console. Reads return whatever was last written.

The app also subscribes to `peripheral.onConnect`, `peripheral.onDisconnect`, and `peripheral.onMtu` (Observable streams from `mikrojs/observable`) to log each event, and auto-re-advertises on disconnect so the device stays discoverable after a central hangs up.

## Run

```sh
npm install
npm run dev
```

## What to try

1. Open [nRF Connect for Mobile](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-mobile) on your phone.
2. Scan for `mikrojs-gatt` and tap **Connect**. The serial console logs `connected: ... mtu: 23` and shortly after `mtu renegotiated to 256`.
3. Expand the Battery Service and tap **subscribe** (double-arrow icon) next to Battery Level. The value ticks down every 2 seconds.
4. Expand the custom vendor service. Read the info characteristic to get the UTF-8 string.
5. Write bytes to the command characteristic (e.g. `deadbeef`). The serial console logs `command write: 4 bytes: de ad be ef`. Reading the same characteristic returns the bytes you wrote.
6. Disconnect. Serial logs the disconnect event. The device re-advertises automatically; scan again and you can reconnect.

See the [ble API reference](../../docs/api/ble.md) for the full type surface and the list of things that aren't supported.

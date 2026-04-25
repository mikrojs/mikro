# UART Loopback

Verifies UART TX and RX by wiring them together and reading back what was sent.

## Hardware

Connect a jumper wire from GPIO 17 (TX) to GPIO 16 (RX) on your board. Adjust the pin numbers in `app/main.ts` if needed.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

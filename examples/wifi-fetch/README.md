# Fetch over WiFi

Connects to WiFi and fetches JSON from an HTTP API.

```sh
npm create mikrojs my-wifi-fetch --template wifi-fetch
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
npx mikro env list                            # verify
```

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

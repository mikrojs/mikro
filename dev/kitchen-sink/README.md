# Kitchen Sink

Exercises many mikrojs features in one project. Not a clean learning example — more of a feature checklist and stress test.

Covers: ES module imports (static + dynamic), JSON/text imports, filesystem access, GPIO, board pin definitions, WiFi, HTTP fetch, timers, GC, error handling, and `mikro.config.ts`.

## Environment variables

For local development, create a `.env` file:

```
WIFI_SSID=YourNetwork
WIFI_PASSPHRASE=YourPassword
```

To set env vars on the device (persisted in NVS):

```sh
pnpm mikro env set WIFI_SSID YourNetwork
pnpm mikro env set --secret WIFI_PASSPHRASE   # prompts for value
```

## Run

```sh
pnpm mikro dev       # develop on connected device
pnpm mikro deploy    # build and deploy to device
```

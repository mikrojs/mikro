# SNTP Time Sync

Connects to WiFi and syncs the device clock via NTP so `new Date()` returns real wall-clock time.

```sh
npm create mikrojs my-sntp --template sntp
```

## Environment variables

For local development, create a `.env` file:

```
WIFI_SSID=YourNetwork
WIFI_PASSPHRASE=YourPassword
```

To set env vars on the device (persisted in NVS):

```sh
npx mikro env set WIFI_SSID YourNetwork
npx mikro env set --secret WIFI_PASSPHRASE   # prompts for value
```

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro build     # build for deployment
```

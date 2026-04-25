# WiFi Access Point

Turns the ESP32 into a WiFi access point. Logs station connect/disconnect events and periodically lists connected clients.

```sh
npm create mikrojs my-wifi-ap --template wifi-access-point
```

After deploying, a network appears:

- **SSID:** MikroJS-AP
- **Password:** hello1234

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

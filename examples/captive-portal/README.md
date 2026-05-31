# Captive Portal

Turns the device into a WiFi captive portal: it runs an access point, answers
every DNS lookup with its own IP, and serves the same page for every request.
When you join the network, your phone or laptop's connectivity check fails to
reach the internet, so it opens the page automatically.

```sh
npm create mikro -- --template captive-portal
```

After deploying, an open network **MikroJS-Portal** appears (no password, the
way captive portals normally work).

Join it and a sign-in page should open on its own. If it doesn't, open
`http://192.168.4.1/` (the AP IP is printed on boot).

## How it works

- `wifi.ap.start(...)` brings up an open access point.
- A `mikro/udp` socket on port 53 answers every DNS query with the device's IP,
  so the client's captive-portal probe lands here.
- The HTTP server serves the same page for every path, which is what triggers
  the OS sign-in sheet.

Auto-popup behavior depends on the client OS; manual access via the AP IP always
works.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

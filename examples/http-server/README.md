# HTTP Server

Joins an existing WiFi network and serves a small HTTP API on the local
network: a JSON status endpoint, a route with a path param, and a server-sent
events stream.

```sh
npm create mikro -- --template http-server
```

Set your network credentials in `.env`:

```sh
WIFI_SSID=your-network
WIFI_PASSPHRASE=your-password
```

The device prints its IP on boot. Open `http://<that-ip>/`.

## Endpoints

- `GET /`: an HTML index
- `GET /api/status`: JSON uptime and free heap
- `GET /api/echo/:msg`: echoes the path param as JSON
- `GET /events`: a short server-sent events stream

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```

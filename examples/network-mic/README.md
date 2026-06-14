# Network Mic

Turns the ESP32 into a network microphone: it captures an ICS-43434 over I2S and serves the live audio over HTTP. Open the URL in a browser, or play it from any media player.

Mono 48 kHz signed-16-bit PCM, two endpoints:

- `GET /stream.wav`: WAV (streaming header + PCM). Open `http://<ip>/stream.wav` in a browser, run `ffplay http://<ip>/stream.wav`, or open in VLC
- `GET /stream.raw`: headerless PCM. `ffplay -f s16le -ar 48000 -ch_layout mono http://<ip>/stream.raw`

## Hardware

Wire the ICS-43434 to your board (defaults in `app/main.ts`):

```
   ICS-43434              ESP32
  ┌───────────┐
  │  VDD ─────┼───────────── 3V3
  │  GND ─────┼───────────── GND
  │  SCK ─────┼───────────── GPIO 4   (bclk)
  │  WS  ─────┼───────────── GPIO 5   (ws)
  │  SD  ─────┼───────────── GPIO 6   (din)
  │  L/R ─────┼───────────── GND      (left channel)
  └───────────┘
```

Power from 3V3 (not 5V tolerant). Tie L/R (SEL) to GND so the mic drives the left slot that `channels: 'mono'` reads.

The ICS-43434's usable sample-rate range is roughly 23-51 kHz. Rates below it (e.g. 16 kHz) read silent, so the example uses 48 kHz.

## Run

Set your WiFi credentials, then deploy:

```sh
cp .env.example .env   # fill in WIFI_SSID and WIFI_PASSPHRASE
npx mikro flash        # only needed once per board
npx mikro dev          # develop on connected device
```

The device prints the stream URL on connect. Open `http://<ip>/stream.wav` in a browser to listen, or use ffplay/VLC. The ICS-43434 is quiet, so it streams faithful 16-bit levels; use the browser or player volume to monitor.

## Notes

- The HTTP server handles one connection at a time, so this is a single-listener demo (one player). A second connection waits for the first to close.
- Audio is delivered as plain HTTP chunked transfer, so any player that streams a URL (ffplay, VLC, mpv) works.

---
title: Network Mic
description: Stream an ICS-43434 I2S microphone over HTTP and play it in any media player
---

# Network Mic

Turn the ESP32 into a network microphone: capture an ICS-43434 over I2S and serve the live audio over HTTP. Open the URL in a browser, or play it from ffplay, VLC, mpv, or any player that streams a URL. It combines [i2s](/api/i2s), [http/server](/api/http-server), and [wifi](/api/wifi).

The ICS-43434 is 24-bit data left-justified in 32-bit I2S slots, so we read 32-bit and shift down to 16-bit PCM (mono, 48 kHz) for a WiFi-friendly ~96 KB/s stream.

## Hardware

- Any ESP32 board with three available GPIO pins and WiFi
- An InvenSense ICS-43434 I2S microphone
- USB cable

<Ics43434Diagram />

Power the mic from 3V3 (it is not 5V tolerant). Tie L/R (SEL) to GND so it drives the left slot that `channels: 'mono'` reads.

## Endpoints

The app serves the same mono 48 kHz signed-16-bit PCM two ways:

| Path          | Use                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------- |
| `/stream.wav` | WAV (streaming header + PCM): open in a browser, `ffplay http://<ip>/stream.wav`, or VLC |
| `/stream.raw` | Headerless PCM: `ffplay -f s16le -ar 48000 -ch_layout mono http://<ip>/stream.raw`       |

## How it works

The mic is opened once. Each HTTP request's response `body` is an async generator that yields PCM frames forever; the server awaits each chunk (backpressure) and stops pulling when the client disconnects, ending the generator.

The key to sustaining 48 kHz is [`mic.capture()`](/api/i2s#i2s-capture-frames-options): it reads a frame and packs it to 16-bit PCM in one native call, with no per-chunk JS allocation. It blocks the loop for ~100 ms per frame, which is fine here: the HTTP server runs on its own task and flushes the previous chunk while the next is captured.

```ts
async function* audioBody(withHeader: boolean) {
  if (withHeader) yield wavHeader()
  for (;;) {
    const pcm = mic.capture(FRAME) // Int16Array: read + 32→16-bit pack done in C
    if (!pcm.ok) break
    yield new Uint8Array(pcm.value.buffer, pcm.value.byteOffset, pcm.value.byteLength)
  }
}

const server = createServer((req) => {
  const path = req.url.split('?')[0]
  if (path === '/stream.wav')
    return {status: 200, headers: {'content-type': 'audio/wav'}, body: audioBody(true)}
  if (path === '/stream.raw')
    return {
      status: 200,
      headers: {'content-type': 'audio/L16; rate=48000; channels=1'},
      body: audioBody(false),
    }
  return {status: 404, body: 'not found'}
})
server.listen({port: 80})
```

The `/stream.wav` endpoint prepends a 44-byte WAV header with streaming sizes (`0xFFFFFFFF`, unknown length), so a player reads the format then streams the data until the connection closes. `/stream.raw` is the same PCM with no header, for tools you tell the format to on the command line.

## Run

Set your WiFi credentials, then deploy:

::: code-group

```sh [pnpm]
cp .env.example .env   # fill in WIFI_SSID and WIFI_PASSPHRASE
pnpm mikro flash       # only needed once per board
pnpm mikro dev         # develop on connected device
```

```sh [npm]
cp .env.example .env   # fill in WIFI_SSID and WIFI_PASSPHRASE
npx mikro flash        # only needed once per board
npx mikro dev          # develop on connected device
```

:::

The device prints the stream URL on connect. Open `http://<ip>/stream.wav` in a browser to listen, or run `ffplay http://<ip>/stream.wav`. The ICS-43434 is a quiet mic, so raise `GAIN_BITS` in `app/main.ts` if you want a louder stream.

## Limitations

- The HTTP server handles one connection at a time, so this is a single-listener demo (one player). A second connection waits for the first to close.

[View source on GitHub](https://github.com/mikrojs/mikro/tree/main/examples/network-mic)

# sram-pressure

Synthetic dev fixture for HTTPS handshake failures caused by internal-SRAM
fragmentation on ESP32. mbedTLS handshake buffers must come from contiguous
internal SRAM, where they compete with QuickJS heap chunks; on PSRAM-equipped
chips, combined `systemFree` is dominated by external RAM and hides the
pressure entirely.

## What it does

1. Connects to WiFi.
2. Performs an HTTPS GET against `TARGET_URL`.
3. Allocates `STEP_KB` of small retained JS objects (held in a global array
   so they cannot be collected).
4. Repeats steps 2 and 3 until the request fails or `MAX_STEPS` is reached.

The goal is to reproduce, deterministically and without depending on any
specific feature, the failure mode where retained JS state in internal SRAM
starves the mbedTLS handshake even though `memoryUsage()` reports plenty of
free heap (PSRAM is fine, internal is not).

## Required env vars

- `WIFI_SSID`
- `WIFI_PASSPHRASE`

## Optional env vars

- `TARGET_URL` (default: `https://jsonplaceholder.typicode.com/posts/1`)
- `STEP_KB` (default: `8`) bytes of ballast added per step
- `MAX_STEPS` (default: `20`) maximum number of steps before giving up

## Run

```sh
npm install
npm run dev
```

## Reading the output

Each step prints `pressure=<kb>` (cumulative ballast),
`systemLargest` (largest contiguous free block, combined internal+PSRAM)
and `heapUsed` (QuickJS heap). Watch for the request to fail with a
non-zero error while `systemLargest` still looks healthy. That gap is the
diagnostic gap motivating internal-RAM stats in `memoryUsage()`.

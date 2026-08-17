# tls-churn

Measures heap fragmentation across repeated TLS connections, on the device
itself. Built to verify the network trims on `fix/tls-heap-margin`: the
observed failure was the largest free block ratcheting down a little on every
HTTPS round until a handshake could no longer allocate its ~16.5 KB input
buffer.

## Run

Flash the firmware you want to measure (from `esp32/`), then:

```sh
npm run dev
```

WiFi credentials come from `WIFI_SSID` / `WIFI_PASSPHRASE` — already in NVS if
the device ran another example, otherwise put them in `.env` here.

Each round prints one line:

```
churn 4/20: 200 (312 bytes) in 1843ms | pre sysFree=41520 largest=17408 | post sysFree=39872 largest=15360 jsUsed=136068
```

## Reading it

Watch the `pre largest` column across rounds:

- **Settles after the first couple of rounds**: the build holds. Residue from
  each connection is reclaimed before the next one needs the heap.
- **Ratchets down every round**: connection residue outlives the interval.
  With a short `CHURN_INTERVAL` this is expected on builds without the
  MSL trim (TIME_WAIT holds sockets for 2xMSL); if it persists with the trim,
  TIME_WAIT was not the mechanism and session reuse is the next lever.

Knobs, via env: `CHURN_URL`, `CHURN_INTERVAL` (default 10000 — deliberately
harsher than the OTA client's 30s floor), `CHURN_ROUNDS` (default 20),
`CHURN_LOG_EVERY` (default 1 — log every Nth round, to separate a
per-connection leak from a per-log-line one).

For an A/B: flash the previous firmware, run, flash the trimmed firmware, run,
and compare the two `pre largest` columns at the same interval.

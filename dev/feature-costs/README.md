# feature-costs

Measures the system heap cost of each native subsystem on the device itself,
one phase at a time. Built to replace the unmeasured figures behind the
`memReserved` default (the `mik_main.cpp` comment and the docs table disagree
on what WiFi costs) with a per-chip table.

Phases, in increasing order of demand:

1. **baseline** after boot residue drains
2. **radio up (scan)** — WiFi driver + radio, no association
3. **connected** — association, DHCP, netif
4. **http request** — plain HTTP over the connection
5. **https request (TLS)** — the handshake is the biggest transient
6. **after radio shutdown** — what `wifi.disconnect()` gives back

## Run

Flash the firmware you want to measure (from `esp32/`), then:

```sh
npm run dev
```

WiFi credentials come from `WIFI_SSID` / `WIFI_PASSPHRASE` — already in NVS if
the device ran another example, otherwise put them in `.env` here.

Each phase prints one line:

```
connected: cost=12456 peak=18320 | sysFree=182040 largest=110592 minFree=163720
```

`cost` is the settled heap the phase left behind. `peak` is how far the phase
dug below the all-time low watermark; `systemMinFree` is monotonic since boot,
which is why the phases run smallest-first — a deep early phase would mask a
later smaller peak, and a `peak` of 0 means the phase never went below the low
set by an earlier one.

The sequence runs twice by default, and the two rounds answer different
questions. Round 1 starts from a boot-polluted baseline (a first run on the
C6 showed ~17 KB of boot allocations still draining, visible as a negative
residue) but owns the `peak` figures, since the watermark cannot be reset.
Round 2 starts from the post-shutdown floor: read settled costs from round 2,
peaks from round 1. For leak hunting, compare successive `baseline` lines
rather than the residue line — baseline-to-baseline drift is the true
per-cycle cost (a 4-round C6 run measured −28 B/cycle, i.e. nothing).

## Knobs

| Env              | Default                     | Meaning                        |
| ---------------- | --------------------------- | ------------------------------ |
| `COST_SETTLE`    | `3000`                      | ms to wait before each reading |
| `COST_ROUNDS`    | `2`                         | full cycles to run             |
| `COST_HTTP_URL`  | `http://httpbingo.org/get`  | plain HTTP target              |
| `COST_HTTPS_URL` | `https://httpbingo.org/get` | TLS target                     |

Readings include a few hundred bytes of noise from the script's own JS
allocations and log lines. Good for a cost table; use `tls-churn` for
leak/fragmentation hunting.

On PSRAM boards `cost` mixes both pools and can hide internal-SRAM pressure —
read `intCost`/`intFree`/`intLargest` there instead, since the WiFi driver,
DMA buffers, and mbedTLS handshake buffers must land in internal RAM. There is
no internal watermark, so transient internal peaks are not visible, only
settled costs.

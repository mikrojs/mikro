# Probe

Measures steady-state import retention of every `mikro/*` builtin on the target device.

Deploy and the device will print a per-module line (`delta=<KB>`) for each builtin it can load, followed by a ranked summary. Use this to pick optimization targets (e.g. don't import `mikro/http/request` just to get a type) and to spot regressions after changing the runtime.

```sh
pnpm mikro deploy
```

Results are approximate: heap allocator layout varies run-to-run by ±1–2 KB per module. Totals are reliable.

Modules that fail to load (e.g. `ble` on builds without BLE enabled) are reported and skipped.

# module-costs

Measures what importing each builtin module costs on the device: one
`mikro test` file per public `mikro/*` export, each running in a fresh runtime
and doing nothing but `await import('mikro/<name>')`. The runner records each
file's retained heap in `__heap_snapshots__/<chip>.json`, committed here, so a
builtin that grows shows up as a diff.

`test/_baseline.test.ts` imports nothing and measures the harness itself. A
module's cost is its figure minus the baseline's:

```sh
pnpm report
```

Rules the census files follow:

- The import is dynamic and inside the test body. A static import is loaded
  before the harness takes its baseline, and `beforeAll` is rebaselined away.
- One suite, one test. Shared dependencies are charged to every module that
  pulls them in: the figure answers "what do I pay to import X", not the
  marginal cost after something else is loaded.
- `mikro/sys` and `mikro/test` have no file. The harness imports both, so their
  cost sits inside the baseline and cannot be seen from a test.
- Chip-gated modules (`mikro/ble`) use `describe.runIf` on `board.features`.
  `mikro/http/server` and `mikro/i2s` are firmware-only and skip on the
  simulator via `MIKRO_ENV`. A file whose only test is skipped records nothing
  for that chip.

`scripts/census.spec.ts` fails `pnpm vitest` when the `mikro` exports map and
the census files disagree.

## Run

Flash the firmware you want to measure (from `esp32/`), then:

```sh
pnpm test -u --port <port>
```

`-u` writes the new figures; without it the run only compares. Every chip has
its own file, so re-measure each chip after a firmware change that moves the
numbers. `pnpm test:sim` measures the JS heap side on the host and writes
`simulator.json`; it runs without hardware, and the root `pnpm test:sim` (run
by CI) compares against it on every PR.

Read the report to about 512 bytes. The runner leaves a stored figure alone
while it drifts less than 256 bytes or 1%, and a cost is the difference of two
such figures. A module that shrinks is only flagged as stale once it drops by a
quarter of its raw figure, pedestal included, so small improvements stay
unrecorded until the next `-u`.

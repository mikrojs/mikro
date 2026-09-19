# Changelog

## 0.21.0 (2026-09-19)

### Breaking changes

- replace constructors and begin() with factories ([#387](https://github.com/mikrojs/mikro/pull/387))
- **gpio:** replace mikro/pin with GPIO instances ([#385](https://github.com/mikrojs/mikro/pull/385))

### Features

- **cli:** report packages the build deploys more than once ([#402](https://github.com/mikrojs/mikro/pull/402))
- **result:** make the orPanic message optional ([#386](https://github.com/mikrojs/mikro/pull/386))
- **observable:** add state() and a full operator set ([#383](https://github.com/mikrojs/mikro/pull/383))

### Bug fixes

- **cli:** print one line instead of a stack trace when esptool fails ([#406](https://github.com/mikrojs/mikro/pull/406))
- **cli:** deploy symlinked packages where the device resolves them ([#403](https://github.com/mikrojs/mikro/pull/403))
- **deploy:** redeploy when the build only removes files ([#401](https://github.com/mikrojs/mikro/pull/401))
- **cli:** prevent same package from being deployed twice in linked workspaces ([#398](https://github.com/mikrojs/mikro/pull/398))
- **timers:** make intervals drift-free ([#381](https://github.com/mikrojs/mikro/pull/381))
- **deps:** add `@optique` packages to catalog, update to v1.2.5 ([#371](https://github.com/mikrojs/mikro/pull/371))
- **ota:** stop a failed nvs read from handing back the retry budget ([#369](https://github.com/mikrojs/mikro/pull/369))
- **ota:** keep a decline record in case nvs read fails ([#370](https://github.com/mikrojs/mikro/pull/370))
- **kv:** stop a throwing read handler from deleting stored data ([#368](https://github.com/mikrojs/mikro/pull/368))
- improve error logging pattern ([#367](https://github.com/mikrojs/mikro/pull/367))
- **runtime:** report failing imports instead of silently hanging ([#365](https://github.com/mikrojs/mikro/pull/365))

### Other

- **deps:** update dependency wrangler to v4.134.0 ([#409](https://github.com/mikrojs/mikro/pull/409))
- **deps:** update dependency vite to v8.3.0 ([#407](https://github.com/mikrojs/mikro/pull/407))
- **deps:** update dependency vitepress-plugin-llms to v1.14.0 ([#408](https://github.com/mikrojs/mikro/pull/408))
- **deps:** update dependency knip to v6.37.0 ([#404](https://github.com/mikrojs/mikro/pull/404))
- **deps:** update dependency @optique/run to v1.3.0 ([#400](https://github.com/mikrojs/mikro/pull/400))
- **deps:** update dependency open to v11.0.4 ([#393](https://github.com/mikrojs/mikro/pull/393))
- **deps:** update dependency @optique/core to v1.3.0 ([#399](https://github.com/mikrojs/mikro/pull/399))
- **deps:** update vitest monorepo to v5.0.1 ([#396](https://github.com/mikrojs/mikro/pull/396))
- **deps:** update dependency @clack/prompts to v1.8.1 ([#397](https://github.com/mikrojs/mikro/pull/397))
- **deps:** update dependency vue to v3.5.43 ([#395](https://github.com/mikrojs/mikro/pull/395))
- **deps:** update dependency prettier to v3.9.8 ([#394](https://github.com/mikrojs/mikro/pull/394))
- **deps:** update dependency lefthook to v2.1.14 ([#392](https://github.com/mikrojs/mikro/pull/392))
- **deps:** update pnpm/setup digest to 84cb39b ([#377](https://github.com/mikrojs/mikro/pull/377))
- **deps:** update dependency @types/node to v24.13.5 ([#390](https://github.com/mikrojs/mikro/pull/390))
- **deps:** update dependency eslint-plugin-package-json to v1.8.1 ([#391](https://github.com/mikrojs/mikro/pull/391))
- **deps:** update pnpm to v12.4.2 ([#389](https://github.com/mikrojs/mikro/pull/389))
- **deps:** update pnpm to v12.4.1 ([#384](https://github.com/mikrojs/mikro/pull/384))
- **deps:** update dependency oxfmt to ^0.68.0 ([#388](https://github.com/mikrojs/mikro/pull/388))
- **deps:** update zizmorcore/zizmor-action action to v0.6.4 ([#382](https://github.com/mikrojs/mikro/pull/382))
- add heap memory snapshots for esp32 ([#380](https://github.com/mikrojs/mikro/pull/380))
- **deps:** update dependency oxfmt to ^0.67.0 ([#379](https://github.com/mikrojs/mikro/pull/379))
- consolidate pnpm and node setup with pnpm/setup v2 action ([#376](https://github.com/mikrojs/mikro/pull/376))
- **deps:** update dependencies and actions to latest ([#372](https://github.com/mikrojs/mikro/pull/372))
- exclude submodule dependencies from taze version checking ([#374](https://github.com/mikrojs/mikro/pull/374))

## 0.20.1 (2026-09-05)

### Features

- **firmware:** enable custom firmware to disable WiFi stack ([#363](https://github.com/mikrojs/mikro/pull/363))

## 0.20.0 (2026-09-05)

### Breaking changes

- **ota:** drop the step primitives report() and settle() subsume ([#355](https://github.com/mikrojs/mikro/pull/355))

### Features

- **dev:** census the retained heap of importing each builtin ([#362](https://github.com/mikrojs/mikro/pull/362))
- **watchdog:** add watchdog support ([#359](https://github.com/mikrojs/mikro/pull/359))
- **ota:** let own-transport clients report a declined offer ([#353](https://github.com/mikrojs/mikro/pull/353))

### Bug fixes

- **test:** keep the boot gate steady across a memReserved change ([#361](https://github.com/mikrojs/mikro/pull/361))
- **test:** measure retained heap per suite ([#360](https://github.com/mikrojs/mikro/pull/360))
- **repl:** keep serving through the panic grace window ([#358](https://github.com/mikrojs/mikro/pull/358))
- resume device when runtime pause times out during deploy ([#356](https://github.com/mikrojs/mikro/pull/356))

### Other

- **e2e:** update heap snapshots after memory optimization ([#357](https://github.com/mikrojs/mikro/pull/357))

## 0.19.0 (2026-08-30)

### Breaking changes

- **cli:** key heap snapshots by chip and tolerate small drift ([#347](https://github.com/mikrojs/mikro/pull/347))

### Features

- **schema:** make the DSL native to cut heap and check bounds on device ([#352](https://github.com/mikrojs/mikro/pull/352))
- gate features on both silicon and compiled stack ([#346](https://github.com/mikrojs/mikro/pull/346))
- schema annotations ([#344](https://github.com/mikrojs/mikro/pull/344))
- **ota:** fold the own-transport check-in into report() and settle() ([c8ae3dc](https://github.com/mikrojs/mikro/commit/c8ae3dcaa175928b2a1516b74ea1e0259f64e262))

### Bug fixes

- **firmware:** memReserved guardrails and measured heap diagnostics ([#350](https://github.com/mikrojs/mikro/pull/350))
- **test:** fail on beforeAll errors and tweak e2e memory gates ([#348](https://github.com/mikrojs/mikro/pull/348))
- **ota:** make watch() error on an un-enrolled device ([#345](https://github.com/mikrojs/mikro/pull/345))
- **firmware:** fsync log-file flushes so they survive a crash and read back live ([324b510](https://github.com/mikrojs/mikro/commit/324b510a42a2d9da0928aeeb4ec5b375d160a3a5))

### Performance

- **native:** port http request/helpers and wifi builtins to c++ ([#349](https://github.com/mikrojs/mikro/pull/349))
- **native:** drop the per-allocation size header on ESP32 ([b229c0b](https://github.com/mikrojs/mikro/commit/b229c0b3d9b35795c86a30a17ce53e62dada2f7e))
- **firmware:** allocate log-file buffers only when logging is configured ([122ff22](https://github.com/mikrojs/mikro/commit/122ff22fd44ef130ad187546851a70ccf0c0ce8d))
- **firmware:** allocate test-supervisor scratch only during test runs ([3257c77](https://github.com/mikrojs/mikro/commit/3257c776a0405dcce365cadfe7031a975a8e2a81))
- **firmware:** make assert() silent to unpin its strings from RAM ([c77a687](https://github.com/mikrojs/mikro/commit/c77a687a7500232f29d175c1737d0f7608d0c412))
- **firmware:** drop the extra WiFi IRAM optimization ([12e0a0d](https://github.com/mikrojs/mikro/commit/12e0a0dcf3491df15e4b3c9263a0224d529b539c))
- **firmware:** run the WiFi modem-sleep RX path from flash ([6f7204d](https://github.com/mikrojs/mikro/commit/6f7204d8b4b583e67b847299b5a172983f33b673))

### Other

- **ota:** copy edits ([#351](https://github.com/mikrojs/mikro/pull/351))
- **repo:** record the heap-accounting change and refresh the optimize skill ([dbb72cd](https://github.com/mikrojs/mikro/commit/dbb72cd82be888c6e2236772f4835c4ca244a7cd))
- **repo:** cover the modem-sleep wake path and the file logger ([5220dbd](https://github.com/mikrojs/mikro/commit/5220dbdf5eb89dcdaa167602db1bf00d78061015))
- stop cold-start suites timing out under concurrent load ([#340](https://github.com/mikrojs/mikro/pull/340))

# Changelog

## 0.16.0 (2026-06-18)

### Breaking changes

- **wifi:** configure txPower on connect, power radio down on disconnect ([#250](https://github.com/mikrojs/mikro/pull/250))

## 0.15.0 (2026-06-14)

### Breaking changes

- **native:** scope `native:` module names to their owning package ([#243](https://github.com/mikrojs/mikro/pull/243))

### Features

- **i2s:** add I2S audio module for mic capture and playback ([#246](https://github.com/mikrojs/mikro/pull/246))

### Bug fixes

- **native:** export runtime/i2s/types from the published package ([#248](https://github.com/mikrojs/mikro/pull/248))
- **firmware:** stop spi/uart/i2c write over-reading buffer views ([#247](https://github.com/mikrojs/mikro/pull/247))
- **cli:** treat native: specifiers as firmware builtins in the tracer ([#245](https://github.com/mikrojs/mikro/pull/245))
- **release:** apply quickjs patches before packing tarball ([#242](https://github.com/mikrojs/mikro/pull/242))
- **repl:** echo input immediately instead of waiting on device timing ([#240](https://github.com/mikrojs/mikro/pull/240))

### Other

- **drivers:** use a publishable `@my-scope` single-package example ([#244](https://github.com/mikrojs/mikro/pull/244))

## 0.14.0 (2026-06-13)

### Features

- **docs:** publish llms.txt for AI coding assistants ([#230](https://github.com/mikrojs/mikro/pull/230))
- **cli:** offer to reflash incompatible device firmware ([#227](https://github.com/mikrojs/mikro/pull/227))

### Bug fixes

- **firmware:** fix external build issues ([#229](https://github.com/mikrojs/mikro/pull/229))
- **native:** keep '/*' out of a block comment ([#239](https://github.com/mikrojs/mikro/pull/239))
- **releaser:** order prerelease versions by publish time ([#236](https://github.com/mikrojs/mikro/pull/236))
- **firmware:** make third-party driver packages work in custom firmware builds ([#235](https://github.com/mikrojs/mikro/pull/235))
- **cli:** keep reflash prompt hints from reading as a menu ([#234](https://github.com/mikrojs/mikro/pull/234))
- **firmware:** pick up version changes without a clean build ([#233](https://github.com/mikrojs/mikro/pull/233))
- **cli:** don't flag identical prerelease firmware as incompatible ([#232](https://github.com/mikrojs/mikro/pull/232))
- **wifi:** refuse start under low heap instead of PHY abort ([#225](https://github.com/mikrojs/mikro/pull/225))
- **firmware:** guard MIK_InitPromise OOM to avoid gc_decref double-free ([#224](https://github.com/mikrojs/mikro/pull/224))

### Other

- **release:** mint the App token before release-PR guard ([#238](https://github.com/mikrojs/mikro/pull/238))
- **release:** guard the release PR from being merged mid-regeneration ([#237](https://github.com/mikrojs/mikro/pull/237))
- **repo:** drop leftover CommonJS require() ([#228](https://github.com/mikrojs/mikro/pull/228))
- **deps:** update dependency prettier to v3.8.4 ([#222](https://github.com/mikrojs/mikro/pull/222))

## 0.13.0 (2026-06-11)

### Features

- **examples:** enable log file in every example ([#219](https://github.com/mikrojs/mikro/pull/219))
- **logs:** add `mikro logs reset` to clear on-device log files ([#209](https://github.com/mikrojs/mikro/pull/209))
- **native:** expose last reset reason via sys.resetReason ([5df308f](https://github.com/mikrojs/mikro/commit/5df308f209d6361084b14de1ccf1dbd925d0ee14))

### Bug fixes

- **http:** name out-of-memory when an alloc-class TLS error surfaces ([#220](https://github.com/mikrojs/mikro/pull/220))
- **native:** keep cycle GC and the idle task alive through long job storms ([#216](https://github.com/mikrojs/mikro/pull/216))
- **native:** ship abort polyfill as precompiled bytecode ([#217](https://github.com/mikrojs/mikro/pull/217))
- **cli:** make `mikro test` survive slow devices and missing results ([#215](https://github.com/mikrojs/mikro/pull/215))
- **native:** unbreak the simulator after the quickjs-ng v0.15 upgrade ([#214](https://github.com/mikrojs/mikro/pull/214))
- **repl:** follow device by USB serial across port changes on reconnect ([#212](https://github.com/mikrojs/mikro/pull/212))
- **native:** defer unhandled-rejection reporting to end of turn ([05e10f8](https://github.com/mikrojs/mikro/commit/05e10f8c5fe3df793db89e317e2c0677e1437ef4))

### Other

- **deps:** update dependency oxfmt to ^0.53.0 ([#201](https://github.com/mikrojs/mikro/pull/201))
- refresh esp32-optimize and correct binaryObjectSize ([#221](https://github.com/mikrojs/mikro/pull/221))
- **e2e:** fit the suite on esp32c3's ~172KB JS heap ([#218](https://github.com/mikrojs/mikro/pull/218))
- **deps:** update pnpm to v11.5.3 ([#207](https://github.com/mikrojs/mikro/pull/207))
- **deps:** update dependency wrangler to v4.96.0 ([#202](https://github.com/mikrojs/mikro/pull/202))

## 0.12.0 (2026-06-01)

### Breaking changes

- **firmware:** read the device id from the base MAC ([#191](https://github.com/mikrojs/mikro/pull/191))

### Features

- **test:** report per-suite memory used and OOM margin ([#197](https://github.com/mikrojs/mikro/pull/197))
- **cli:** read devices on mismatched firmware for post-mortem ([#194](https://github.com/mikrojs/mikro/pull/194))
- **firmware:** show the device id in the boot banner ([#190](https://github.com/mikrojs/mikro/pull/190))
- add support for http/server ([#187](https://github.com/mikrojs/mikro/pull/187))
- **cli:** support device aliases ([#188](https://github.com/mikrojs/mikro/pull/188))

### Bug fixes

- **repl:** don't reboot the device on a REPL eval error ([#189](https://github.com/mikrojs/mikro/pull/189))

### Other

- **deps:** update dependency knip to v6.15.0 ([#196](https://github.com/mikrojs/mikro/pull/196))
- **docs:** deploy docs from CI, gate production on stable releases ([#193](https://github.com/mikrojs/mikro/pull/193))
- **cli:** document device aliases and naming ([#192](https://github.com/mikrojs/mikro/pull/192))
- **paths:** resolve per-user cache/config dirs via env-paths ([5276449](https://github.com/mikrojs/mikro/commit/5276449e76ea4330044a22e686d8f0ccd81ddb00))

## 0.11.0 (2026-05-31)

### Features

- **create:** accept human-friendly project names by slugifying ([#183](https://github.com/mikrojs/mikro/pull/183))

### Other

- **deps:** replace `@vercel/detect-agent` with std-env ([#184](https://github.com/mikrojs/mikro/pull/184))
- **deps:** update dependency eslint-plugin-package-json to v1.2.0 ([#159](https://github.com/mikrojs/mikro/pull/159))
- **deps:** update dependency node-addon-api to v8.8.0 ([#146](https://github.com/mikrojs/mikro/pull/146))
- **deps:** update dependency eslint to v10.4.1 ([#176](https://github.com/mikrojs/mikro/pull/176))
- **deps:** update dependency ink to v7.0.5 ([#177](https://github.com/mikrojs/mikro/pull/177))
- **deps:** update dependency @clack/prompts to v1.5.0 ([#170](https://github.com/mikrojs/mikro/pull/170))
- **deps:** update dependency npm-run-all2 to v9 ([0845c05](https://github.com/mikrojs/mikro/commit/0845c051dc324227dea4e7af5dde364fb7ce3ba2))
- **deps:** catalog vitest pair and pin react-hooks to stable ([ed86aae](https://github.com/mikrojs/mikro/commit/ed86aae79e0b4a9b7a61d78fb5548bc81fdbfe23))
- **create:** drop broken `cd my-*` follow-ups after create ([9e69d7f](https://github.com/mikrojs/mikro/commit/9e69d7f9a1bf78b92b2c7ccf653b5fe091e0e805))
- rename mikrojs to mikro throughout documentation and examples ([846a139](https://github.com/mikrojs/mikro/commit/846a139fb44230b121427041e2902bc9896f6b54))
- add npmx package link to social nav ([d46eda0](https://github.com/mikrojs/mikro/commit/d46eda035195e83b394c8edf6e28659987c2cc0c))

## 0.10.0 (2026-05-30)

### Breaking changes

- **mikro:** rename mikrojs package to mikro ([c6b643a](https://github.com/mikrojs/mikro/commit/c6b643af03cd0fcc528c48a4cc2ae21493fa4f1f))

### Bug fixes

- **cli:** silence node strip-types ExperimentalWarning in output ([#174](https://github.com/mikrojs/mikro/pull/174))

### Other

- **ci:** publish release PR previews to the `next` dist-tag ([#175](https://github.com/mikrojs/mikro/pull/175))
- **scripts:** make trust-setup declarative ([#173](https://github.com/mikrojs/mikro/pull/173))
- **create-mikrojs:** re-add as thin alias for create-mikro ([91f151f](https://github.com/mikrojs/mikro/commit/91f151f001036604d5074456fc4d434fdabc3f71))
- **mikrojs:** re-add as deprecation stub pointing to mikro ([a2dcc08](https://github.com/mikrojs/mikro/commit/a2dcc084014d2601026d420c2d59a2dd8ac16e79))

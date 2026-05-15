# Changelog

## 0.7.0 (2026-05-15)

### Breaking changes

- **runtime:** yield Result from streaming APIs ([#103](https://github.com/mikrojs/mikrojs/pull/103))
- **runtime:** always restart on uncaught error ([#93](https://github.com/mikrojs/mikrojs/pull/93))
- **runtime:** add on-device file logging via `mikro logs pull` ([#92](https://github.com/mikrojs/mikrojs/pull/92))

### Features

- **docs:** improve vitepress theme ([#101](https://github.com/mikrojs/mikrojs/pull/101))
- **create-mikrojs:** scaffold with TS only, mikro.config.ts and prettier defaults ([#97](https://github.com/mikrojs/mikrojs/pull/97))
- **cli:** quiet `mikro flash` output and show next steps ([#94](https://github.com/mikrojs/mikrojs/pull/94))

### Bug fixes

- **release:** scope mikrodroid token to pull-requests for PR endpoints ([#109](https://github.com/mikrojs/mikrojs/pull/109))
- **runtime:** unhang uart.read() when end() races a pending next() ([#106](https://github.com/mikrojs/mikrojs/pull/106))
- **docs:** make brand hairline span the full navbar width ([#102](https://github.com/mikrojs/mikrojs/pull/102))

### Other

- **deps:** update dependency @clack/prompts to v1.4.0 ([#87](https://github.com/mikrojs/mikrojs/pull/87))
- **workflows:** add zizmor audit and harden workflows ([#107](https://github.com/mikrojs/mikrojs/pull/107))
- **deps:** update dependency tsx to v4.22.0 ([#108](https://github.com/mikrojs/mikrojs/pull/108))
- **e2e:** run sim suite on pre-commit and CI ([#105](https://github.com/mikrojs/mikrojs/pull/105))
- **deps:** update dependency wrangler to v4.91.0 ([#104](https://github.com/mikrojs/mikrojs/pull/104))
- **deps:** update dependency tsx to v4.21.1 ([#100](https://github.com/mikrojs/mikrojs/pull/100))
- remove .envrc file ([#99](https://github.com/mikrojs/mikrojs/pull/99))
- **deps:** update dependency ink to v7.0.3 ([#96](https://github.com/mikrojs/mikrojs/pull/96))
- **deps:** update pnpm to v11.1.2 ([#98](https://github.com/mikrojs/mikrojs/pull/98))
- **deps:** update dependency publint to v0.3.21 ([#95](https://github.com/mikrojs/mikrojs/pull/95))
- **deps:** update actions/create-github-app-token digest to bcd2ba4 ([#86](https://github.com/mikrojs/mikrojs/pull/86))
- **deps:** update pnpm/action-setup digest to 0e279bb ([#76](https://github.com/mikrojs/mikrojs/pull/76))
- **deps:** update pnpm to v11.1.1 ([#84](https://github.com/mikrojs/mikrojs/pull/84))
- **deps:** update dependency knip to v6.13.1 ([#90](https://github.com/mikrojs/mikrojs/pull/90))
- **deps:** update dependency knip to v6.13.0 ([#89](https://github.com/mikrojs/mikrojs/pull/89))
- **deps:** update dependency wrangler to v4.90.1 ([#88](https://github.com/mikrojs/mikrojs/pull/88))
- **deps:** update dependency oxfmt to ^0.49.0 ([#83](https://github.com/mikrojs/mikrojs/pull/83))

## 0.6.1 (2026-05-11)

### Bug fixes

- **repl:** suspend microtasks while paused so user JS can't race deploy ([#77](https://github.com/mikrojs/mikrojs/pull/77))

### Other

- **deps:** update dependency ink to v7.0.2 ([#48](https://github.com/mikrojs/mikrojs/pull/48))
- **deps:** update dependency react to v19.2.6 ([#54](https://github.com/mikrojs/mikrojs/pull/54))
- fix(firmware): halve TLS inbound buffer to free internal SRAM ([#78](https://github.com/mikrojs/mikrojs/pull/78))
- **workflows:** drop blacksmith for github-hosted runners ([#79](https://github.com/mikrojs/mikrojs/pull/79))

## 0.6.0 (2026-05-10)

### Breaking changes

- replace .on/.off with Observable streams ([#70](https://github.com/mikrojs/mikrojs/pull/70))
- **wifi:** drive country and hostname from mikro.config.ts ([#73](https://github.com/mikrojs/mikrojs/pull/73))

### Features

- **config:** reject mikrojs/* imports in mikro.config.ts ([#74](https://github.com/mikrojs/mikrojs/pull/74))
- **firmware:** add ESP32-C5 chip support ([#72](https://github.com/mikrojs/mikrojs/pull/72))
- **runtime:** allocate QuickJS heap from PSRAM by default ([8269c3f](https://github.com/mikrojs/mikrojs/commit/8269c3f61a48999a3948c8e05d6e6e3d82b69558))
- **sys:** expose internal-SRAM stats to spot hidden TLS pressure ([8f0cbe3](https://github.com/mikrojs/mikrojs/commit/8f0cbe31aef247a7d69a6dda9ca8acd01d09fb34))

### Bug fixes

- **observable:** pin operator types so twoslash infers through pipe ([#75](https://github.com/mikrojs/mikrojs/pull/75))
- **firmware:** halve TLS inbound buffer to free internal SRAM ([4a2ec0a](https://github.com/mikrojs/mikrojs/commit/4a2ec0ac2dcdde5b5c764ee9c908e4501903d098))

### Other

- **deps:** update pnpm/action-setup digest to 91ab88e ([#62](https://github.com/mikrojs/mikrojs/pull/62))
- upgrade esp-idf minimum version to 6.0.1 ([#68](https://github.com/mikrojs/mikrojs/pull/68))

## 0.5.1 (2026-05-10)

### Other

- **deps:** update dependency knip to v6.12.2 ([#67](https://github.com/mikrojs/mikrojs/pull/67))
- **deps:** update pnpm to v11.0.9 ([#46](https://github.com/mikrojs/mikrojs/pull/46))
- **deps:** update dependency npm to v11.14.1 ([#65](https://github.com/mikrojs/mikrojs/pull/65))
- **deps:** update dependency publint to v0.3.20 ([#64](https://github.com/mikrojs/mikrojs/pull/64))
- **deps:** update dependency vite to v8.0.11 ([#57](https://github.com/mikrojs/mikrojs/pull/57))
- **deps:** update dependency wrangler to v4.90.0 ([#61](https://github.com/mikrojs/mikrojs/pull/61))
- **deps:** update dependency knip to v6.12.1 ([#60](https://github.com/mikrojs/mikrojs/pull/60))
- **deps:** update dependency terser to v5.47.1 ([#59](https://github.com/mikrojs/mikrojs/pull/59))
- **deps:** update dependency terser to v5.47.0 ([#58](https://github.com/mikrojs/mikrojs/pull/58))
- **deps:** update dependency npm to v11.14.0 ([#56](https://github.com/mikrojs/mikrojs/pull/56))
- **deps:** update dependency knip to v6.12.0 ([#55](https://github.com/mikrojs/mikrojs/pull/55))
- **deps:** update dependency @types/estree to v1.0.9 ([#53](https://github.com/mikrojs/mikrojs/pull/53))
- **deps:** update dependency vue to v3.5.34 ([#52](https://github.com/mikrojs/mikrojs/pull/52))
- **deps:** update dependency wrangler to v4.88.0 ([#51](https://github.com/mikrojs/mikrojs/pull/51))
- **deps:** update dependency oxfmt to ^0.48.0 ([#50](https://github.com/mikrojs/mikrojs/pull/50))
- **deps:** update dependency publint to v0.3.19 ([#49](https://github.com/mikrojs/mikrojs/pull/49))
- **deps:** update dependency @swc/core to v1.15.33 ([#45](https://github.com/mikrojs/mikrojs/pull/45))
- **deps:** update pnpm to v11.0.4 ([#33](https://github.com/mikrojs/mikrojs/pull/33))
- **deps:** update pnpm/action-setup action to v6 ([#44](https://github.com/mikrojs/mikrojs/pull/44))
- **deps:** update dependency wrangler to v4.87.0 ([#43](https://github.com/mikrojs/mikrojs/pull/43))
- **deps:** update dependency oxfmt to ^0.47.0 ([#42](https://github.com/mikrojs/mikrojs/pull/42))
- **deps:** update dependency knip to v6.11.0 ([#41](https://github.com/mikrojs/mikrojs/pull/41))
- **deps:** update dependency eslint to v10.3.0 ([#36](https://github.com/mikrojs/mikrojs/pull/36))
- **deps:** update dependency globals to v17.6.0 ([#38](https://github.com/mikrojs/mikrojs/pull/38))
- **deps:** update dependency @clack/prompts to v1.3.0 ([#35](https://github.com/mikrojs/mikrojs/pull/35))
- **deps:** update typescript-eslint monorepo to v8.59.1 ([#34](https://github.com/mikrojs/mikrojs/pull/34))
- **deps:** update dependency knip to v6.10.0 ([#39](https://github.com/mikrojs/mikrojs/pull/39))
- **renovate:** minReleaseAge + enable automerge for dev deps ([#37](https://github.com/mikrojs/mikrojs/pull/37))
- **deps:** update pnpm to v11.0.3 ([#32](https://github.com/mikrojs/mikrojs/pull/32))
- **deps:** update dependency eslint-plugin-package-json to v0.91.2 ([#30](https://github.com/mikrojs/mikrojs/pull/30))
- **deps:** update dependency @swc/core to v1.15.33 ([#29](https://github.com/mikrojs/mikrojs/pull/29))
- Configure Renovate ([#27](https://github.com/mikrojs/mikrojs/pull/27))

## 0.5.0 (2026-05-02)

### Breaking changes

- **cli:** make env vars secret by default ([9b7bf7c](https://github.com/mikrojs/mikrojs/commit/9b7bf7c50b612d1336446d75c5e2eb4406a48169))

### Features

- add UDP datagram socket support with IPv4/IPv6 and multicast ([#26](https://github.com/mikrojs/mikrojs/pull/26))
- **releaser:** add --breaking-is-minor-on-0x for pre-major safety ([f5a1882](https://github.com/mikrojs/mikrojs/commit/f5a1882f155803db4666fbf58ee8748908d57965))
- **examples:** standardize .env.example across examples + scaffold ([f05f154](https://github.com/mikrojs/mikrojs/commit/f05f154e5b1f2ac93d3e5e15ccafd08222a46f07))

### Bug fixes

- **releaser:** drop +SHA build metadata that breaks provenance ([d226812](https://github.com/mikrojs/mikrojs/commit/d22681240bf032e7bf0ecb338198032fad460269))
- **release:** bump minor on breaking for pr releases too ([205e9c6](https://github.com/mikrojs/mikrojs/commit/205e9c6dde34856bca8759145033b7b9e14a3872))
- **releaser:** include !-bang breaking commits in changelog ([8a7f205](https://github.com/mikrojs/mikrojs/commit/8a7f205ea60ef57b5493e30350d10b796028a143))
- **test:** format Result errors with no message field ([d0cb080](https://github.com/mikrojs/mikrojs/commit/d0cb08010181de8d2aab3881248321ecc6a523a9))

### Other

- **releaser:** shorten pr-preview version to bare g\<sha\> ([12c8f45](https://github.com/mikrojs/mikrojs/commit/12c8f452cacd40c64d5a051012d8af2383f378ad))
- **release:** cap pre-major bumps in mikrojs's own release flow ([6e63e29](https://github.com/mikrojs/mikrojs/commit/6e63e295eb76e7c7fcf277f9a1e7436a4566982b))

## 0.4.2 (2026-04-30)

### Bug fixes

- use github-hosted runner for npm provenance signing ([58380a4](https://github.com/mikrojs/mikrojs/commit/58380a4d268ee87a0f2302456018a74ab01013e3))

### Other

- **ci:** publish release pr as non-draft by default ([da6f6a2](https://github.com/mikrojs/mikrojs/commit/da6f6a24438fb71ac079f38211d42be858210529))
- **release:** publish v0.4.1 ([#22](https://github.com/mikrojs/mikrojs/pull/22))
- upgrade to pnpm@11 + disable builds for native binary packages ([#23](https://github.com/mikrojs/mikrojs/pull/23))
- **release:** switch to npm OIDC trusted publishing ([d631ded](https://github.com/mikrojs/mikrojs/commit/d631ded3e0c895a82e1e5040a508509a160e59cb))

## 0.4.1 (2026-04-29)

### Other

- upgrade to pnpm@11 + disable builds for native binary packages ([#23](https://github.com/mikrojs/mikrojs/pull/23))
- **release:** switch to npm OIDC trusted publishing ([d631ded](https://github.com/mikrojs/mikrojs/commit/d631ded3e0c895a82e1e5040a508509a160e59cb))

## 0.4.0 (2026-04-27)

### Features

- add error state indicator and use cli version in simulator ready message ([23a8ec2](https://github.com/mikrojs/mikrojs/commit/23a8ec2c0778529ef18cdc98bcadaaa427122d29))

## 0.3.2 (2026-04-27)

### Bug fixes

- **release:** attribute release-side effects to mikrodroid[bot] ([1fc499a](https://github.com/mikrojs/mikrojs/commit/1fc499ad2bb5f973db69bdfecb765cf1c0717abd))
- correct logo alignment by changing connector character ([a2654d2](https://github.com/mikrojs/mikrojs/commit/a2654d284cbe96502986680440fc945f9583de66))

### Other

- update github app token auth and improve release asset handling ([882b32d](https://github.com/mikrojs/mikrojs/commit/882b32d6b558a3b23c52e400cbeb20978cb32083))
- clarify early development status and improve feature descriptions ([f953b4d](https://github.com/mikrojs/mikrojs/commit/f953b4d9aa58001df3778fd6acfb66220ae1c07a))
- **release:** publish v0.3.1 ([#19](https://github.com/mikrojs/mikrojs/pull/19))

## 0.3.1 (2026-04-27)

### Bug fixes

- **release:** attribute release-side effects to mikrodroid[bot] ([1fc499a](https://github.com/mikrojs/mikrojs/commit/1fc499ad2bb5f973db69bdfecb765cf1c0717abd))
- correct logo alignment by changing connector character ([a2654d2](https://github.com/mikrojs/mikrojs/commit/a2654d284cbe96502986680440fc945f9583de66))

## 0.3.0 (2026-04-27)

### Features

- **release:** create GitHub Release with install instructions and firmware assets ([5654912](https://github.com/mikrojs/mikrojs/commit/5654912591df499dd0080a4c3956bde9a13cc174))

### Bug fixes

- **release:** track canonical version in workspace root package.json ([4760f46](https://github.com/mikrojs/mikrojs/commit/4760f46ba46177af8c640d8a0ace87b9c87a09a0))
- **release:** escape angle brackets in commit subjects ([a7b17d5](https://github.com/mikrojs/mikrojs/commit/a7b17d5e1c781eb65ad5514f11440c8420f6c8bf))
- **release:** make github-release idempotent and loud-fail on missing changelog ([bf39aee](https://github.com/mikrojs/mikrojs/commit/bf39aeecf5da77bf4f4dc41fd75289f9bd6e7a03))
- **release:** grant pull-requests:read so plan can detect release-PR merges ([989f177](https://github.com/mikrojs/mikrojs/commit/989f17799e4a52975bd576dc960e1e1045a66f0e))
- **release:** trigger on push so status lands on main's commit ([a9535ae](https://github.com/mikrojs/mikrojs/commit/a9535aeb227c7452ff05cdc3ee5d2c69ac0e38a2))

### Other

- **release:** mention GitHub Release step in rolling release PR body ([6f49a04](https://github.com/mikrojs/mikrojs/commit/6f49a040e5e4700a495015f6b77b8233b32fdd2b))
- **deps:** bump ratchet-pinned action SHAs ([8be98ce](https://github.com/mikrojs/mikrojs/commit/8be98ce9c48de239aeb5097e883bbc82e651e189))
- **ci:** migrate workflows to Blacksmith runners ([#17](https://github.com/mikrojs/mikrojs/pull/17))

## 0.2.0 (2026-04-27)

### Features

- **release:** replace release-please with @repo/releaser CLI ([#14](https://github.com/mikrojs/mikrojs/pull/14))

### Bug fixes

- **release:** build eslint-plugin before create-PR commits ([d635883](https://github.com/mikrojs/mikrojs/commit/d635883d6bfee09041fe369dd05ccd45446bf8f3))
- **cli:** surface firmware-incompat error in REPL handshake ([e291c4b](https://github.com/mikrojs/mikrojs/commit/e291c4b144e8db17f507ccbc5c79ef588f584a1e))
- **cli:** suppress troubleshooting on self-explanatory errors ([aaad5f2](https://github.com/mikrojs/mikrojs/commit/aaad5f2b8dda79baa1ddfb490ad274f2c25fc7fa))
- **cli:** accept prerelease firmware versions in compat check ([c924677](https://github.com/mikrojs/mikrojs/commit/c9246776b4319518fcf56d54247958f6004ee56b))

### Other

- **sys:** document version export from mikrojs/sys ([94a39dd](https://github.com/mikrojs/mikrojs/commit/94a39dd34fef47982df87d05a8fcf8b31a2ac218))

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/@mikrojs/esptool@0.0.7...@mikrojs/esptool@0.0.7) (2026-04-26)


### Features

* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))
* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/esptool-v0.0.6...esptool-v0.0.7) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))

## [0.0.6](https://github.com/mikrojs/mikrojs/compare/esptool-v0.0.1...esptool-v0.0.6) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## 0.0.1 (2026-04-25)


### Features

* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))

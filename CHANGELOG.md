# Changelog

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

## 0.9.0 (2026-05-30)

### Breaking changes

- **native:** replace import.meta.unload with withDisposableModule() ([#164](https://github.com/mikrojs/mikro/pull/164))
- **cli:** rename env flags to --env-file/--no-auto-env ([#157](https://github.com/mikrojs/mikro/pull/157))
- **native:** support deep-sleep on panic ([#155](https://github.com/mikrojs/mikro/pull/155))

### Features

- **mikrojs:** export shared tsconfig base as mikrojs/tsconfig ([#169](https://github.com/mikrojs/mikro/pull/169))
- **eslint-plugin:** add no-bigint rule for the runtime's missing intrinsic ([#165](https://github.com/mikrojs/mikro/pull/165))
- **analyze-imports:** bump ecmaVersion from 2025 to 2026 in parser config ([#162](https://github.com/mikrojs/mikro/pull/162))
- **cli:** support per-environment overrides in mikro.config.ts ([#158](https://github.com/mikrojs/mikro/pull/158))

### Bug fixes

- **native:** make atob/btoa spec-compliant ([#142](https://github.com/mikrojs/mikro/pull/142))

### Other

- **docs:** fix typing in withUnload twoslash example ([#168](https://github.com/mikrojs/mikro/pull/168))
- **native:** cover withUnload unload-on-throw path ([#167](https://github.com/mikrojs/mikro/pull/167))
- **e2e:** switch from httpbin to httpbingo ([#166](https://github.com/mikrojs/mikro/pull/166))
- remove redundant maturity period configuration and sync notes ([#163](https://github.com/mikrojs/mikro/pull/163))
- **deps:** update dependency taze to v19.14.1 ([#161](https://github.com/mikrojs/mikro/pull/161))
- **deps:** update dependency lefthook to v2.1.9 ([#160](https://github.com/mikrojs/mikro/pull/160))
- **deps:** update pnpm to v11.5.0 ([#156](https://github.com/mikrojs/mikro/pull/156))
- **deps:** update pnpm to v11.4.0 ([#151](https://github.com/mikrojs/mikro/pull/151))
- **deps:** update dependency terser to v5.48.0 ([#149](https://github.com/mikrojs/mikro/pull/149))
- **deps:** update dependency wrangler to v4.95.0 ([#150](https://github.com/mikrojs/mikro/pull/150))
- **deps:** update dependency oxfmt to ^0.52.0 ([#148](https://github.com/mikrojs/mikro/pull/148))
- **deps:** update dependency npm to v11.16.0 ([#147](https://github.com/mikrojs/mikro/pull/147))
- **deps:** update dependency @shikijs/vitepress-twoslash to v4.1.0 ([#145](https://github.com/mikrojs/mikro/pull/145))
- **deps:** update dependency unbarrelify to v1.1.2 ([#143](https://github.com/mikrojs/mikro/pull/143))
- **deps:** update dependency vue to v3.5.35 ([#144](https://github.com/mikrojs/mikro/pull/144))
- **deps:** update dependency tsx to v4.22.3 ([#128](https://github.com/mikrojs/mikro/pull/128))
- **deps:** update dependency knip to v6.14.2 ([#140](https://github.com/mikrojs/mikro/pull/140))
- **deps:** update cloudflare/wrangler-action action to v4 ([#91](https://github.com/mikrojs/mikro/pull/91))
- **deps:** update dependency semver to v7.8.1 ([#66](https://github.com/mikrojs/mikro/pull/66))
- **deps:** update dependency lefthook to v2.1.8 ([#141](https://github.com/mikrojs/mikro/pull/141))
- **deps:** update dependency ink to v7.0.4 ([#138](https://github.com/mikrojs/mikro/pull/138))
- **deps:** update dependency @types/node to v24.12.4 ([#63](https://github.com/mikrojs/mikro/pull/63))
- **deps:** update dependency eslint to v10.4.0 ([#119](https://github.com/mikrojs/mikro/pull/119))
- **deps:** update dependency @sveltejs/acorn-typescript to v1.0.10 ([#135](https://github.com/mikrojs/mikro/pull/135))
- **deps:** update typescript-eslint monorepo to v8.60.0 ([#47](https://github.com/mikrojs/mikro/pull/47))
- **deps:** update dependency eslint-plugin-package-json to v1 ([#129](https://github.com/mikrojs/mikro/pull/129))
- expand abbreviations, improve clarity and consistency across guides ([#139](https://github.com/mikrojs/mikro/pull/139))
- **deps:** update dependency @types/react to v19.2.15 ([#137](https://github.com/mikrojs/mikro/pull/137))
- **deps:** update dependency @swc/core to v1.15.40 ([#136](https://github.com/mikrojs/mikro/pull/136))
- **deps:** update zizmorcore/zizmor-action action to v0.5.6 ([#121](https://github.com/mikrojs/mikro/pull/121))
- **deps:** update dependency vite to v8.0.14 ([#81](https://github.com/mikrojs/mikro/pull/81))

## 0.8.0 (2026-05-21)

### Breaking changes

- **sleep:** split wakeup sources by sleep mode and auto-conf RTC pulls ([#124](https://github.com/mikrojs/mikro/pull/124))
- **firmware:** drop tls 1.3 to shrink mbedtls handshake heap ([#115](https://github.com/mikrojs/mikro/pull/115))

### Features

- **cli:** add shell completion with live serial-port suggestions ([#125](https://github.com/mikrojs/mikro/pull/125))

### Bug fixes

- **sleep:** pick chip-appropriate ext1 wakeup enum ([#131](https://github.com/mikrojs/mikro/pull/131))
- **sleep:** flush logfile before deep sleep reboot ([#130](https://github.com/mikrojs/mikro/pull/130))
- **cli:** inherit tsx loading in workspace subprocesses ([#123](https://github.com/mikrojs/mikro/pull/123))
- **cli:** set tsx to use mikrojs tsconfig ([#116](https://github.com/mikrojs/mikro/pull/116))

### Other

- **deps:** upgrade quickjs-ng to v0.15.0 ([#133](https://github.com/mikrojs/mikro/pull/133))
- add socket.yml ignoring package.json under test fixture ([#132](https://github.com/mikrojs/mikro/pull/132))
- update seeed studio xiao esp32-c5 product link ([#127](https://github.com/mikrojs/mikro/pull/127))
- **deps:** update dependency knip to v6.14.1 ([#126](https://github.com/mikrojs/mikro/pull/126))
- improve ux for device connection and troubleshooting ([#122](https://github.com/mikrojs/mikro/pull/122))
- **deps:** update dependency oxfmt to ^0.50.0 ([#120](https://github.com/mikrojs/mikro/pull/120))
- **deps:** update dependency wrangler to v4.92.0 ([#118](https://github.com/mikrojs/mikro/pull/118))
- **deps:** update dependency knip to v6.14.0 ([#117](https://github.com/mikrojs/mikro/pull/117))
- make fmt hook tolerate all-ignored input ([#113](https://github.com/mikrojs/mikro/pull/113))
- **cli:** run mikro from TypeScript source in workspace ([#112](https://github.com/mikrojs/mikro/pull/112))
- migrate tsx to catalog dependency ([#114](https://github.com/mikrojs/mikro/pull/114))
- **deps:** update dependency taze to v19.12.0 ([#110](https://github.com/mikrojs/mikro/pull/110))

## 0.7.0 (2026-05-15)

### Breaking changes

- **runtime:** yield Result from streaming APIs ([#103](https://github.com/mikrojs/mikro/pull/103))
- **runtime:** always restart on uncaught error ([#93](https://github.com/mikrojs/mikro/pull/93))
- **runtime:** add on-device file logging via `mikro logs pull` ([#92](https://github.com/mikrojs/mikro/pull/92))

### Features

- **docs:** improve vitepress theme ([#101](https://github.com/mikrojs/mikro/pull/101))
- **create-mikrojs:** scaffold with TS only, mikro.config.ts and prettier defaults ([#97](https://github.com/mikrojs/mikro/pull/97))
- **cli:** quiet `mikro flash` output and show next steps ([#94](https://github.com/mikrojs/mikro/pull/94))

### Bug fixes

- **release:** scope mikrodroid token to pull-requests for PR endpoints ([#109](https://github.com/mikrojs/mikro/pull/109))
- **runtime:** unhang uart.read() when end() races a pending next() ([#106](https://github.com/mikrojs/mikro/pull/106))
- **docs:** make brand hairline span the full navbar width ([#102](https://github.com/mikrojs/mikro/pull/102))

### Other

- **deps:** update dependency @clack/prompts to v1.4.0 ([#87](https://github.com/mikrojs/mikro/pull/87))
- **workflows:** add zizmor audit and harden workflows ([#107](https://github.com/mikrojs/mikro/pull/107))
- **deps:** update dependency tsx to v4.22.0 ([#108](https://github.com/mikrojs/mikro/pull/108))
- **e2e:** run sim suite on pre-commit and CI ([#105](https://github.com/mikrojs/mikro/pull/105))
- **deps:** update dependency wrangler to v4.91.0 ([#104](https://github.com/mikrojs/mikro/pull/104))
- **deps:** update dependency tsx to v4.21.1 ([#100](https://github.com/mikrojs/mikro/pull/100))
- remove .envrc file ([#99](https://github.com/mikrojs/mikro/pull/99))
- **deps:** update dependency ink to v7.0.3 ([#96](https://github.com/mikrojs/mikro/pull/96))
- **deps:** update pnpm to v11.1.2 ([#98](https://github.com/mikrojs/mikro/pull/98))
- **deps:** update dependency publint to v0.3.21 ([#95](https://github.com/mikrojs/mikro/pull/95))
- **deps:** update actions/create-github-app-token digest to bcd2ba4 ([#86](https://github.com/mikrojs/mikro/pull/86))
- **deps:** update pnpm/action-setup digest to 0e279bb ([#76](https://github.com/mikrojs/mikro/pull/76))
- **deps:** update pnpm to v11.1.1 ([#84](https://github.com/mikrojs/mikro/pull/84))
- **deps:** update dependency knip to v6.13.1 ([#90](https://github.com/mikrojs/mikro/pull/90))
- **deps:** update dependency knip to v6.13.0 ([#89](https://github.com/mikrojs/mikro/pull/89))
- **deps:** update dependency wrangler to v4.90.1 ([#88](https://github.com/mikrojs/mikro/pull/88))
- **deps:** update dependency oxfmt to ^0.49.0 ([#83](https://github.com/mikrojs/mikro/pull/83))

## 0.6.1 (2026-05-11)

### Bug fixes

- **repl:** suspend microtasks while paused so user JS can't race deploy ([#77](https://github.com/mikrojs/mikro/pull/77))

### Other

- **deps:** update dependency ink to v7.0.2 ([#48](https://github.com/mikrojs/mikro/pull/48))
- **deps:** update dependency react to v19.2.6 ([#54](https://github.com/mikrojs/mikro/pull/54))
- fix(firmware): halve TLS inbound buffer to free internal SRAM ([#78](https://github.com/mikrojs/mikro/pull/78))
- **workflows:** drop blacksmith for github-hosted runners ([#79](https://github.com/mikrojs/mikro/pull/79))

## 0.6.0 (2026-05-10)

### Breaking changes

- replace .on/.off with Observable streams ([#70](https://github.com/mikrojs/mikro/pull/70))
- **wifi:** drive country and hostname from mikro.config.ts ([#73](https://github.com/mikrojs/mikro/pull/73))

### Features

- **config:** reject mikro/* imports in mikro.config.ts ([#74](https://github.com/mikrojs/mikro/pull/74))
- **firmware:** add ESP32-C5 chip support ([#72](https://github.com/mikrojs/mikro/pull/72))
- **runtime:** allocate QuickJS heap from PSRAM by default ([8269c3f](https://github.com/mikrojs/mikro/commit/8269c3f61a48999a3948c8e05d6e6e3d82b69558))
- **sys:** expose internal-SRAM stats to spot hidden TLS pressure ([8f0cbe3](https://github.com/mikrojs/mikro/commit/8f0cbe31aef247a7d69a6dda9ca8acd01d09fb34))

### Bug fixes

- **observable:** pin operator types so twoslash infers through pipe ([#75](https://github.com/mikrojs/mikro/pull/75))
- **firmware:** halve TLS inbound buffer to free internal SRAM ([4a2ec0a](https://github.com/mikrojs/mikro/commit/4a2ec0ac2dcdde5b5c764ee9c908e4501903d098))

### Other

- **deps:** update pnpm/action-setup digest to 91ab88e ([#62](https://github.com/mikrojs/mikro/pull/62))
- upgrade esp-idf minimum version to 6.0.1 ([#68](https://github.com/mikrojs/mikro/pull/68))

## 0.5.1 (2026-05-10)

### Other

- **deps:** update dependency knip to v6.12.2 ([#67](https://github.com/mikrojs/mikro/pull/67))
- **deps:** update pnpm to v11.0.9 ([#46](https://github.com/mikrojs/mikro/pull/46))
- **deps:** update dependency npm to v11.14.1 ([#65](https://github.com/mikrojs/mikro/pull/65))
- **deps:** update dependency publint to v0.3.20 ([#64](https://github.com/mikrojs/mikro/pull/64))
- **deps:** update dependency vite to v8.0.11 ([#57](https://github.com/mikrojs/mikro/pull/57))
- **deps:** update dependency wrangler to v4.90.0 ([#61](https://github.com/mikrojs/mikro/pull/61))
- **deps:** update dependency knip to v6.12.1 ([#60](https://github.com/mikrojs/mikro/pull/60))
- **deps:** update dependency terser to v5.47.1 ([#59](https://github.com/mikrojs/mikro/pull/59))
- **deps:** update dependency terser to v5.47.0 ([#58](https://github.com/mikrojs/mikro/pull/58))
- **deps:** update dependency npm to v11.14.0 ([#56](https://github.com/mikrojs/mikro/pull/56))
- **deps:** update dependency knip to v6.12.0 ([#55](https://github.com/mikrojs/mikro/pull/55))
- **deps:** update dependency @types/estree to v1.0.9 ([#53](https://github.com/mikrojs/mikro/pull/53))
- **deps:** update dependency vue to v3.5.34 ([#52](https://github.com/mikrojs/mikro/pull/52))
- **deps:** update dependency wrangler to v4.88.0 ([#51](https://github.com/mikrojs/mikro/pull/51))
- **deps:** update dependency oxfmt to ^0.48.0 ([#50](https://github.com/mikrojs/mikro/pull/50))
- **deps:** update dependency publint to v0.3.19 ([#49](https://github.com/mikrojs/mikro/pull/49))
- **deps:** update dependency @swc/core to v1.15.33 ([#45](https://github.com/mikrojs/mikro/pull/45))
- **deps:** update pnpm to v11.0.4 ([#33](https://github.com/mikrojs/mikro/pull/33))
- **deps:** update pnpm/action-setup action to v6 ([#44](https://github.com/mikrojs/mikro/pull/44))
- **deps:** update dependency wrangler to v4.87.0 ([#43](https://github.com/mikrojs/mikro/pull/43))
- **deps:** update dependency oxfmt to ^0.47.0 ([#42](https://github.com/mikrojs/mikro/pull/42))
- **deps:** update dependency knip to v6.11.0 ([#41](https://github.com/mikrojs/mikro/pull/41))
- **deps:** update dependency eslint to v10.3.0 ([#36](https://github.com/mikrojs/mikro/pull/36))
- **deps:** update dependency globals to v17.6.0 ([#38](https://github.com/mikrojs/mikro/pull/38))
- **deps:** update dependency @clack/prompts to v1.3.0 ([#35](https://github.com/mikrojs/mikro/pull/35))
- **deps:** update typescript-eslint monorepo to v8.59.1 ([#34](https://github.com/mikrojs/mikro/pull/34))
- **deps:** update dependency knip to v6.10.0 ([#39](https://github.com/mikrojs/mikro/pull/39))
- **renovate:** minReleaseAge + enable automerge for dev deps ([#37](https://github.com/mikrojs/mikro/pull/37))
- **deps:** update pnpm to v11.0.3 ([#32](https://github.com/mikrojs/mikro/pull/32))
- **deps:** update dependency eslint-plugin-package-json to v0.91.2 ([#30](https://github.com/mikrojs/mikro/pull/30))
- **deps:** update dependency @swc/core to v1.15.33 ([#29](https://github.com/mikrojs/mikro/pull/29))
- Configure Renovate ([#27](https://github.com/mikrojs/mikro/pull/27))

## 0.5.0 (2026-05-02)

### Breaking changes

- **cli:** make env vars secret by default ([9b7bf7c](https://github.com/mikrojs/mikro/commit/9b7bf7c50b612d1336446d75c5e2eb4406a48169))

### Features

- add UDP datagram socket support with IPv4/IPv6 and multicast ([#26](https://github.com/mikrojs/mikro/pull/26))
- **releaser:** add --breaking-is-minor-on-0x for pre-major safety ([f5a1882](https://github.com/mikrojs/mikro/commit/f5a1882f155803db4666fbf58ee8748908d57965))
- **examples:** standardize .env.example across examples + scaffold ([f05f154](https://github.com/mikrojs/mikro/commit/f05f154e5b1f2ac93d3e5e15ccafd08222a46f07))

### Bug fixes

- **releaser:** drop +SHA build metadata that breaks provenance ([d226812](https://github.com/mikrojs/mikro/commit/d22681240bf032e7bf0ecb338198032fad460269))
- **release:** bump minor on breaking for pr releases too ([205e9c6](https://github.com/mikrojs/mikro/commit/205e9c6dde34856bca8759145033b7b9e14a3872))
- **releaser:** include !-bang breaking commits in changelog ([8a7f205](https://github.com/mikrojs/mikro/commit/8a7f205ea60ef57b5493e30350d10b796028a143))
- **test:** format Result errors with no message field ([d0cb080](https://github.com/mikrojs/mikro/commit/d0cb08010181de8d2aab3881248321ecc6a523a9))

### Other

- **releaser:** shorten pr-preview version to bare g\<sha\> ([12c8f45](https://github.com/mikrojs/mikro/commit/12c8f452cacd40c64d5a051012d8af2383f378ad))
- **release:** cap pre-major bumps in mikrojs's own release flow ([6e63e29](https://github.com/mikrojs/mikro/commit/6e63e295eb76e7c7fcf277f9a1e7436a4566982b))

## 0.4.2 (2026-04-30)

### Bug fixes

- use github-hosted runner for npm provenance signing ([58380a4](https://github.com/mikrojs/mikro/commit/58380a4d268ee87a0f2302456018a74ab01013e3))

### Other

- **ci:** publish release pr as non-draft by default ([da6f6a2](https://github.com/mikrojs/mikro/commit/da6f6a24438fb71ac079f38211d42be858210529))
- **release:** publish v0.4.1 ([#22](https://github.com/mikrojs/mikro/pull/22))
- upgrade to pnpm@11 + disable builds for native binary packages ([#23](https://github.com/mikrojs/mikro/pull/23))
- **release:** switch to npm OIDC trusted publishing ([d631ded](https://github.com/mikrojs/mikro/commit/d631ded3e0c895a82e1e5040a508509a160e59cb))

## 0.4.1 (2026-04-29)

### Other

- upgrade to pnpm@11 + disable builds for native binary packages ([#23](https://github.com/mikrojs/mikro/pull/23))
- **release:** switch to npm OIDC trusted publishing ([d631ded](https://github.com/mikrojs/mikro/commit/d631ded3e0c895a82e1e5040a508509a160e59cb))

## 0.4.0 (2026-04-27)

### Features

- add error state indicator and use cli version in simulator ready message ([23a8ec2](https://github.com/mikrojs/mikro/commit/23a8ec2c0778529ef18cdc98bcadaaa427122d29))

## 0.3.2 (2026-04-27)

### Bug fixes

- **release:** attribute release-side effects to mikrodroid[bot] ([1fc499a](https://github.com/mikrojs/mikro/commit/1fc499ad2bb5f973db69bdfecb765cf1c0717abd))
- correct logo alignment by changing connector character ([a2654d2](https://github.com/mikrojs/mikro/commit/a2654d284cbe96502986680440fc945f9583de66))

### Other

- update github app token auth and improve release asset handling ([882b32d](https://github.com/mikrojs/mikro/commit/882b32d6b558a3b23c52e400cbeb20978cb32083))
- clarify early development status and improve feature descriptions ([f953b4d](https://github.com/mikrojs/mikro/commit/f953b4d9aa58001df3778fd6acfb66220ae1c07a))
- **release:** publish v0.3.1 ([#19](https://github.com/mikrojs/mikro/pull/19))

## 0.3.1 (2026-04-27)

### Bug fixes

- **release:** attribute release-side effects to mikrodroid[bot] ([1fc499a](https://github.com/mikrojs/mikro/commit/1fc499ad2bb5f973db69bdfecb765cf1c0717abd))
- correct logo alignment by changing connector character ([a2654d2](https://github.com/mikrojs/mikro/commit/a2654d284cbe96502986680440fc945f9583de66))

## 0.3.0 (2026-04-27)

### Features

- **release:** create GitHub Release with install instructions and firmware assets ([5654912](https://github.com/mikrojs/mikro/commit/5654912591df499dd0080a4c3956bde9a13cc174))

### Bug fixes

- **release:** track canonical version in workspace root package.json ([4760f46](https://github.com/mikrojs/mikro/commit/4760f46ba46177af8c640d8a0ace87b9c87a09a0))
- **release:** escape angle brackets in commit subjects ([a7b17d5](https://github.com/mikrojs/mikro/commit/a7b17d5e1c781eb65ad5514f11440c8420f6c8bf))
- **release:** make github-release idempotent and loud-fail on missing changelog ([bf39aee](https://github.com/mikrojs/mikro/commit/bf39aeecf5da77bf4f4dc41fd75289f9bd6e7a03))
- **release:** grant pull-requests:read so plan can detect release-PR merges ([989f177](https://github.com/mikrojs/mikro/commit/989f17799e4a52975bd576dc960e1e1045a66f0e))
- **release:** trigger on push so status lands on main's commit ([a9535ae](https://github.com/mikrojs/mikro/commit/a9535aeb227c7452ff05cdc3ee5d2c69ac0e38a2))

### Other

- **release:** mention GitHub Release step in rolling release PR body ([6f49a04](https://github.com/mikrojs/mikro/commit/6f49a040e5e4700a495015f6b77b8233b32fdd2b))
- **deps:** bump ratchet-pinned action SHAs ([8be98ce](https://github.com/mikrojs/mikro/commit/8be98ce9c48de239aeb5097e883bbc82e651e189))
- **ci:** migrate workflows to Blacksmith runners ([#17](https://github.com/mikrojs/mikro/pull/17))

## 0.2.0 (2026-04-27)

### Features

- **release:** replace release-please with @repo/releaser CLI ([#14](https://github.com/mikrojs/mikro/pull/14))

### Bug fixes

- **release:** build eslint-plugin before create-PR commits ([d635883](https://github.com/mikrojs/mikro/commit/d635883d6bfee09041fe369dd05ccd45446bf8f3))
- **cli:** surface firmware-incompat error in REPL handshake ([e291c4b](https://github.com/mikrojs/mikro/commit/e291c4b144e8db17f507ccbc5c79ef588f584a1e))
- **cli:** suppress troubleshooting on self-explanatory errors ([aaad5f2](https://github.com/mikrojs/mikro/commit/aaad5f2b8dda79baa1ddfb490ad274f2c25fc7fa))
- **cli:** accept prerelease firmware versions in compat check ([c924677](https://github.com/mikrojs/mikro/commit/c9246776b4319518fcf56d54247958f6004ee56b))

### Other

- **sys:** document version export from mikrojs/sys ([94a39dd](https://github.com/mikrojs/mikro/commit/94a39dd34fef47982df87d05a8fcf8b31a2ac218))

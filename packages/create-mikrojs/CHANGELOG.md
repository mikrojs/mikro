# Changelog

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

## [0.1.0](https://github.com/mikrojs/mikrojs/compare/create-mikrojs@0.0.7...create-mikrojs@0.1.0) (2026-04-26)


### Features

* **create-mikrojs:** USB hint, version label, robust cwd detect ([6fa8add](https://github.com/mikrojs/mikrojs/commit/6fa8add576cb0bc8e29dbbd23431b1cdf6904edd))

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/create-mikrojs@0.0.8...create-mikrojs@0.0.7) (2026-04-26)


### Features

* **create-mikrojs:** polish scaffold defaults ([a7a5c6e](https://github.com/mikrojs/mikrojs/commit/a7a5c6e9deb08df47ee96a9d38fc9f2b6040e3f6))
* **create-mikrojs:** scaffold eslint and editorconfig, remove bundled tseslint ([28416bd](https://github.com/mikrojs/mikrojs/commit/28416bd91bda167d83a5dfcfbbaf8f8f04b441ce))
* **create-mikrojs:** use runCommand for next-steps dev hint ([96fceba](https://github.com/mikrojs/mikrojs/commit/96fceba09cbf7e86940ae63d305a563426671d5e))
* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))
* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## [0.0.8](https://github.com/mikrojs/mikrojs/compare/create-mikrojs-v0.0.7...create-mikrojs-v0.0.8) (2026-04-26)


### Features

* **create-mikrojs:** scaffold eslint and editorconfig, remove bundled tseslint ([28416bd](https://github.com/mikrojs/mikrojs/commit/28416bd91bda167d83a5dfcfbbaf8f8f04b441ce))
* **create-mikrojs:** use runCommand for next-steps dev hint ([96fceba](https://github.com/mikrojs/mikrojs/commit/96fceba09cbf7e86940ae63d305a563426671d5e))

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/create-mikrojs-v0.0.6...create-mikrojs-v0.0.7) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))

## [0.0.6](https://github.com/mikrojs/mikrojs/compare/create-mikrojs-v0.0.1...create-mikrojs-v0.0.6) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## 0.0.1 (2026-04-25)


### Features

* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))

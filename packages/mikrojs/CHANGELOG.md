# Changelog

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

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/mikrojs@0.0.8...mikrojs@0.0.7) (2026-04-26)


### Features

* **cli:** notify users of new mikro versions ([53b56f8](https://github.com/mikrojs/mikrojs/commit/53b56f83f9befdbbfe01f6f2c1b9c4a0cd378d81))
* **cli:** show update notice when device firmware lags CLI ([1fed116](https://github.com/mikrojs/mikrojs/commit/1fed116b0cd48b7829e9409bb379db287570c371))
* refactor sim dev command to use shared devSession state machine ([4012cb9](https://github.com/mikrojs/mikrojs/commit/4012cb9a70a05a343e186f2a12d797ca291e2c50))
* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))
* **sim:** persist nvs_kv across mikro sim dev restarts ([7b3fb24](https://github.com/mikrojs/mikrojs/commit/7b3fb24723c121e9c73155a9ec2fdae867b391a4))


### Bug Fixes

* **cli:** make flash --from=&lt;sha&gt; work for release commits ([1ffc233](https://github.com/mikrojs/mikrojs/commit/1ffc23332aa7404b7e3cf730e67e77163fe8e4ec))
* **cli:** resume ready handshake after Ctrl+R restart ([7d29770](https://github.com/mikrojs/mikrojs/commit/7d29770de25c62b6f812ab3704f8b8694c56f2d4))
* **cli:** use kebab-case esptool flags to silence deprecation warnings ([5e3657a](https://github.com/mikrojs/mikrojs/commit/5e3657a4dc79d590c5c520dcd07287020b9380ac))


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))
* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## [0.0.8](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.7...mikrojs-v0.0.8) (2026-04-26)


### Features

* refactor sim dev command to use shared devSession state machine ([4012cb9](https://github.com/mikrojs/mikrojs/commit/4012cb9a70a05a343e186f2a12d797ca291e2c50))
* **sim:** persist nvs_kv across mikro sim dev restarts ([7b3fb24](https://github.com/mikrojs/mikrojs/commit/7b3fb24723c121e9c73155a9ec2fdae867b391a4))


### Bug Fixes

* **cli:** make flash --from=&lt;sha&gt; work for release commits ([1ffc233](https://github.com/mikrojs/mikrojs/commit/1ffc23332aa7404b7e3cf730e67e77163fe8e4ec))
* **cli:** resume ready handshake after Ctrl+R restart ([7d29770](https://github.com/mikrojs/mikrojs/commit/7d29770de25c62b6f812ab3704f8b8694c56f2d4))
* **cli:** use kebab-case esptool flags to silence deprecation warnings ([5e3657a](https://github.com/mikrojs/mikrojs/commit/5e3657a4dc79d590c5c520dcd07287020b9380ac))

## [0.0.7](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.6...mikrojs-v0.0.7) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([9f56d94](https://github.com/mikrojs/mikrojs/commit/9f56d9467459a593973e21eee9f1883d9d7e49af))

## [0.0.6](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.5...mikrojs-v0.0.6) (2026-04-25)


### Miscellaneous Chores

* **release:** force release main ([7a9cc21](https://github.com/mikrojs/mikrojs/commit/7a9cc21fa3706f86c641ce5587e3f56af87b9ef6))

## [0.0.5](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.4...mikrojs-v0.0.5) (2026-04-25)


### Miscellaneous Chores

* **mikrojs:** Synchronize core versions

## [0.0.4](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.3...mikrojs-v0.0.4) (2026-04-25)


### Miscellaneous Chores

* **mikrojs:** Synchronize core versions

## [0.0.3](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.2...mikrojs-v0.0.3) (2026-04-25)


### Miscellaneous Chores

* **mikrojs:** Synchronize core versions

## [0.0.2](https://github.com/mikrojs/mikrojs/compare/mikrojs-v0.0.1...mikrojs-v0.0.2) (2026-04-25)


### Miscellaneous Chores

* **mikrojs:** Synchronize core versions

## 0.0.1 (2026-04-25)


### Features

* **release:** bootstrap first release ([6a55e28](https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe))

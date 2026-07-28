# Changelog

## 0.17.0 (2026-07-28)

### Breaking changes

- **kv:** reserve the mik.sys NVS namespace for runtime state ([#274](https://github.com/mikrojs/mikro/pull/274))

### Features

- **cli:** refuse mikro flash overwriting custom firmware ([#292](https://github.com/mikrojs/mikro/pull/292))
- **ota:** install deploys at fresh boot ([#290](https://github.com/mikrojs/mikro/pull/290))
- **ota:** provide ota client from 'mikro/ota/client' ([#289](https://github.com/mikrojs/mikro/pull/289))
- **releaser:** keep 0.x features a patch bump ([#288](https://github.com/mikrojs/mikro/pull/288))
- **ota:** unify command output and stop stray build tarballs ([#286](https://github.com/mikrojs/mikro/pull/286))
- **ota:** show the setup login code before opening the browser ([#285](https://github.com/mikrojs/mikro/pull/285))
- **ota:** record source repository and commit on registry builds ([#282](https://github.com/mikrojs/mikro/pull/282))
- **ota:** release channels ([#278](https://github.com/mikrojs/mikro/pull/278))
- **ota:** generate a dev version with --snapshot ([#277](https://github.com/mikrojs/mikro/pull/277))
- **ota:** over-the-air app build updates ([#276](https://github.com/mikrojs/mikro/pull/276))
- **cli:** offer to re-run the original command after reflashing ([#266](https://github.com/mikrojs/mikro/pull/266))

### Bug fixes

- **firmware:** don't freeze the resolved partitions.csv path into sdkconfig ([#291](https://github.com/mikrojs/mikro/pull/291))
- **ota:** start polling for setup complete immediately ([#287](https://github.com/mikrojs/mikro/pull/287))
- **cli:** clarify firmware-mismatch prompt and allow aborting a flash ([#280](https://github.com/mikrojs/mikro/pull/280))
- **docs:** keep the ota release command inline so the site builds ([#279](https://github.com/mikrojs/mikro/pull/279))
- **firmware:** revive the on-device test suite after the mikro rename ([#275](https://github.com/mikrojs/mikro/pull/275))
- **releaser:** derive changelog range from version bump commit ([#263](https://github.com/mikrojs/mikro/pull/263))

### Other

- **ota:** order snapshot versions by build time ([#284](https://github.com/mikrojs/mikro/pull/284))
- **ota:** order snapshot versions by build time ([#283](https://github.com/mikrojs/mikro/pull/283))
- **ota:** rename device credential to update key ([#281](https://github.com/mikrojs/mikro/pull/281))
- **deps:** update dependency acorn to v8.17.0 ([#272](https://github.com/mikrojs/mikro/pull/272))
- **deps:** update dependency @types/node to v24.13.3 ([#271](https://github.com/mikrojs/mikro/pull/271))
- **deps:** update dependency @shikijs/vitepress-twoslash to v4.3.1 ([#270](https://github.com/mikrojs/mikro/pull/270))
- **firmware:** recommend esp-idf 6.0.2 installs to match CI ([#269](https://github.com/mikrojs/mikro/pull/269))
- **deps:** update espressif/idf docker tag to v6.0.2 ([#265](https://github.com/mikrojs/mikro/pull/265))
- **deps:** update dependency vue to v3.5.40 ([#264](https://github.com/mikrojs/mikro/pull/264))
- **deps:** update dependency vitepress-plugin-llms to v1.13.3 ([#260](https://github.com/mikrojs/mikro/pull/260))
- **deps:** update dependency npm-run-all2 to v9.0.2 ([#259](https://github.com/mikrojs/mikro/pull/259))

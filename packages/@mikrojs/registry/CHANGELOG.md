# Changelog

## 0.18.1 (2026-08-17)

### Bug fixes

- **firmware:** stop repeated TLS handshakes running out of memory ([#329](https://github.com/mikrojs/mikro/pull/329))
- **native:** bound CBOR string spans against the buffer end ([#326](https://github.com/mikrojs/mikro/pull/326))
- **native:** reject truncated CBOR containers ([#325](https://github.com/mikrojs/mikro/pull/325))
- **native:** stop inspect leaving getter exceptions pending ([#323](https://github.com/mikrojs/mikro/pull/323))
- **fs:** flush before fstat so File.stat sees unflushed writes ([#322](https://github.com/mikrojs/mikro/pull/322))
- **native:** render symbol descriptions without leaving an exception ([#321](https://github.com/mikrojs/mikro/pull/321))
- **native:** resolve relative imports from root-level main modules ([#320](https://github.com/mikrojs/mikro/pull/320))

### Other

- **repo:** add coverage:lib:open for browsing the html coverage report ([#328](https://github.com/mikrojs/mikro/pull/328))
- **native:** add host test suite for the portable library ([#327](https://github.com/mikrojs/mikro/pull/327))
- raise vitest timeouts for flaky tests under full-suite load ([#324](https://github.com/mikrojs/mikro/pull/324))
- **native:** C++ coverage gate, OOM injection harness, sanitizer CI ([#319](https://github.com/mikrojs/mikro/pull/319))
- drop vendored generic skills ([#318](https://github.com/mikrojs/mikro/pull/318))
- improve writing, add ai disclosure ([#316](https://github.com/mikrojs/mikro/pull/316))

## 0.18.0 (2026-08-12)

### Breaking changes

- **quickjs:** upgrade quickjs-ng to v0.16.0 ([53364c3](https://github.com/mikrojs/mikro/commit/53364c374f850b6734b9ffff5a4848e77ee4bdff))

### Features

- **firmware:** show quickjs-ng version in the boot banner ([3b75d1b](https://github.com/mikrojs/mikro/commit/3b75d1be4d7f6c046659d8ffd49012f7d2a59d97))
- **wifi:** default the DHCP hostname to the device's name ([#293](https://github.com/mikrojs/mikro/pull/293))

### Bug fixes

- **native:** release what a producer acquired when its setup throws ([#311](https://github.com/mikrojs/mikro/pull/311))
- **native:** panic on every uncaught error, not just rejected promises ([36f6880](https://github.com/mikrojs/mikro/commit/36f688044f97a6710a1ecb9ca434fd973cedcfb1))
- **observable:** correct the documented error semantics ([706bd4c](https://github.com/mikrojs/mikro/commit/706bd4c53179b483db92597e85b4deecd3ffcaf4))
- **firmware:** grow the Xtensa main-task stack for quickjs-ng 0.16 frame sizes ([98bc191](https://github.com/mikrojs/mikro/commit/98bc1913b1241cc919c813b8b998e45c4de5ed99))
- **quickjs:** shrink the arena allocator to fit small heaps ([3ad3e0f](https://github.com/mikrojs/mikro/commit/3ad3e0f3366b52b3387df04139e0bbad58409e86))
- **native:** escalate unschedulable observable panics instead of dropping them ([c0cd920](https://github.com/mikrojs/mikro/commit/c0cd9205a1f124ea3cd9be6700af2e8c023ec5c9))
- **native:** free the addTeardown atom leaked on every multicast subscribe ([58fa10d](https://github.com/mikrojs/mikro/commit/58fa10d7a3c9794f2d9188e2d2c2de42326390d3))
- various build hygiene fixes ([#304](https://github.com/mikrojs/mikro/pull/304))
- **quickjs:** guard the configure-time patch sync for CMake script mode ([#301](https://github.com/mikrojs/mikro/pull/301))
- **quickjs:** cap GC threshold re-arm at the memory limit ([#297](https://github.com/mikrojs/mikro/pull/297))

### Performance

- **firmware:** reclaim the esp32 stack bump the trampoline made moot ([69bc288](https://github.com/mikrojs/mikro/commit/69bc288331a66767b2727a08ccb85e31e12ece72))
- **native:** trampoline observable dispatch to O(1) stack per delivery ([d4560d0](https://github.com/mikrojs/mikro/commit/d4560d0103b56a28d7d073a975229abd950cef56))
- **quickjs:** free module init bytecode once evaluation completes ([#298](https://github.com/mikrojs/mikro/pull/298))
- **firmware:** define NDEBUG for quickjs to drop per-string debug overhead ([#296](https://github.com/mikrojs/mikro/pull/296))
- **native:** preallocate module file buffer to avoid 1.5x growth peak ([#295](https://github.com/mikrojs/mikro/pull/295))

### Other

- **deps:** update dependency tar to v7.5.21 [security] ([#312](https://github.com/mikrojs/mikro/pull/312))
- **site:** fix broken links and contradictory error-handling guidance ([6cadfa8](https://github.com/mikrojs/mikro/commit/6cadfa839930cc7b315c413818a64926f0443f6c))
- update heap baselines ([37c0da4](https://github.com/mikrojs/mikro/commit/37c0da49f9ccd294b278e64eaf71a3426f1db778))
- **native:** mark consumed rejections handled via JS_PromiseMarkAsHandled ([a01c7b6](https://github.com/mikrojs/mikro/commit/a01c7b6fa1104bc0ebfe178c14c53750d60d1886))
- **ota:** drop bytecode version as build key ([#303](https://github.com/mikrojs/mikro/pull/303))
- **cli:** stop the git fixture from hitting the real repo under hooks ([#302](https://github.com/mikrojs/mikro/pull/302))
- **quickjs:** apply the patch series at CMake configure time ([#299](https://github.com/mikrojs/mikro/pull/299))

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

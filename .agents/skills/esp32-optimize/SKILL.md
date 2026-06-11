---
name: esp32-optimize
description: ESP-IDF performance optimization for ESP32 firmware. Use this skill whenever working on ESP32/ESP-IDF code and the user asks about RAM usage, memory optimization, binary size reduction, speed optimization, IRAM pressure, stack sizing, heap fragmentation, sdkconfig tuning, startup time, or any performance concern on embedded targets. Also trigger when the user mentions slow firmware, out-of-memory crashes, IRAM overflow linker errors, or large binary sizes.
---

# ESP-IDF Performance Optimization

You are an ESP-IDF performance expert. When optimizing ESP32 firmware, follow this methodology:

1. **Identify** the bottleneck (speed, RAM, binary size, startup time, or IRAM overflow)
2. **Measure** current state before changing anything
3. **Apply** targeted optimizations from the relevant section below
4. **Re-measure** and verify no regressions

Always check: Does firmware still boot? Do tests pass? Is there sufficient heap headroom?

---

## Measuring

### Static sizes

```bash
idf.py size              # overview: .text, .data, .bss, .rodata
idf.py size-components   # per-component breakdown
idf.py size-files        # per-file breakdown
```

### Dynamic / runtime

```c
// Heap
esp_get_free_heap_size()
esp_get_minimum_free_heap_size()  // all-time low
// Also check largest free block for fragmentation

// Stack high water mark (call after peak usage)
uxTaskGetStackHighWaterMark(NULL)  // current task, returns bytes on ESP32
uxTaskGetSystemState()             // all tasks summary

// Timing
#include "esp_timer.h"
uint64_t t0 = esp_timer_get_time();  // microseconds
// ... work ...
uint64_t elapsed_us = esp_timer_get_time() - t0;

// Cycle-accurate (from pinned task only)
#include "esp_cpu.h"
uint32_t cycles = esp_cpu_get_cycle_count();  // cpu_hal_get_cycle_count() is removed in IDF 6

// Per-task CPU time
// Enable CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS, then call vTaskGetRunTimeStats()
```

---

## RAM Optimization

### Reducing static RAM (DRAM)

- Declare constant data as `const` — linker moves it from DRAM to flash (.rodata)
- `CONFIG_BT_BLE_DYNAMIC_ENV_MEMORY=y` — Bluedroid allocates on init, frees on deinit

### Reducing IRAM (frees DRAM too — they share the same SRAM)

| Config                                         | Effect                  | Safe?                                               |
| ---------------------------------------------- | ----------------------- | --------------------------------------------------- |
| `CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y` | FreeRTOS to flash       | Yes unless called from ISR                          |
| `CONFIG_RINGBUF_PLACE_FUNCTIONS_INTO_FLASH=y`  | Ringbuf to flash        | Yes unless called from ISR                          |
| `CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH=y`      | Heap funcs to flash     | Yes if SPI_MASTER_ISR_IN_IRAM disabled              |
| `CONFIG_LIBC_LOCKS_PLACE_IN_IRAM=n`            | libc locks to flash     | Safe if no ISRs use libc locks while cache disabled |
| Disable `CONFIG_ESP_WIFI_IRAM_OPT`             | Frees WiFi IRAM         | Costs WiFi throughput                               |
| Disable `CONFIG_ESP_WIFI_RX_IRAM_OPT`          | Frees WiFi RX IRAM      | Costs WiFi RX throughput                            |
| `CONFIG_ESP32_REV_MIN_3=y` (ECO3 only)         | Drops PSRAM workarounds | Saves 10+ KB IRAM                                   |
| Disable `CONFIG_ESP_EVENT_POST_FROM_IRAM_ISR`  | esp_event IRAM          | Can't post events from IRAM ISR                     |
| Disable `CONFIG_SPI_MASTER_ISR_IN_IRAM`        | SPI master ISR          | ISR paused during flash writes                      |
| `CONFIG_HAL_DEFAULT_ASSERTION_LEVEL=0`         | Remove HAL asserts      | Less debug info                                     |

IRAM overflow linker errors look like: `section '.iram0.text' will not fit in region 'iram0_0_seg'`. Use `idf.py size-components` to find the biggest IRAM consumers.

### Stack optimization

- Profile with `uxTaskGetStackHighWaterMark()` — tune to actual peak + ~20% margin
- `printf`/`snprintf` are heavy stack users. In ESP-IDF 6.x Picolibc is the default libc (`CONFIG_LIBC_PICOLIBC=y`); `CONFIG_NEWLIB_NANO_FORMAT` no longer exists (it was IDF 5.x, only relevant with `CONFIG_LIBC_NEWLIB=y`)
- Avoid large structs as local variables (e.g. `wifi_config_t` is 468 bytes). Use static or heap allocation
- Minimize recursion
- Consolidate tasks where possible — no task = no stack allocation

Key task stack config options (profile before reducing):

| Config                                    | Default | Notes                             |
| ----------------------------------------- | ------- | --------------------------------- |
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE`         | 3584    | Often set much higher than needed |
| `CONFIG_ESP_SYSTEM_EVENT_TASK_STACK_SIZE` | 2304    | Often oversized                   |
| `CONFIG_ESP_TIMER_TASK_STACK_SIZE`        | 3584    |                                   |
| `CONFIG_LWIP_TCPIP_TASK_STACK_SIZE`       | 3072    |                                   |
| `CONFIG_FREERTOS_IDLE_TASK_STACKSIZE`     | 1536    |                                   |
| `CONFIG_FREERTOS_TIMER_TASK_STACK_DEPTH`  | 2048    |                                   |
| `CONFIG_MQTT_TASK_STACK_SIZE`             | varies  |                                   |

Warning: if stacks are too small, ESP-IDF crashes unpredictably — not always obviously a stack overflow.

### Heap optimization

- Analyze usage, remove unused mallocs, reduce sizes, free earlier
- lwIP: see `CONFIG_LWIP_*` minimum RAM options
- WiFi: reduce static/dynamic buffer counts (see WiFi Buffer Usage docs)
- Ethernet DMA: `CONFIG_ETH_DMA_BUFFER_SIZE`, `_RX_BUFFER_NUM`, `_TX_BUFFER_NUM`
- MbedTLS: see reducing heap usage docs
- BLE connections: `CONFIG_BTDM_CTRL_BLE_MAX_CONN`

### C/C++ code patterns for embedded

- Prefer `const` for everything possible (flash instead of RAM)
- Avoid `std::string` / `std::vector` in hot paths — causes heap churn and fragmentation
- Use stack buffers with known max sizes for short-lived data
- Check all `malloc`/`realloc`/`strdup` return values
- Free resources on all error paths

---

## Speed Optimization

### Flash access speed

- `CONFIG_ESPTOOLPY_FLASHFREQ=80m` — doubles default 40 MHz (verify HW support)
- `CONFIG_ESPTOOLPY_FLASHMODE=QIO` — nearly doubles DIO speed (verify flash chip + wiring)

### Compiler

- `CONFIG_COMPILER_OPTIMIZATION=O2` — best speed, increases binary size
- `CONFIG_COMPILER_OPTIMIZATION=Os` — good compromise (smaller + reasonably fast)
- Re-enable `-fjump-tables -ftree-switch-conversion` per source file for hot switch statements

### IRAM placement

Move hot-path functions to IRAM with `IRAM_ATTR` — executes at full CPU speed, no cache misses. IRAM is limited, so be selective. Small routines (<1-2ms) can show cache miss variance; IRAM placement eliminates this.

### Arithmetic

- Avoid `double` (software-emulated, very slow). Use `float` (hardware FPU) or fixed-point
- Prefer integer math in hot paths

### Logging

- Lower `CONFIG_LOG_DEFAULT_LEVEL` and `CONFIG_BOOTLOADER_LOG_LEVEL`
- Increase `CONFIG_ESP_CONSOLE_UART_BAUDRATE`
- Disable `CONFIG_LOG_DYNAMIC_LEVEL_CONTROL` — ~10x faster log calls
- Set low default level, high max level, then `esp_log_level_set()` at runtime for specific tags

### Task priorities (built-in reference)

| Task            | Priority | Core |
| --------------- | -------- | ---- |
| WiFi Driver     | 23       | 0    |
| ESP Timer       | 22       | 0    |
| NimBLE Host     | 21       | 0    |
| Event Loop      | 20       | 0    |
| lwIP TCP/IP     | 18       | any  |
| Main (app_main) | 1        | 0    |

Tasks MUST yield (vTaskDelay, semaphores, queues) to avoid starving lower-priority tasks. Flash writes suspend all task execution — only IRAM-safe interrupt handlers continue.

### Interrupts

- Use `ESP_INTR_FLAG_LEVEL2`/`LEVEL3` for priority
- Pin to Core 1 (avoids WiFi/BT contention on Core 0)
- Set `ESP_INTR_FLAG_IRAM` for handlers that must run during flash writes

### I/O performance

- POSIX `read()`/`write()` faster than `fread()`/`fwrite()` (no buffering overhead)
- Default Newlib buffer is 128 bytes — increase via `setvbuf()` or `CONFIG_FATFS_VFS_FSTAT_BLKSIZE`

### Startup time

- `CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP=y` — faster wake
- `CONFIG_BOOTLOADER_SKIP_VALIDATE_ON_POWER_ON=y` — skip verification (risk: flash corruption)
- `CONFIG_RTC_CLK_CAL_CYCLES=0` — skip slow clock calibration
- `CONFIG_SPIRAM_MEMTEST=n` — saves ~1s per 4 MB PSRAM

---

## Binary Size Optimization

### Compiler & linker

- `CONFIG_COMPILER_OPTIMIZATION=Os` — optimize for size
- `CONFIG_COMPILER_OPTIMIZATION_ASSERTION_LEVEL=1` (Silent) — removes assertion strings
- Disable `CONFIG_COMPILER_CXX_EXCEPTIONS` and `CONFIG_COMPILER_CXX_RTTI`
- `CONFIG_COMPILER_OPTIMIZATION_CHECKS_SILENT=y` — removes error messages from ESP-IDF macros
- Disable `CONFIG_ESP_ERR_TO_NAME_LOOKUP` — errors print as integers instead of strings

### Logging

- Lower `CONFIG_LOG_DEFAULT_LEVEL` (each level removes log strings from binary)
- Disable `CONFIG_LOG_DYNAMIC_LEVEL_CONTROL` — saves ~260B IRAM + ~264B DRAM + ~1KB flash

### C library

- Picolibc (`CONFIG_LIBC_PICOLIBC=y`) — up to 30 KB savings vs newlib; **default in ESP-IDF 6.x** (no longer experimental). `CONFIG_NEWLIB_NANO_FORMAT` is gone in IDF 6

### System

- `CONFIG_ESP_SYSTEM_PANIC=silent_reboot` — removes panic handler strings
- `CONFIG_HAL_DEFAULT_ASSERTION_LEVEL=0` — removes HAL assertion code

### Component-specific (disable if unused)

**WiFi:** `CONFIG_ESP_WIFI_ENABLE_WPA3_SAE`, `CONFIG_ESP_WIFI_SOFTAP_SUPPORT`, `CONFIG_ESP_WIFI_ENTERPRISE_SUPPORT`
**BLE NimBLE:** Reduce `CONFIG_BT_NIMBLE_MAX_CONNECTIONS` to 1, disable unused roles (`CENTRAL`, `OBSERVER`), lower `CONFIG_BT_NIMBLE_LOG_LEVEL`
**lwIP:** `CONFIG_LWIP_IPV6=n` if IPv4 only
**VFS:** `CONFIG_VFS_SUPPORT_TERMIOS=n` (~1.8KB), `CONFIG_VFS_SUPPORT_SELECT=n` (~2.7KB), `CONFIG_VFS_SUPPORT_DIR=n` (~0.5KB)
**MbedTLS:** Disable unused features: `SHA512_C`, `SHA3_C`, `SSL_ALPN`, `SSL_RENEGOTIATION`, `CCM_C`, `GCM_C`, `ECP_NIST_OPTIM`, `ERROR_STRINGS`, unused cipher suites and curves

---

## Quick-Start sdkconfig.defaults Template

```ini
# Size-optimized build
CONFIG_COMPILER_OPTIMIZATION_SIZE=y

# Move system functions to flash (free IRAM)
CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y
CONFIG_RINGBUF_PLACE_FUNCTIONS_INTO_FLASH=y
CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH=y

# Reduce logging
CONFIG_LOG_DEFAULT_LEVEL=1
CONFIG_BOOTLOADER_LOG_LEVEL=1
CONFIG_LOG_DYNAMIC_LEVEL_CONTROL=n

# Disable unused C++ features
CONFIG_COMPILER_CXX_EXCEPTIONS=n
CONFIG_COMPILER_CXX_RTTI=n
```

---

## Checklist After Optimization

1. `idf.py build` succeeds (no IRAM overflow)
2. `idf.py flash monitor` — firmware boots
3. Tests pass
4. Heap headroom is sufficient at runtime
5. Task stacks have adequate high water marks

---

## mikrojs Project Status (verified June 2026 audit)

Don't re-recommend these — they are already in place:

- `packages/@mikrojs/firmware/sdkconfig.defaults` (+ per-chip variants) already sets: `-Os`, exceptions/RTTI off, FreeRTOS/heap/ringbuf functions in flash, `ESP_WIFI_IRAM_OPT=n`, `ESP_WIFI_RX_IRAM_OPT=n`, log level NONE, `VFS_SUPPORT_SELECT=n`, `HAL_DEFAULT_ASSERTION_LEVEL=0`, TLS 1.3 off, `MBEDTLS_DYNAMIC_BUFFER=y`, `MBEDTLS_SSL_KEEP_PEER_CERTIFICATE=n`, CMN cert bundle, trimmed ECC curves/PKCS7/PEM/CRL/error strings, NimBLE peripheral+broadcaster only, WiFi static RX buffers reduced to 10.
- PSRAM: `CONFIG_SPIRAM=y` + `CONFIG_SPIRAM_USE_MALLOC=y` + `IGNORE_NOTFOUND` on esp32/s3/c5 variants. QuickJS heap goes to PSRAM via `CONFIG_MIKROJS_QUICKJS_HEAP_PSRAM` (Kconfig, default y if SPIRAM) → custom `JSMallocFunctions` in `packages/@mikrojs/native/src/mem.cpp` route to `heap_caps_malloc(MALLOC_CAP_SPIRAM)` with libc fallback.
- Runtime: `JS_NewRuntime2` with custom allocator; `JS_SetMemoryLimit(free_heap − app_config.mem_reserved)` and stack size = 2/3 of main task stack, both set in `mik_main.cpp` (~line 310). Context uses selective intrinsics (DOMException dropped, ~4.3 KB/runtime). Builtin bytecode lives in .rodata and deserializes lazily on first import. AbortController/Signal are lazy getters.
- WiFi and BLE both init lazily (on first JS use) and have full teardown paths; teardown currently only runs at runtime shutdown.

Known open gaps (from the audit; verify still true before acting):

1. ~~`JS_SetGCThreshold` is never called~~ **Fixed (June 2026)**: `mik__clamp_gc_threshold` in `mikrojs.cpp` caps the cycle-GC threshold at `mem_limit − mem_limit/8` at runtime creation, and `MIK_Loop` re-applies the cap each turn (QuickJS raises the threshold to 1.5× live size after every GC pass, which could push it back above the limit). Only affects cyclic garbage; refcounting frees acyclic garbage regardless. Regression tests in `test/oom_test.cpp`.
2. No build-time low-memory/no-BLE profile; `CONFIG_BT_ENABLED=y` in base defaults costs ~40-60 KB SRAM for apps that never use BLE (test build disables it as precedent).
3. No JS API to deinit WiFi (`esp_wifi_deinit`, ~50-65 KB) or BLE (`nimble_port_deinit`, ~30-50 KB) mid-session; teardown code exists but is only wired to shutdown.
4. HTTP task: 12 KB stack × up to 4 concurrent requests; header array realloc is unbounded (no max-header cap).
5. Untouched knobs worth measuring: `MBEDTLS_SSL_IN_CONTENT_LEN` (16384 → 8192 halves per-connection peak with DYNAMIC_BUFFER), `CONFIG_LIBC_LOCKS_PLACE_IN_IRAM=y` (default, could flip to n), `-flto` for QuickJS objects, `QJS_DISABLE_PARSER` for bytecode-only deployments (~50-100 KB flash).
6. `JS_READ_OBJ_ROM_DATA` is a no-op in QuickJS-NG (broken by inline caches) — flash-resident bytecode without heap copy needs an invasive patch; not worth it.

Measure with `packages/@mikrojs/native/test/memory_bench.cpp` (host) and `sys.memoryUsage()` / `mikro logs` on device.

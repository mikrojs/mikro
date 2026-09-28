---
title: Platform Abstraction
description: The MIKPlatform interface that decouples the runtime from OS and hardware
---

# Platform Abstraction

The runtime has no direct OS or hardware dependencies. All platform-specific operations go through the `MIKPlatform` interface. This makes it possible to run the same runtime on a desktop (POSIX), a microcontroller (ESP-IDF), or a new platform entirely.

## MIKPlatform interface

Defined in `include/mikrojs/platform.h`:

```c
typedef struct MIKPlatform {
    // Timing
    int64_t (*get_boot_us)(void);          // Monotonic clock (microseconds)
    int64_t (*get_rtc_us)(void);           // RTC clock (survives deep sleep)
    uint32_t (*random)(void);              // Hardware RNG

    // System control
    void (*restart)(void);                 // Reboot
    const char* (*get_reset_reason)(void); // Why the chip last reset
    void (*yield)(void);                   // Cooperative yield
    void (*wait)(int64_t timeout_us);      // Block until wake() or the timeout (optional)
    void (*wake)(void);                    // End a wait, from a task (optional)

    // Memory info
    size_t (*get_free_system_mem)(void);
    size_t (*get_min_free_system_mem)(void);     // Low watermark
    size_t (*get_total_system_mem)(void);
    size_t (*get_largest_free_system_mem)(void); // Largest contiguous free block

    // Filesystem info
    bool (*get_fs_info)(const char* label, size_t* total, size_t* used);

    // I/O
    void (*log)(int level, const char* tag, const char* fmt, ...);
    int (*stdout_write)(const void* buf, size_t len);
    int (*stderr_write)(const void* buf, size_t len);
    int (*stdin_read)(void* buf, size_t len);

    // Identity
    const char* (*get_device_id)(void);   // Unique device ID (required)
} MIKPlatform;
```

## Registration

The platform must be set before creating a runtime:

```c
MIK_SetPlatform(&my_platform);
MIKRuntime* rt = MIK_NewRuntime();
```

`MIK_GetPlatform()` retrieves the active implementation. There is one platform per process (not per runtime).

## POSIX implementation

`src/platform_posix.cpp` provides a desktop implementation:

| Function              | Implementation                                   |
| --------------------- | ------------------------------------------------ |
| `get_boot_us`         | `clock_gettime(CLOCK_MONOTONIC)`                 |
| `get_rtc_us`          | Same as `get_boot_us` (no deep sleep on desktop) |
| `random`              | `arc4random()`                                   |
| `yield`               | `usleep(1000)` (1ms)                             |
| `wait` / `wake`       | Condition variable with a latched wake           |
| `restart`             | `exit(1)`                                        |
| `get_reset_reason`    | Returns `"unknown"` (no chip reset concept)      |
| `get_free_system_mem` | Returns 0 (not applicable)                       |
| `stdout_write`        | `write(fileno(stdout), ...)`                     |
| `stdin_read`          | Non-blocking `read(fileno(stdin), ...)`          |
| `get_device_id`       | FNV-1a hash of hostname (stable across restarts) |

The standalone library tests use the POSIX platform. The Node.js addon has its own (`addon/platform_node.cpp`) without `wait`, since the simulator sleeps between ticks in JavaScript.

## ESP32 implementation

`packages/@mikrojs/firmware/components/mikrojs/platform_esp32.cpp` provides the ESP-IDF implementation:

| Function              | Implementation                                |
| --------------------- | --------------------------------------------- |
| `get_boot_us`         | `esp_timer_get_time()` (resets on deep sleep) |
| `get_rtc_us`          | RTC timer (persists across deep sleep)        |
| `random`              | `esp_random()` (hardware RNG)                 |
| `yield`               | `vTaskDelay(1)` (yields FreeRTOS task)        |
| `wait` / `wake`       | Task notification index 1 on the main task    |
| `restart`             | `esp_restart()`                               |
| `get_reset_reason`    | `esp_reset_reason()` mapped to a string       |
| `get_free_system_mem` | `esp_get_free_heap_size()`                    |
| `get_fs_info`         | `esp_littlefs_info()`                         |
| `stdout_write`        | UART/USB-serial output                        |
| `get_device_id`       | Base MAC from efuse                           |

## What each function is used for

### Timing

`get_boot_us()` is the workhorse: it drives all timer deadlines (`setTimeout`, `setInterval`) and performance measurements. It must be monotonic and microsecond-resolution.

`get_rtc_us()` is used for wall-clock-adjacent operations that need to survive deep sleep. On platforms without deep sleep, it can be the same as `get_boot_us()`.

### Random

`random()` seeds QuickJS's `Math.random()` implementation. On microcontrollers, this should be a hardware RNG for cryptographic quality. On desktop, `arc4random()` suffices.

### Yield, wait and wake

`yield()` is called between loop iterations that have work due now. On FreeRTOS, this lets the WiFi stack, Bluetooth, and other tasks run. On POSIX, a short sleep avoids burning CPU.

`wait(timeout_us)` blocks the loop's task when nothing is due, until the timeout or a `wake()`. A wake that lands before the wait is kept, so a producer never has to know whether the loop is asleep. Both are optional; without them the loop yields between passes. Code outside the runtime calls `wake()` through `MIK_Wake()`. An interrupt handler needs the port's own variant, such as the ESP32 port's `MIK_WakeFromISR()` in `mikrojs_esp32.h`. See [Event loop](event-loop.md#waiting-between-passes).

### Memory and filesystem info

These functions feed `sys.info()` in JavaScript, which reports free heap, total memory, and filesystem usage. They are informational only; the runtime does not use them for decisions.

### I/O

`stdout_write` and `stderr_write` back `console.log` and `console.error`. `stdin_read` feeds the REPL and `stdin.setHandler()`. All three should be non-blocking or bounded.

### Identity

`get_device_id()` is required. It returns a unique, stable, non-empty identifier for the device. The returned string is exposed as `sys.deviceId` in JavaScript and included in the REPL protocol's `MSG_READY` handshake.

On ESP32, the 6-byte base MAC address is encoded as [Crockford's Base32](https://www.crockford.com/base32.html) (10 lowercase characters, no special symbols). The encoding is lossless: decoding the 10 characters recovers the original MAC bytes. On POSIX/Node, an FNV-1a hash of the hostname produces a stable ID that persists across restarts.

### Reset reason

`get_reset_reason()` returns a stable lowercase string describing why the chip last reset, exposed as `sys.resetReason` in JavaScript. On ESP32 it maps `esp_reset_reason()` (`"power-on"`, `"panic"`, `"brownout"`, `"deep-sleep"`, and so on); a clean `restart()` reports `"software"`. POSIX/Node has no chip-reset concept and returns `"unknown"`.

The returned pointer must remain valid for the lifetime of the platform (a `static` buffer is fine).

## Porting to a new platform

To port Mikro.js to a new platform:

1. Implement all functions in `MIKPlatform`
2. Call `MIK_SetPlatform()` with your implementation before creating a runtime
3. Build the standalone library (`packages/@mikrojs/native/`) against your platform's toolchain

The minimum viable implementation needs `get_boot_us`, `random`, `yield`, and the I/O functions. Memory/filesystem info can return zeros and `get_device_id` can return NULL initially.

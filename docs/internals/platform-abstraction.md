---
title: Platform Abstraction
description: The MIKPlatform interface that decouples the runtime from OS and hardware
---

# Platform Abstraction

The runtime has no direct OS or hardware dependencies. All platform-specific operations go through the `MIKPlatform` interface, making it possible to run the same runtime on a desktop (POSIX), a microcontroller (ESP-IDF), or a new platform entirely.

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
    void (*yield)(void);                   // Cooperative yield

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
    const char* (*get_device_id)(void);   // Unique device ID (or NULL)
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
| `restart`             | `exit(1)`                                        |
| `get_free_system_mem` | Returns 0 (not applicable)                       |
| `stdout_write`        | `write(fileno(stdout), ...)`                     |
| `stdin_read`          | Non-blocking `read(fileno(stdin), ...)`          |
| `get_device_id`       | FNV-1a hash of hostname (stable across restarts) |

The POSIX platform is used by both the standalone library tests and the Node.js addon.

## ESP32 implementation

`packages/@mikrojs/firmware/components/mikrojs/platform_esp32.cpp` provides the ESP-IDF implementation:

| Function              | Implementation                                |
| --------------------- | --------------------------------------------- |
| `get_boot_us`         | `esp_timer_get_time()` (resets on deep sleep) |
| `get_rtc_us`          | RTC timer (persists across deep sleep)        |
| `random`              | `esp_random()` (hardware RNG)                 |
| `yield`               | `vTaskDelay(1)` (yields FreeRTOS task)        |
| `restart`             | `esp_restart()`                               |
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

### Yield

`yield()` is called between loop iterations to prevent busy-waiting. On FreeRTOS, this lets the WiFi stack, Bluetooth, and other tasks run. On POSIX, a short sleep avoids burning CPU.

### Memory and filesystem info

These functions feed `sys.info()` in JavaScript, which reports free heap, total memory, and filesystem usage. They are informational only; the runtime does not use them for decisions.

### I/O

`stdout_write` and `stderr_write` back `console.log` and `console.error`. `stdin_read` feeds the REPL and `stdin.setHandler()`. All three should be non-blocking or bounded.

### Identity

`get_device_id()` returns a unique, stable identifier for the device, or NULL if unavailable. The returned string is exposed as `sys.deviceId` in JavaScript and included in the REPL protocol's `MSG_READY` handshake.

On ESP32, the 6-byte base MAC address is encoded as [Crockford's Base32](https://www.crockford.com/base32.html) (10 lowercase characters, no special symbols). The encoding is lossless: decoding the 10 characters recovers the original MAC bytes. On POSIX/Node, an FNV-1a hash of the hostname produces a stable ID that persists across restarts.

The returned pointer must remain valid for the lifetime of the platform (a `static` buffer is fine).

## Porting to a new platform

To port Mikro.js to a new platform:

1. Implement all functions in `MIKPlatform`
2. Call `MIK_SetPlatform()` with your implementation before creating a runtime
3. Build the standalone library (`packages/@mikrojs/native/`) against your platform's toolchain

The minimum viable implementation needs `get_boot_us`, `random`, `yield`, and the I/O functions. Memory/filesystem info can return zeros and `get_device_id` can return NULL initially.

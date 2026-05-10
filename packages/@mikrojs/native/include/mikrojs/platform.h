#pragma once

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MIKPlatform {
    int64_t (*get_boot_us)(void);       /* High-res timer, resets on deep sleep */
    int64_t (*get_rtc_us)(void);        /* RTC timer, survives deep sleep */
    uint32_t (*random)(void);
    void (*restart)(void);
    void (*yield)(void);
    size_t (*get_free_system_mem)(void);
    size_t (*get_min_free_system_mem)(void); /* All-time low watermark */
    size_t (*get_total_system_mem)(void);
    /** Largest contiguous free block (for diagnosing heap fragmentation:
     *  an allocation larger than this fails even if total free is bigger).
     *  On platforms without a native largest-block API, implementations
     *  may return the same value as get_free_system_mem. */
    size_t (*get_largest_free_system_mem)(void);
    /** Free internal-SRAM bytes. On chips with PSRAM this is the subset of
     *  free heap that lives in fast on-chip RAM, which is also what mbedTLS
     *  handshake buffers, WiFi/BLE drivers, and DMA-capable buffers compete
     *  for. Distinct from get_free_system_mem on PSRAM-equipped chips, where
     *  combined heap is dominated by PSRAM and hides internal-SRAM pressure.
     *  On hosts and chips without PSRAM, may return the same value as
     *  get_free_system_mem (or 0 if unavailable). */
    size_t (*get_free_internal_mem)(void);
    /** Largest contiguous free block in internal SRAM. Allocations that
     *  must land in internal RAM (such as mbedTLS record buffers) fail when
     *  this drops below their size, even when get_largest_free_system_mem
     *  reports plenty of contiguous PSRAM. Same fallback rules as
     *  get_free_internal_mem. */
    size_t (*get_largest_free_internal_mem)(void);
    bool (*get_fs_info)(const char* label, size_t* total, size_t* used);
    void (*log)(int level, const char* tag, const char* fmt, ...);
    int (*stdout_write)(const void* buf, size_t len);
    int (*stderr_write)(const void* buf, size_t len);
    int (*stdin_read)(void* buf, size_t len);
    /** Return a unique device identifier string, or NULL if unavailable.
     *  On ESP32 this is the base MAC address encoded as Crockford's Base32
     *  (10 lowercase chars). The encoding is lossless: decoding yields the
     *  original 6 MAC bytes. The returned pointer must remain valid for the
     *  lifetime of the platform. */
    const char* (*get_device_id)(void);
} MIKPlatform;

/* Log levels (matching ESP-IDF ESP_LOG_xxx values) */
#define MIK_LOG_NONE 0
#define MIK_LOG_ERROR 1
#define MIK_LOG_WARN 2
#define MIK_LOG_INFO 3
#define MIK_LOG_DEBUG 4
#define MIK_LOG_VERBOSE 5

/* Return the canonical uppercase name for a log level ("ERROR", "WARN",
 * "INFO", "DEBUG", "VERBOSE", or "?" for unknown). Used by platform log
 * implementations to produce a consistent `[LEVEL] tag: message` prefix
 * across every target. Keeping this in libmikrojs (rather than letting
 * each platform roll its own) is what makes the format cross-platform:
 * add a new platform port and it inherits the format for free. */
static inline const char* mik_log_level_name(int level) {
    switch (level) {
        case MIK_LOG_ERROR:
            return "ERROR";
        case MIK_LOG_WARN:
            return "WARN";
        case MIK_LOG_INFO:
            return "INFO";
        case MIK_LOG_DEBUG:
            return "DEBUG";
        case MIK_LOG_VERBOSE:
            return "VERBOSE";
        default:
            return "?";
    }
}

/* Set the platform implementation for the runtime. Must be called before
 * MIK_NewRuntime(). If not called, a default POSIX implementation is used. */
void MIK_SetPlatform(const MIKPlatform* platform);

/* Get the current platform (returns default POSIX if none was set) */
const MIKPlatform* MIK_GetPlatform(void);

/* Default POSIX implementation */
const MIKPlatform* MIK_DefaultPOSIXPlatform(void);

#ifdef __cplusplus
}
#endif

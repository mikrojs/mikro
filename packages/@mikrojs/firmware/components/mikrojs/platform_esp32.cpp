#include "mikrojs/platform.h"
#include "mikrojs_esp32.h"

#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_rtc_time.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <soc/soc_caps.h>

#include <stdarg.h>
#include <stdio.h>
#include <unistd.h>

/* Check for LittleFS availability (optional — only used for .df directive) */
#ifdef CONFIG_LITTLEFS_MAX_PARTITIONS
#include <esp_littlefs.h>
#define HAS_LITTLEFS 1
#else
#define HAS_LITTLEFS 0
#endif

static int64_t esp32_get_boot_us(void) {
    return esp_timer_get_time();
}

static int64_t esp32_get_rtc_us(void) {
    return (int64_t)esp_rtc_get_time_us();
}

static uint32_t esp32_random(void) {
    return esp_random();
}

static void esp32_restart(void) {
    esp_restart();
}

static void esp32_yield(void) {
    vTaskDelay(1);
}

static size_t esp32_get_free_system_mem(void) {
    return esp_get_free_heap_size();
}

static size_t esp32_get_min_free_system_mem(void) {
    return esp_get_minimum_free_heap_size();
}

static size_t esp32_get_total_system_mem(void) {
    multi_heap_info_t info;
    heap_caps_get_info(&info, MALLOC_CAP_8BIT);
    return info.total_free_bytes + info.total_allocated_bytes;
}

static size_t esp32_get_largest_free_system_mem(void) {
    return heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
}

static bool esp32_get_fs_info(const char* label, size_t* total, size_t* used) {
#if HAS_LITTLEFS
    return esp_littlefs_info(label, total, used) == ESP_OK;
#else
    (void)label;
    (void)total;
    (void)used;
    return false;
#endif
}

/* JS stdio (console.log / console.error / REPL input) goes through
 * the same auto-detecting USB-Serial/JTAG + UART0 console that
 * mik_serial_io.cpp manages. Bypasses newlib stdio / VFS so early
 * boot doesn't pull in the USB-JTAG VFS on battery-boot-fragile
 * boards. mik__console_write already handles the "no host attached"
 * case for USB-JTAG by dropping the payload silently. */

static int esp32_stdout_write(const void* buf, size_t len) {
    return mik__console_write(buf, len);
}

static int esp32_stderr_write(const void* buf, size_t len) {
    return mik__console_write(buf, len);
}

static int esp32_stdin_read(void* buf, size_t len) {
    return mik__console_read(buf, len);
}

/* Base MAC (6 bytes) encoded as Crockford's Base32 (10 lowercase chars).
 * Lossless: decode the 10 chars to recover the original 6 MAC bytes.
 * Crockford's Base32 excludes I, L, O, U to avoid visual ambiguity. */
static const char* esp32_get_device_id(void) {
    static const char cb32[] = "0123456789abcdefghjkmnpqrstvwxyz";
    static char id[11] = {0};  /* 6 bytes (48 bits) -> 10 x 5-bit chars + NUL */
    if (id[0] == '\0') {
        uint8_t m[6];
        esp_efuse_mac_get_default(m);
        /* Pack 6 bytes into a 48-bit value, then extract 5 bits at a time
         * from the most significant end. */
        uint64_t v = ((uint64_t)m[0] << 40) | ((uint64_t)m[1] << 32) |
                     ((uint64_t)m[2] << 24) | ((uint64_t)m[3] << 16) |
                     ((uint64_t)m[4] << 8) | (uint64_t)m[5];
        for (int i = 9; i >= 0; i--) {
            id[i] = cb32[v & 0x1f];
            v >>= 5;
        }
    }
    return id;
}

static void esp32_log(int level, const char* tag, const char* fmt, ...) {
    /* Map MIK_LOG_xxx to ESP_LOG_xxx for the runtime filter check. */
    esp_log_level_t esp_level;
    switch (level) {
        case MIK_LOG_ERROR:
            esp_level = ESP_LOG_ERROR;
            break;
        case MIK_LOG_WARN:
            esp_level = ESP_LOG_WARN;
            break;
        case MIK_LOG_INFO:
            esp_level = ESP_LOG_INFO;
            break;
        case MIK_LOG_DEBUG:
            esp_level = ESP_LOG_DEBUG;
            break;
        case MIK_LOG_VERBOSE:
            esp_level = ESP_LOG_VERBOSE;
            break;
        default:
            return;
    }

    /* Apply the same runtime tag filter esp_log_writev would. We can't
     * delegate to esp_log_writev directly because it passes fmt straight
     * to vprintf without a prefix or newline, and we want a cross-platform
     * `[LEVEL] tag: ...` shape that's visually distinct from ESP-IDF's
     * own `D (12345) tag: ...` subsystem logs. */
    esp_log_level_t tag_level = esp_log_level_get(tag);
    if (tag_level == ESP_LOG_NONE || esp_level > tag_level) return;

    printf("[%s] %s: ", mik_log_level_name(level), tag);
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
    putchar('\n');
}

static const MIKPlatform esp32_platform = {
    .get_boot_us = esp32_get_boot_us,
    .get_rtc_us = esp32_get_rtc_us,
    .random = esp32_random,
    .restart = esp32_restart,
    .yield = esp32_yield,
    .get_free_system_mem = esp32_get_free_system_mem,
    .get_min_free_system_mem = esp32_get_min_free_system_mem,
    .get_total_system_mem = esp32_get_total_system_mem,
    .get_largest_free_system_mem = esp32_get_largest_free_system_mem,
    .get_fs_info = esp32_get_fs_info,
    .log = esp32_log,
    .stdout_write = esp32_stdout_write,
    .stderr_write = esp32_stderr_write,
    .stdin_read = esp32_stdin_read,
    .get_device_id = esp32_get_device_id,
};

/*
 * Global platform pointer + API (replaces platform_posix.cpp for ESP32 builds).
 * The ESP32 platform is the default, so MIK_SetPlatform() doesn't need to be
 * called explicitly unless overriding.
 */
static const MIKPlatform* current_platform = &esp32_platform;

void MIK_SetPlatform(const MIKPlatform* platform) {
    current_platform = platform;
}

const MIKPlatform* MIK_GetPlatform(void) {
    return current_platform;
}

const MIKPlatform* MIK_DefaultPOSIXPlatform(void) {
    /* Not available on ESP32 — return the ESP32 platform instead */
    return &esp32_platform;
}

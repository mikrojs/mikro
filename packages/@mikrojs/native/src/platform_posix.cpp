#include "mikrojs/platform.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

static int64_t posix_get_boot_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static int64_t posix_get_rtc_us(void) {
    /* No deep sleep on desktop — same as boot */
    return posix_get_boot_us();
}

static uint32_t posix_random(void) {
    return arc4random();
}

static void posix_restart(void) {
    exit(1);
}

static void posix_yield(void) {
    usleep(1000);
}

static size_t posix_get_free_system_mem(void) {
    return 0;  /* Not available on desktop */
}

static size_t posix_get_min_free_system_mem(void) {
    return 0;  /* Not available on desktop */
}

static size_t posix_get_total_system_mem(void) {
    return 0;  /* Not available on desktop */
}

static size_t posix_get_largest_free_system_mem(void) {
    return 0;  /* Not available on desktop */
}

static size_t posix_get_free_internal_mem(void) {
    return 0;  /* No internal/PSRAM distinction on desktop */
}

static size_t posix_get_largest_free_internal_mem(void) {
    return 0;  /* No internal/PSRAM distinction on desktop */
}

static void* posix_malloc_psram(size_t size) {
    (void)size;
    return NULL;  /* No PSRAM on desktop; caller falls back to libc */
}

static void* posix_calloc_psram(size_t count, size_t size) {
    (void)count;
    (void)size;
    return NULL;
}

static void* posix_realloc_psram(void* ptr, size_t size) {
    (void)ptr;
    (void)size;
    return NULL;
}

static bool posix_get_fs_info(const char* label, size_t* total, size_t* used) {
    (void)label;
    (void)total;
    (void)used;
    return false;
}

static int posix_stdout_write(const void* buf, size_t len) {
    return (int)write(fileno(stdout), buf, len);
}

static int posix_stderr_write(const void* buf, size_t len) {
    return (int)write(fileno(stderr), buf, len);
}

static int posix_stdin_read(void* buf, size_t len) {
    return (int)read(fileno(stdin), buf, len);
}

/* Derive a stable device ID from the hostname. FNV-1a hash truncated to
 * 6 bytes, then Crockford's Base32 encoded (10 lowercase chars).
 * Deterministic across restarts on the same machine. */
static const char* posix_get_device_id(void) {
    static const char cb32[] = "0123456789abcdefghjkmnpqrstvwxyz";
    static char id[11] = {0};
    if (id[0] == '\0') {
        char hostname[256];
        if (gethostname(hostname, sizeof(hostname)) != 0) {
            hostname[0] = '?';
            hostname[1] = '\0';
        }
        /* FNV-1a 64-bit, then take the low 48 bits */
        uint64_t h = 0xcbf29ce484222325ULL;
        for (const char* p = hostname; *p; p++) {
            h ^= (uint8_t)*p;
            h *= 0x100000001b3ULL;
        }
        uint64_t v = h & 0xffffffffffffULL;
        for (int i = 9; i >= 0; i--) {
            id[i] = cb32[v & 0x1f];
            v >>= 5;
        }
    }
    return id;
}

static const char* posix_get_reset_reason(void) {
    return "unknown";  /* Desktop processes have no chip reset concept */
}

static void posix_log(int level, const char* tag, const char* fmt, ...) {
    if (level < MIK_LOG_ERROR || level > MIK_LOG_VERBOSE) return;
    fprintf(stderr, "[%s] %s: ", mik_log_level_name(level), tag);
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fprintf(stderr, "\n");
}

static const MIKPlatform posix_platform = {
    .get_boot_us = posix_get_boot_us,
    .get_rtc_us = posix_get_rtc_us,
    .random = posix_random,
    .restart = posix_restart,
    .yield = posix_yield,
    .get_free_system_mem = posix_get_free_system_mem,
    .get_min_free_system_mem = posix_get_min_free_system_mem,
    .get_total_system_mem = posix_get_total_system_mem,
    .get_largest_free_system_mem = posix_get_largest_free_system_mem,
    .get_free_internal_mem = posix_get_free_internal_mem,
    .get_largest_free_internal_mem = posix_get_largest_free_internal_mem,
    .malloc_psram = posix_malloc_psram,
    .calloc_psram = posix_calloc_psram,
    .realloc_psram = posix_realloc_psram,
    .get_fs_info = posix_get_fs_info,
    .log = posix_log,
    .stdout_write = posix_stdout_write,
    .stderr_write = posix_stderr_write,
    .stdin_read = posix_stdin_read,
    .get_device_id = posix_get_device_id,
    .get_reset_reason = posix_get_reset_reason,
};

static const MIKPlatform* current_platform = &posix_platform;

void MIK_SetPlatform(const MIKPlatform* platform) {
    current_platform = platform;
}

const MIKPlatform* MIK_GetPlatform(void) {
    return current_platform;
}

const MIKPlatform* MIK_DefaultPOSIXPlatform(void) {
    return &posix_platform;
}

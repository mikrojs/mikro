#include "mikrojs/platform.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

static int64_t node_get_boot_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static int64_t node_get_rtc_us(void) {
    return node_get_boot_us();
}

static uint32_t node_random(void) {
    return arc4random();
}

static void node_restart(void) {
    /* No-op in Node.js context */
}

static void node_yield(void) {
    usleep(1000);
}

static size_t node_get_free_system_mem(void) {
    return 0;
}

static size_t node_get_min_free_system_mem(void) {
    return 0;
}

static size_t node_get_total_system_mem(void) {
    return 0;
}

static size_t node_get_largest_free_system_mem(void) {
    return 0;
}

static size_t node_get_free_internal_mem(void) {
    return 0;
}

static size_t node_get_largest_free_internal_mem(void) {
    return 0;
}

static void* node_malloc_psram(size_t size) {
    (void)size;
    return NULL;
}

static void* node_calloc_psram(size_t count, size_t size) {
    (void)count;
    (void)size;
    return NULL;
}

static void* node_realloc_psram(void* ptr, size_t size) {
    (void)ptr;
    (void)size;
    return NULL;
}

static bool node_get_fs_info(const char* label, size_t* total, size_t* used) {
    (void)label;
    (void)total;
    (void)used;
    return false;
}

/* Minimum log level for the Node platform. Resolved once on first use from
 * the MIK_LOG_LEVEL environment variable (error/warn/info/debug/verbose).
 * Defaults to WARN so dev-mode and profile-mode runs don't spam `D (mikrojs):
 * Loading builtin ...` lines in the user's terminal on every start. Set
 * MIK_LOG_LEVEL=debug to get the full trace back. */
static int node_log_min_level(void) {
    static int cached = -1;
    if (cached != -1) return cached;

    const char* env = getenv("MIK_LOG_LEVEL");
    if (env == nullptr || env[0] == '\0') {
        cached = MIK_LOG_WARN;
    } else if (strcasecmp(env, "error") == 0) {
        cached = MIK_LOG_ERROR;
    } else if (strcasecmp(env, "warn") == 0 || strcasecmp(env, "warning") == 0) {
        cached = MIK_LOG_WARN;
    } else if (strcasecmp(env, "info") == 0) {
        cached = MIK_LOG_INFO;
    } else if (strcasecmp(env, "debug") == 0) {
        cached = MIK_LOG_DEBUG;
    } else if (strcasecmp(env, "verbose") == 0 || strcasecmp(env, "trace") == 0) {
        cached = MIK_LOG_VERBOSE;
    } else {
        cached = MIK_LOG_WARN;
    }
    return cached;
}

static const char* node_get_reset_reason(void) {
    return "unknown"; /* Host processes have no chip reset concept */
}

/* Derive a stable device ID from the hostname. FNV-1a hash truncated to
 * 6 bytes, then Crockford's Base32 encoded (10 lowercase chars).
 * Deterministic across restarts on the same machine. */
static const char* node_get_device_id(void) {
    static const char cb32[] = "0123456789abcdefghjkmnpqrstvwxyz";
    static char id[11] = {0};
    if (id[0] == '\0') {
        char hostname[256];
        if (gethostname(hostname, sizeof(hostname)) != 0) {
            hostname[0] = '?';
            hostname[1] = '\0';
        }
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

static void node_log(int level, const char* tag, const char* fmt, ...) {
    /* MIK_LOG_* constants are ordered ERROR(1) < WARN(2) < INFO(3) < DEBUG(4)
     * < VERBOSE(5), so "more verbose than threshold" = level > threshold. */
    if (level > node_log_min_level()) return;
    if (level < MIK_LOG_ERROR || level > MIK_LOG_VERBOSE) return;

    fprintf(stderr, "[%s] %s: ", mik_log_level_name(level), tag);
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fprintf(stderr, "\n");
}

static int node_stdout_write(const void* buf, size_t len) {
    return (int)write(fileno(stdout), buf, len);
}

static int node_stderr_write(const void* buf, size_t len) {
    return (int)write(fileno(stderr), buf, len);
}

static int node_stdin_read(void* buf, size_t len) {
    return (int)read(fileno(stdin), buf, len);
}

static const MIKPlatform node_platform = {
    .get_boot_us = node_get_boot_us,
    .get_rtc_us = node_get_rtc_us,
    .random = node_random,
    .restart = node_restart,
    .yield = node_yield,
    .get_free_system_mem = node_get_free_system_mem,
    .get_min_free_system_mem = node_get_min_free_system_mem,
    .get_total_system_mem = node_get_total_system_mem,
    .get_largest_free_system_mem = node_get_largest_free_system_mem,
    .get_free_internal_mem = node_get_free_internal_mem,
    .get_largest_free_internal_mem = node_get_largest_free_internal_mem,
    .malloc_psram = node_malloc_psram,
    .calloc_psram = node_calloc_psram,
    .realloc_psram = node_realloc_psram,
    .get_fs_info = node_get_fs_info,
    .log = node_log,
    .stdout_write = node_stdout_write,
    .stderr_write = node_stderr_write,
    .stdin_read = node_stdin_read,
    .get_device_id = node_get_device_id,
    .get_reset_reason = node_get_reset_reason,
};

extern "C" const MIKPlatform* MIK_NodePlatform(void) {
    return &node_platform;
}

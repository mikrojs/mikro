#include "mikrojs/mem.h"

#include <cstdint>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "mikrojs/platform.h"

/*
 * QuickJS uses malloc_usable_size to track memory consumption against its
 * memory limit. When the platform reports live-allocation sizes
 * (malloc_usable_size hook: libc malloc_usable_size / malloc_size,
 * heap_caps_get_allocated_size on ESP-IDF), allocations are returned as-is
 * and QuickJS accounts blocks by their real (rounded-up) size.
 *
 * Without the hook, each allocation is prepended with a size_t header
 * storing the requested size. That costs one word of RAM per live block —
 * ~13 KB across a loaded app's ~3400 blocks on a 32-bit device — which is
 * why the hook path is preferred.
 *
 * The mode is latched at the first allocation and never changes, so every
 * pointer is freed the same way it was allocated. Platforms install before
 * the first runtime exists (ESP32 and node have theirs as the compile-time
 * default), so the latch sees the final platform. The latch is a single
 * word-sized store (null = unlatched, mik__hdr_usable_size = header mode),
 * so concurrent first allocations on a dual-core target can at worst both
 * compute and store the same value — there is no two-variable ordering to
 * observe half-done.
 */

#define HDR_SIZE sizeof(size_t)

static inline size_t hdr_read(void* user) {
    size_t sz;
    memcpy(&sz, static_cast<char*>(user) - HDR_SIZE, sizeof(sz));
    return sz;
}

/* Header-mode usable_size; doubles as the latch marker for that mode. */
static size_t mik__hdr_usable_size(const void* ptr) {
    return hdr_read(const_cast<void*>(ptr));
}

typedef size_t (*MIKUsableSizeFn)(const void*);
static MIKUsableSizeFn g_usable_size_fn = nullptr; /* null = not latched yet */

static inline MIKUsableSizeFn usable_size_fn(void) {
    MIKUsableSizeFn fn = g_usable_size_fn;
    if (!fn) {
        const MIKPlatform* p = MIK_GetPlatform();
        fn = (p && p->malloc_usable_size) ? p->malloc_usable_size : mik__hdr_usable_size;
        g_usable_size_fn = fn;
    }
    return fn;
}

static inline size_t hdr_size(void) {
    return usable_size_fn() == mik__hdr_usable_size ? HDR_SIZE : 0;
}

/* Fault injection for the host OOM tests: fail the JS-heap allocators after
 * a countdown, and keep a net live-allocation counter across every allocator
 * here (all of them free through mik__free, so one counter balances). */
#ifdef MIK_OOM_INJECT
static int64_t g_oom_countdown = -1; /* -1 = disabled */
static int64_t g_live_allocs = 0;

void mik__oom_inject_fail_after(int64_t n) {
    g_oom_countdown = n;
}

int64_t mik__oom_inject_live_allocs(void) {
    return g_live_allocs;
}

static bool oom_inject_should_fail(void) {
    if (g_oom_countdown < 0) return false;
    if (g_oom_countdown == 0) return true;
    g_oom_countdown--;
    return false;
}

void mik__usable_size_latch_override(size_t (*fn)(const void*)) {
    g_usable_size_fn = fn ? fn : mik__hdr_usable_size;
}

#define OOM_INJECT_FAIL() oom_inject_should_fail()
#define LIVE_ALLOCS_ADD(d) (g_live_allocs += (d))
#else
#define OOM_INJECT_FAIL() false
#define LIVE_ALLOCS_ADD(d) ((void)0)
#endif

static inline void hdr_write(void* raw, size_t size, size_t hdr) {
    if (hdr) memcpy(raw, &size, sizeof(size));
}

size_t mik__malloc_usable_size(const void* ptr) {
    if (!ptr) return 0;
    return usable_size_fn()(ptr);
}

void* mik__malloc(size_t size) {
    size_t hdr = hdr_size();
    void* raw = malloc(size + hdr);
    if (!raw) return nullptr;
    hdr_write(raw, size, hdr);
    LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(raw) + hdr;
}

void* mik__mallocz(size_t size) { return mik__calloc(1, size); }

void* mik__calloc(size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) return nullptr;
    size_t total = count * size;
    size_t hdr = hdr_size();
    void* raw = calloc(1, total + hdr);
    if (!raw) return nullptr;
    hdr_write(raw, total, hdr);
    LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(raw) + hdr;
}

void mik__free(void* ptr) {
    if (!ptr) return;
    LIVE_ALLOCS_ADD(-1);
    free(static_cast<char*>(ptr) - hdr_size());
}

void* mik__realloc(void* ptr, size_t size) {
    size_t hdr = hdr_size();
    void* raw = ptr ? static_cast<char*>(ptr) - hdr : nullptr;
    raw = realloc(raw, size + hdr);
    if (!raw) return nullptr;
    hdr_write(raw, size, hdr);
    if (!ptr) LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(raw) + hdr;
}

/* QuickJS-heap allocator. When the PSRAM flag is set, route through the
 * platform's malloc_psram first; if the platform can't satisfy the request
 * (no PSRAM, or PSRAM exhausted), fall back to libc malloc so the runtime
 * keeps working. The fallback only matters on host builds and in PSRAM-OOM
 * edge cases. Under normal ESP32 operation with CONFIG_SPIRAM=y, every
 * allocation lands in PSRAM. */

static bool g_quickjs_heap_psram = false;

void mik__set_quickjs_heap_psram(bool enable) {
    g_quickjs_heap_psram = enable;
}

bool mik__is_quickjs_heap_psram(void) {
    return g_quickjs_heap_psram;
}

void* mik__js_malloc(size_t size) {
    if (OOM_INJECT_FAIL()) return nullptr;
    size_t hdr = hdr_size();
    void* raw = nullptr;
    if (g_quickjs_heap_psram) {
        const MIKPlatform* p = MIK_GetPlatform();
        if (p && p->malloc_psram) {
            raw = p->malloc_psram(size + hdr);
        }
    }
    if (!raw) raw = malloc(size + hdr);
    if (!raw) return nullptr;
    hdr_write(raw, size, hdr);
    LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(raw) + hdr;
}

void* mik__js_calloc(size_t count, size_t size) {
    if (OOM_INJECT_FAIL()) return nullptr;
    if (size && count > SIZE_MAX / size) return nullptr;
    size_t total = count * size;
    size_t hdr = hdr_size();
    void* raw = nullptr;
    if (g_quickjs_heap_psram) {
        const MIKPlatform* p = MIK_GetPlatform();
        if (p && p->calloc_psram) {
            raw = p->calloc_psram(1, total + hdr);
        }
    }
    if (!raw) raw = calloc(1, total + hdr);
    if (!raw) return nullptr;
    hdr_write(raw, total, hdr);
    LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(raw) + hdr;
}

void* mik__js_realloc(void* ptr, size_t size) {
    if (OOM_INJECT_FAIL()) return nullptr;
    size_t hdr = hdr_size();
    void* raw = ptr ? static_cast<char*>(ptr) - hdr : nullptr;
    void* new_raw = nullptr;
    if (g_quickjs_heap_psram) {
        const MIKPlatform* p = MIK_GetPlatform();
        if (p && p->realloc_psram) {
            new_raw = p->realloc_psram(raw, size + hdr);
        }
    }
    if (!new_raw) new_raw = realloc(raw, size + hdr);
    if (!new_raw) return nullptr;
    hdr_write(new_raw, size, hdr);
    if (!ptr) LIVE_ALLOCS_ADD(1);
    return static_cast<char*>(new_raw) + hdr;
}

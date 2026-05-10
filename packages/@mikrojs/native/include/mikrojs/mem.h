#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>

size_t mik__malloc_usable_size(const void* ptr);
void* mik__malloc(size_t size);
void* mik__mallocz(size_t size);
void* mik__calloc(size_t count, size_t size);
void mik__free(void* ptr);
void* mik__realloc(void* ptr, size_t size);

/* QuickJS-heap allocators. Backed by libc malloc by default; routed to
 * PSRAM via the platform's malloc_psram/calloc_psram/realloc_psram hooks
 * when mik__set_quickjs_heap_psram(true) has been called and the platform
 * supports PSRAM. Free is unchanged: PSRAM pointers from heap_caps_malloc
 * free cleanly via standard free() on ESP-IDF. */
void* mik__js_malloc(size_t size);
void* mik__js_calloc(size_t count, size_t size);
void* mik__js_realloc(void* ptr, size_t size);

/* Toggle QuickJS heap allocations to PSRAM (no-op on platforms without
 * PSRAM). Set once before JS_NewRuntime2; do not change mid-run since
 * mik__js_realloc relies on the flag staying consistent with the heap
 * the original pointer came from. */
void mik__set_quickjs_heap_psram(bool enable);
bool mik__is_quickjs_heap_psram(void);

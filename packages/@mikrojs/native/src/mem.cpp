#include "mikrojs/mem.h"

#include <cstdint>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/*
 * QuickJS uses malloc_usable_size to track memory consumption against its
 * memory limit. ESP-IDF lacks a standard malloc_usable_size, and the
 * heap_caps_get_allocated_size alternative reports block sizes including
 * allocator overhead, causing QuickJS to over-count usage.
 *
 * We prepend each allocation with a size_t header storing the requested size.
 */

#define HDR_SIZE sizeof(size_t)

static inline size_t hdr_read(void* user) {
    size_t sz;
    memcpy(&sz, static_cast<char*>(user) - HDR_SIZE, sizeof(sz));
    return sz;
}

static inline void hdr_write(void* raw, size_t sz) {
    memcpy(raw, &sz, sizeof(sz));
}

size_t mik__malloc_usable_size(const void* ptr) {
    if (!ptr) return 0;
    return hdr_read(const_cast<void*>(ptr));
}

void* mik__malloc(size_t size) {
    void* raw = malloc(size + HDR_SIZE);
    if (!raw) return nullptr;
    hdr_write(raw, size);
    return static_cast<char*>(raw) + HDR_SIZE;
}

void* mik__mallocz(size_t size) { return mik__calloc(1, size); }

void* mik__calloc(size_t count, size_t size) {
    if (size && count > SIZE_MAX / size) return nullptr;
    size_t total = count * size;
    void* raw = calloc(1, total + HDR_SIZE);
    if (!raw) return nullptr;
    hdr_write(raw, total);
    return static_cast<char*>(raw) + HDR_SIZE;
}

void mik__free(void* ptr) {
    if (!ptr) return;
    free(static_cast<char*>(ptr) - HDR_SIZE);
}

void* mik__realloc(void* ptr, size_t size) {
    void* raw = ptr ? static_cast<char*>(ptr) - HDR_SIZE : nullptr;
    raw = realloc(raw, size + HDR_SIZE);
    if (!raw) return nullptr;
    hdr_write(raw, size);
    return static_cast<char*>(raw) + HDR_SIZE;
}

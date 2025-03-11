#include "mem.h"

#include <stddef.h>
#include <stdlib.h>

size_t ujs__malloc_usable_size(const void* ptr) { return 0; }

void* ujs__malloc(size_t size) { return malloc(size); }

void* ujs__mallocz(size_t size) { return ujs__calloc(1, size); }

void* ujs__calloc(size_t count, size_t size) { return calloc(count, size); }

void ujs__free(void* ptr) { free(ptr); }

void* ujs__realloc(void* ptr, size_t size) { return realloc(ptr, size); }

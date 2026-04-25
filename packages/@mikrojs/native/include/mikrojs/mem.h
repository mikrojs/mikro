#pragma once

#include <stddef.h>
#include <stdlib.h>

size_t mik__malloc_usable_size(const void* ptr);
void* mik__malloc(size_t size);
void* mik__mallocz(size_t size);
void* mik__calloc(size_t count, size_t size);
void mik__free(void* ptr);
void* mik__realloc(void* ptr, size_t size);

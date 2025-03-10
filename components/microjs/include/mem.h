#pragma once

size_t ujs__malloc_usable_size(const void* ptr);
void* ujs__malloc(size_t size);
void* ujs__mallocz(size_t size);
void* ujs__calloc(size_t count, size_t size);
void ujs__free(void* ptr);
void* ujs__realloc(void* ptr, size_t size);

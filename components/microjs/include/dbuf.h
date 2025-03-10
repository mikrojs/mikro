#pragma once

#include <stddef.h>
#include <stdint.h>
/* XXX: should take an extra argument to pass slack information to the caller */
typedef void* DynBufReallocFunc(void* opaque, void* ptr, size_t size);

typedef struct DynBuf {
    uint8_t* buf;
    size_t size;
    size_t allocated_size;
    bool error; /* true if a memory allocation error occurred */
    DynBufReallocFunc* realloc_func;
    void* opaque; /* for realloc_func */
} DynBuf;

void dbuf_init(DynBuf* s);
void dbuf_init2(DynBuf* s, void* opaque, DynBufReallocFunc* realloc_func);
int dbuf_realloc(DynBuf* s, size_t new_size);
int dbuf_write(DynBuf* s, size_t offset, const void* data, size_t len);
int dbuf_put(DynBuf* s, const void* data, size_t len);
int dbuf_put_self(DynBuf* s, size_t offset, size_t len);
int dbuf_putc(DynBuf* s, uint8_t c);
int dbuf_putstr(DynBuf* s, const char* str);
static inline int dbuf_put_u16(DynBuf* s, uint16_t val) { return dbuf_put(s, (uint8_t*)&val, 2); }
static inline int dbuf_put_u32(DynBuf* s, uint32_t val) { return dbuf_put(s, (uint8_t*)&val, 4); }
static inline int dbuf_put_u64(DynBuf* s, uint64_t val) { return dbuf_put(s, (uint8_t*)&val, 8); }
void dbuf_free(DynBuf* s);
static inline bool dbuf_error(DynBuf* s) { return s->error; }
static inline void dbuf_set_error(DynBuf* s) { s->error = true; }

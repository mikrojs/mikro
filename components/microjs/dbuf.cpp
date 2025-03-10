/* Dynamic buffer package */

#include "dbuf.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "esp_compiler.h"

static void* dbuf_default_realloc(void* opaque, void* ptr, size_t size) {
    return realloc(ptr, size);
}

void dbuf_init2(DynBuf* s, void* opaque, DynBufReallocFunc* realloc_func) {
    memset(s, 0, sizeof(*s));
    if (!realloc_func)
        realloc_func = dbuf_default_realloc;
    s->opaque = opaque;
    s->realloc_func = realloc_func;
}

void dbuf_init(DynBuf* s) { dbuf_init2(s, NULL, NULL); }

/* return < 0 if error */
int dbuf_realloc(DynBuf* s, size_t new_size) {
    size_t size;
    uint8_t* new_buf;
    if (new_size > s->allocated_size) {
        if (s->error)
            return -1;
        size = s->allocated_size * 3 / 2;
        if (size > new_size)
            new_size = size;
        new_buf = static_cast<uint8_t*>(s->realloc_func(s->opaque, s->buf, new_size));
        if (!new_buf) {
            s->error = true;
            return -1;
        }
        s->buf = new_buf;
        s->allocated_size = new_size;
    }
    return 0;
}

int dbuf_write(DynBuf* s, size_t offset, const void* data, size_t len) {
    size_t end;
    end = offset + len;
    if (dbuf_realloc(s, end))
        return -1;
    memcpy(s->buf + offset, data, len);
    if (end > s->size)
        s->size = end;
    return 0;
}

int dbuf_put(DynBuf* s, const void* data, size_t len) {
    if (unlikely((s->size + len) > s->allocated_size)) {
        if (dbuf_realloc(s, s->size + len))
            return -1;
    }
    if (len > 0) {
        memcpy(s->buf + s->size, data, len);
        s->size += len;
    }
    return 0;
}

int dbuf_put_self(DynBuf* s, size_t offset, size_t len) {
    if (unlikely((s->size + len) > s->allocated_size)) {
        if (dbuf_realloc(s, s->size + len))
            return -1;
    }
    memcpy(s->buf + s->size, s->buf + offset, len);
    s->size += len;
    return 0;
}

int dbuf_putc(DynBuf* s, uint8_t c) { return dbuf_put(s, &c, 1); }

int dbuf_putstr(DynBuf* s, const char* str) {
    return dbuf_put(s, (const uint8_t*)str, strlen(str));
}

void dbuf_free(DynBuf* s) {
    /* we test s->buf as a fail safe to avoid crashing if dbuf_free()
       is called twice */
    if (s->buf) {
        s->realloc_func(s->opaque, s->buf, 0);
    }
    memset(s, 0, sizeof(*s));
}

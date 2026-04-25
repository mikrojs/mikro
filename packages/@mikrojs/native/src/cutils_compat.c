/* Provide non-inline definitions of cutils.h functions for C++ linkage.
 *
 * cutils.h declares these as static inline, so they have internal linkage
 * and aren't visible to C++ translation units that use cutils_wrap.h
 * (declarations only). This file provides real external definitions. */
#include <cutils.h>

int mik__dbuf_put(DynBuf *s, const void *data, size_t len) {
    return dbuf_put(s, data, len);
}

int mik__dbuf_putc(DynBuf *s, uint8_t val) {
    return dbuf_putc(s, val);
}

int mik__dbuf_putstr(DynBuf *s, const char *str) {
    return dbuf_putstr(s, str);
}

void mik__dbuf_free(DynBuf *s) {
    dbuf_free(s);
}

void mik__dbuf_init2(DynBuf *s, void *opaque, DynBufReallocFunc *realloc_func) {
    dbuf_init2(s, opaque, realloc_func);
}

int mik__js_has_suffix(const char *str, const char *suffix) {
    return js__has_suffix(str, suffix);
}

void mik__js_pstrcpy(char *buf, int buf_size, const char *str) {
    js__pstrcpy(buf, buf_size, str);
}

char *mik__js_pstrcat(char *buf, int buf_size, const char *s) {
    return js__pstrcat(buf, buf_size, s);
}

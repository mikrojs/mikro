/* C++ compatible wrapper for QuickJS cutils.h.
 *
 * cutils.h contains inline functions with implicit void* → typed pointer
 * conversions that are valid in C but errors in C++/Clang.
 *
 * - On GCC: -fpermissive downgrades these to warnings, so we can include
 *   cutils.h directly.
 * - On Clang: we provide standalone declarations that map to wrapper
 *   functions in cutils_compat.c.
 * - In C: just include cutils.h directly.
 */
#pragma once

#if !defined(__cplusplus) || (defined(__GNUC__) && !defined(__clang__))
/* C code, or GCC C++ (where -fpermissive handles the void* casts) */
#include <cutils.h>
#else
/* Clang C++ — cannot include cutils.h inline functions, use wrappers */

#include <stdint.h>
#include <stddef.h>

extern "C" {

/* Must match the DynBuf definition in cutils.h exactly */
typedef void *DynBufReallocFunc(void *opaque, void *ptr, size_t size);

typedef struct DynBuf {
    uint8_t *buf;
    size_t size;
    size_t allocated_size;
    int error;
    DynBufReallocFunc *realloc_func;
    void *opaque;
} DynBuf;

/* Wrapper functions defined in cutils_compat.c */
int mik__dbuf_put(DynBuf *s, const void *data, size_t len);
int mik__dbuf_putc(DynBuf *s, uint8_t val);
int mik__dbuf_putstr(DynBuf *s, const char *str);
void mik__dbuf_free(DynBuf *s);
void mik__dbuf_init2(DynBuf *s, void *opaque, DynBufReallocFunc *realloc_func);
int mik__js_has_suffix(const char *str, const char *suffix);
void mik__js_pstrcpy(char *buf, int buf_size, const char *str);
char *mik__js_pstrcat(char *buf, int buf_size, const char *s);

/* Map original names to wrapper names */
#define dbuf_put mik__dbuf_put
#define dbuf_putc mik__dbuf_putc
#define dbuf_putstr mik__dbuf_putstr
#define dbuf_free mik__dbuf_free
#define dbuf_init2 mik__dbuf_init2
#define js__has_suffix mik__js_has_suffix
#define js__pstrcpy mik__js_pstrcpy
#define js__pstrcat mik__js_pstrcat

}  /* extern "C" */

#endif

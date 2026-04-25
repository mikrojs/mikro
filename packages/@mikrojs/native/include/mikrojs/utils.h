
#pragma once

#include <mikrojs/cutils_wrap.h>
#include <quickjs.h>

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

struct AssertionInfo {
    const char* file_line;  // filename:line
    const char* message;
    const char* function;
};

#define ERROR_AND_ABORT(expr)                                                              \
    do {                                                                                   \
        static const struct AssertionInfo args = {__FILE__ ":" STRINGIFY(__LINE__), #expr, \
                                                  PRETTY_FUNCTION_NAME};                   \
        mik_assert(args);                                                                  \
    } while (0)

#define MIK__LIKELY(expr) __builtin_expect(!!(expr), 1)
#define MIK__UNLIKELY(expr) __builtin_expect(!!(expr), 0)
#define PRETTY_FUNCTION_NAME __PRETTY_FUNCTION__

#define STRINGIFY_(x) #x
#define STRINGIFY(x) STRINGIFY_(x)

#define CHECK(expr)                   \
    do {                              \
        if (MIK__UNLIKELY(!(expr))) { \
            ERROR_AND_ABORT(expr);    \
        }                             \
    } while (0)

#define CHECK_EQ(a, b) CHECK((a) == (b))
#define CHECK_GE(a, b) CHECK((a) >= (b))
#define CHECK_GT(a, b) CHECK((a) > (b))
#define CHECK_LE(a, b) CHECK((a) <= (b))
#define CHECK_LT(a, b) CHECK((a) < (b))
#define CHECK_NE(a, b) CHECK((a) != (b))
#define CHECK_NULL(val) CHECK((val) == NULL)
#define CHECK_NOT_NULL(val) CHECK((val) != NULL)

void mik_assert(const struct AssertionInfo info);

#define MIK_CONST(x) JS_PROP_INT32_DEF(#x, x, JS_PROP_ENUMERABLE)
#define MIK_CONST2(name, val) JS_PROP_INT32_DEF(name, val, JS_PROP_ENUMERABLE)
#define MIK_CFUNC_DEF(name, length, func1)                           \
    {                                                                \
        name, JS_PROP_C_W_E, JS_DEF_CFUNC, 0, {                      \
            .func = { length, JS_CFUNC_generic, {.generic = func1} } \
        }                                                            \
    }
#define MIK_CFUNC_MAGIC_DEF(name, length, func1, magic)                          \
    {                                                                            \
        name, JS_PROP_C_W_E, JS_DEF_CFUNC, magic, {                              \
            .func = { length, JS_CFUNC_generic_magic, {.generic_magic = func1} } \
        }                                                                        \
    }
#define MIK_CGETSET_DEF(name, fgetter, fsetter)                                 \
    {                                                                           \
        name, JS_PROP_C_W_E, JS_DEF_CGETSET, 0, {                               \
            .getset = {.get = {.getter = fgetter}, .set = {.setter = fsetter} } \
        }                                                                       \
    }

void mik_call_handler(JSContext* ctx, JSValue func, int argc, JSValue* argv);
void mik_dump_error(JSContext* ctx);
void mik_dump_error1(JSContext* ctx, JSValue exception_val);

typedef struct {
    JSValue p;
    JSValue rfuncs[2];
} MIKPromise;

JSValue MIK_InitPromise(JSContext* ctx, MIKPromise* p);
bool MIK_IsPromisePending(JSContext* ctx, MIKPromise* p);
void MIK_FreePromise(JSContext* ctx, MIKPromise* p);
void MIK_FreePromiseRT(JSRuntime* rt, MIKPromise* p);
void MIK_ClearPromise(JSContext* ctx, MIKPromise* p);
void MIK_MarkPromise(JSRuntime* rt, MIKPromise* p, JS_MarkFunc* mark_func);
void MIK_SettlePromise(JSContext* ctx, MIKPromise* p, bool is_reject, int argc, JSValue* argv);
void MIK_ResolvePromise(JSContext* ctx, MIKPromise* p, int argc, JSValue* argv);
void MIK_RejectPromise(JSContext* ctx, MIKPromise* p, int argc, JSValue* argv);
JSValue MIK_NewResolvedPromise(JSContext* ctx, int argc, JSValue* argv);
JSValue MIK_NewRejectedPromise(JSContext* ctx, int argc, JSValue* argv);

JSValue MIK_NewUint8Array(JSContext* ctx, uint8_t* data, size_t size);

#define MIK_THROW_ARG_ERR(ctx, argno, expected) \
    JS_ThrowTypeError(ctx, "expected argument %d to be %s", argno + 1, expected)
#define MIK_CHECK_ARG_RET(ctx, check, argno, expected)  \
    if (!(check)) {                                     \
        return MIK_THROW_ARG_ERR(ctx, argno, expected); \
    }

void mik_dbuf_init(JSContext* ctx, DynBuf* s);

/* ── Native result helpers ───────────────────────────────────────── */
/* Return {ok: true, value: <val>} or {ok: true} (void)
 * or     {ok: false, error: {code: 0x8xxx, message: "...", errno?: 0x...}}
 * or     {ok: false, error: {name: "VariantName", message: "..."}} (named variant)
 * or     {ok: false, error: {name: "VariantName"}} (tag-only variant)
 *
 * Implemented in mik_result.cpp.  The returned objects have the shared
 * Result prototype installed, so user code can chain .map/.match/etc.
 *
 * The `_named` / `_tag` forms produce error objects the JS layer can use
 * directly without a code-to-variant remap — keeps mikrojs/X wrappers as
 * pure re-exports of native:X. */

JSValue mik__result_ok(JSContext* ctx, JSValue value);
JSValue mik__result_ok_void(JSContext* ctx);
JSValue mik__result_err(JSContext* ctx, int code, int platform_errno, const char* fmt, ...)
    __attribute__((format(printf, 4, 5)));
JSValue mik__result_err_named(JSContext* ctx, const char* name, const char* fmt, ...)
    __attribute__((format(printf, 3, 4)));
JSValue mik__result_err_tag(JSContext* ctx, const char* name);
/* Wrap an already-built error object (any shape) in a Result. Caller passes
 * ownership of `error_obj`. For variants with extra fields beyond
 * {name, message} — path, code, limit, etc. */
JSValue mik__result_err_obj(JSContext* ctx, JSValue error_obj);

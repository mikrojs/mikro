
#pragma once

#include <cutils.h>
#include <quickjs.h>

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))

struct AssertionInfo {
    const char* file_line;  // filename:line
    const char* message;
    const char* function;
};

#define ERROR_AND_ABORT(expr)                                                              \
    do {                                                                                   \
        static const struct AssertionInfo args = {__FILE__ ":" STRINGIFY(__LINE__), #expr, \
                                                  PRETTY_FUNCTION_NAME};                   \
        ujs_assert(args);                                                                  \
    } while (0)

#define UJS__LIKELY(expr) __builtin_expect(!!(expr), 1)
#define UJS__UNLIKELY(expr) __builtin_expect(!!(expr), 0)
#define PRETTY_FUNCTION_NAME __PRETTY_FUNCTION__

#define STRINGIFY_(x) #x
#define STRINGIFY(x) STRINGIFY_(x)

#define CHECK(expr)                   \
    do {                              \
        if (UJS__UNLIKELY(!(expr))) { \
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

void ujs_assert(const struct AssertionInfo info);

#define UJS_CONST(x) JS_PROP_INT32_DEF(#x, x, JS_PROP_ENUMERABLE)
#define UJS_CONST2(name, val) JS_PROP_INT32_DEF(name, val, JS_PROP_ENUMERABLE)
#define UJS_CFUNC_DEF(name, length, func1)                           \
    {                                                                \
        name, JS_PROP_C_W_E, JS_DEF_CFUNC, 0, {                      \
            .func = { length, JS_CFUNC_generic, {.generic = func1} } \
        }                                                            \
    }
#define UJS_CFUNC_MAGIC_DEF(name, length, func1, magic)                          \
    {                                                                            \
        name, JS_PROP_C_W_E, JS_DEF_CFUNC, magic, {                              \
            .func = { length, JS_CFUNC_generic_magic, {.generic_magic = func1} } \
        }                                                                        \
    }
#define UJS_CGETSET_DEF(name, fgetter, fsetter)                                 \
    {                                                                           \
        name, JS_PROP_C_W_E, JS_DEF_CGETSET, 0, {                               \
            .getset = {.get = {.getter = fgetter}, .set = {.setter = fsetter} } \
        }                                                                       \
    }

int ujs_obj2addr(JSContext* ctx, JSValue obj, struct sockaddr_storage* ss);
void ujs_addr2obj(JSContext* ctx, JSValue obj, const struct sockaddr* sa, bool skip_port);
void ujs_call_handler(JSContext* ctx, JSValue func, int argc, JSValue* argv);
void ujs_dump_error(JSContext* ctx);
void ujs_dump_error1(JSContext* ctx, JSValue exception_val);

typedef struct {
    JSValue p;
    JSValue rfuncs[2];
} UJSPromise;

JSValue UJS_InitPromise(JSContext* ctx, UJSPromise* p);
bool UJS_IsPromisePending(JSContext* ctx, UJSPromise* p);
void UJS_FreePromise(JSContext* ctx, UJSPromise* p);
void UJS_FreePromiseRT(JSRuntime* rt, UJSPromise* p);
void UJS_ClearPromise(JSContext* ctx, UJSPromise* p);
void UJS_MarkPromise(JSRuntime* rt, UJSPromise* p, JS_MarkFunc* mark_func);
void UJS_SettlePromise(JSContext* ctx, UJSPromise* p, bool is_reject, int argc, JSValue* argv);
void UJS_ResolvePromise(JSContext* ctx, UJSPromise* p, int argc, JSValue* argv);
void UJS_RejectPromise(JSContext* ctx, UJSPromise* p, int argc, JSValue* argv);
JSValue UJS_NewResolvedPromise(JSContext* ctx, int argc, JSValue* argv);
JSValue UJS_NewRejectedPromise(JSContext* ctx, int argc, JSValue* argv);

JSValue UJS_NewUint8Array(JSContext* ctx, uint8_t* data, size_t size);

extern const char* ujs_signal_map[];
extern size_t ujs_signal_map_count;
const char* ujs_getsig(int sig);
int ujs_getsignum(const char* sig_str);

#define UJS_THROW_ARG_ERR(ctx, argno, expected) \
    JS_ThrowTypeError(ctx, "expected argument %d to be %s", argno + 1, expected)
#define UJS_CHECK_ARG_RET(ctx, check, argno, expected)  \
    if (!(check)) {                                     \
        return UJS_THROW_ARG_ERR(ctx, argno, expected); \
    }

void ujs_dbuf_init(JSContext* ctx, DynBuf* s);

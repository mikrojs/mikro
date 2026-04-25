#include "mikrojs/utils.h"

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"

JSValue mik_new_error(JSContext* ctx, int err) {
    JSValue obj = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "message", JS_NewString(ctx, strerror(err)),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "errno", JS_NewInt32(ctx, err), JS_PROP_C_W_E);
    return obj;
}

JSValue mik_throw_errno(JSContext* ctx, int err) {
    return JS_Throw(ctx, mik_new_error(ctx, err));
}

void mik_assert(const struct AssertionInfo info) {
    fprintf(stderr, "%s:%s%s Assertion `%s' failed.\n", info.file_line, info.function,
            *info.function ? ":" : "", info.message);
    fflush(stderr);
    abort();
}

static void mik_dump_obj(JSContext* ctx, FILE* f, JSValue val) {
    const char* str = JS_ToCString(ctx, val);
    if (str) {
        fprintf(f, "%s\n", str);
        JS_FreeCString(ctx, str);
    } else {
        fprintf(f, "[exception]\n");
    }
}

void mik_dump_error(JSContext* ctx) {
    JSValue exception_val = JS_GetException(ctx);
    mik_dump_error1(ctx, exception_val);
    JS_FreeValue(ctx, exception_val);
}

void mik_dump_error1(JSContext* ctx, JSValue exception_val) {
    /* In REPL mode, use the colorized report path */
    if (MIK_IsReplActive()) {
        mik__report_uncaught(ctx, exception_val);
        return;
    }

    int is_error = JS_IsError(exception_val);
    mik_dump_obj(ctx, stderr, exception_val);
    if (is_error) {
        JSValue val = JS_GetPropertyStr(ctx, exception_val, "stack");
        if (!JS_IsUndefined(val)) {
            mik_dump_obj(ctx, stderr, val);
        }
        JS_FreeValue(ctx, val);
    }
    fflush(stderr);
}

void mik_call_handler(JSContext* ctx, JSValue func, int argc, JSValue* argv) {
    JSValue ret, func1;
    /* 'func' might be destroyed when calling itself (if it frees the
       handler), so must take extra care */
    func1 = JS_DupValue(ctx, func);
    ret = JS_Call(ctx, func1, JS_UNDEFINED, argc, argv);
    JS_FreeValue(ctx, func1);
    if (JS_IsException(ret)) {
        mik_dump_error(ctx);
    }
    JS_FreeValue(ctx, ret);
}

JSValue MIK_InitPromise(JSContext* ctx, MIKPromise* p) {
    JSValue rfuncs[2];
    p->p = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(p->p)) {
        return JS_EXCEPTION;
    }
    p->rfuncs[0] = rfuncs[0];
    p->rfuncs[1] = rfuncs[1];
    return JS_DupValue(ctx, p->p);
}

bool MIK_IsPromisePending(JSContext* ctx, MIKPromise* p) { return !JS_IsUndefined(p->p); }

void MIK_FreePromise(JSContext* ctx, MIKPromise* p) {
    JS_FreeValue(ctx, p->rfuncs[0]);
    JS_FreeValue(ctx, p->rfuncs[1]);
    JS_FreeValue(ctx, p->p);
}

void MIK_FreePromiseRT(JSRuntime* rt, MIKPromise* p) {
    JS_FreeValueRT(rt, p->rfuncs[0]);
    JS_FreeValueRT(rt, p->rfuncs[1]);
    JS_FreeValueRT(rt, p->p);
}

void MIK_ClearPromise(JSContext* ctx, MIKPromise* p) {
    p->p = JS_UNDEFINED;
    p->rfuncs[0] = JS_UNDEFINED;
    p->rfuncs[1] = JS_UNDEFINED;
}

void MIK_MarkPromise(JSRuntime* rt, MIKPromise* p, JS_MarkFunc* mark_func) {
    JS_MarkValue(rt, p->p, mark_func);
    JS_MarkValue(rt, p->rfuncs[0], mark_func);
    JS_MarkValue(rt, p->rfuncs[1], mark_func);
}

void MIK_SettlePromise(JSContext* ctx, MIKPromise* p, bool is_reject, int argc, JSValue* argv) {
    JSValue ret = JS_Call(ctx, p->rfuncs[is_reject], JS_UNDEFINED, argc, argv);
    for (int i = 0; i < argc; i++) {
        JS_FreeValue(ctx, argv[i]);
    }
    if (JS_IsException(ret)) {
        mik_dump_error(ctx);
    }
    JS_FreeValue(ctx, ret);
    MIK_FreePromise(ctx, p);
}

void MIK_ResolvePromise(JSContext* ctx, MIKPromise* p, int argc, JSValue* argv) {
    MIK_SettlePromise(ctx, p, false, argc, argv);
}

void MIK_RejectPromise(JSContext* ctx, MIKPromise* p, int argc, JSValue* argv) {
    MIK_SettlePromise(ctx, p, true, argc, argv);
}

static inline JSValue mik__settled_promise(JSContext* ctx, bool is_reject, int argc,
                                           JSValue* argv) {
    JSValue promise, resolving_funcs[2], ret;

    promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        return JS_EXCEPTION;
    }

    ret = JS_Call(ctx, resolving_funcs[is_reject], JS_UNDEFINED, argc, argv);

    for (int i = 0; i < argc; i++) {
        JS_FreeValue(ctx, argv[i]);
    }
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, resolving_funcs[0]);
    JS_FreeValue(ctx, resolving_funcs[1]);

    return promise;
}

JSValue MIK_NewResolvedPromise(JSContext* ctx, int argc, JSValue* argv) {
    return mik__settled_promise(ctx, false, argc, argv);
}

JSValue MIK_NewRejectedPromise(JSContext* ctx, int argc, JSValue* argv) {
    return mik__settled_promise(ctx, true, argc, argv);
}

static void mik__buf_free(JSRuntime* rt, void* opaque, void* ptr) { js_free_rt(rt, ptr); }

JSValue MIK_NewUint8Array(JSContext* ctx, uint8_t* data, size_t size) {
    return JS_NewUint8Array(ctx, data, size, mik__buf_free, NULL, false);
}

void mik_dbuf_init(JSContext* ctx, DynBuf* s) {
    dbuf_init2(s, JS_GetRuntime(ctx), (DynBufReallocFunc*)js_realloc_rt);
}

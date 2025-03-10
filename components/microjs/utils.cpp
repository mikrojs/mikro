#include "utils.h"

#include <stdlib.h>
#include <string.h>

#include "microjs.h"
#include "private.h"

void ujs_assert(const struct AssertionInfo info) {
    fprintf(stderr, "%s:%s%s Assertion `%s' failed.\n", info.file_line, info.function,
            *info.function ? ":" : "", info.message);
    fflush(stderr);
    abort();
}

static void ujs_dump_obj(JSContext* ctx, FILE* f, JSValue val) {
    const char* str = JS_ToCString(ctx, val);
    if (str) {
        fprintf(f, "%s\n", str);
        JS_FreeCString(ctx, str);
    } else {
        fprintf(f, "[exception]\n");
    }
}

void ujs_dump_error(JSContext* ctx) {
    JSValue exception_val = JS_GetException(ctx);
    ujs_dump_error1(ctx, exception_val);
    JS_FreeValue(ctx, exception_val);
}

void ujs_dump_error1(JSContext* ctx, JSValue exception_val) {
    int is_error = JS_IsError(ctx, exception_val);
    ujs_dump_obj(ctx, stderr, exception_val);
    if (is_error) {
        JSValue val = JS_GetPropertyStr(ctx, exception_val, "stack");
        if (!JS_IsUndefined(val)) {
            ujs_dump_obj(ctx, stderr, val);
        }
        JS_FreeValue(ctx, val);
    }
    fflush(stderr);
}

void ujs_call_handler(JSContext* ctx, JSValue func, int argc, JSValue* argv) {
    JSValue ret, func1;
    /* 'func' might be destroyed when calling itself (if it frees the
       handler), so must take extra care */
    func1 = JS_DupValue(ctx, func);
    ret = JS_Call(ctx, func1, JS_UNDEFINED, argc, argv);
    JS_FreeValue(ctx, func1);
    if (JS_IsException(ret)) {
        UJSRuntime* ujs_rt = UJS_GetRuntime(ctx);
        CHECK_NOT_NULL(ujs_rt);
        UJS_Stop(ujs_rt);
    }
    JS_FreeValue(ctx, ret);
}

JSValue UJS_InitPromise(JSContext* ctx, UJSPromise* p) {
    JSValue rfuncs[2];
    p->p = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(p->p)) {
        return JS_EXCEPTION;
    }
    p->rfuncs[0] = JS_DupValue(ctx, rfuncs[0]);
    p->rfuncs[1] = JS_DupValue(ctx, rfuncs[1]);
    return JS_DupValue(ctx, p->p);
}

bool UJS_IsPromisePending(JSContext* ctx, UJSPromise* p) { return !JS_IsUndefined(p->p); }

void UJS_FreePromise(JSContext* ctx, UJSPromise* p) {
    JS_FreeValue(ctx, p->rfuncs[0]);
    JS_FreeValue(ctx, p->rfuncs[1]);
    JS_FreeValue(ctx, p->p);
}

void UJS_FreePromiseRT(JSRuntime* rt, UJSPromise* p) {
    JS_FreeValueRT(rt, p->rfuncs[0]);
    JS_FreeValueRT(rt, p->rfuncs[1]);
    JS_FreeValueRT(rt, p->p);
}

void UJS_ClearPromise(JSContext* ctx, UJSPromise* p) {
    p->p = JS_UNDEFINED;
    p->rfuncs[0] = JS_UNDEFINED;
    p->rfuncs[1] = JS_UNDEFINED;
}

void UJS_MarkPromise(JSRuntime* rt, UJSPromise* p, JS_MarkFunc* mark_func) {
    JS_MarkValue(rt, p->p, mark_func);
    JS_MarkValue(rt, p->rfuncs[0], mark_func);
    JS_MarkValue(rt, p->rfuncs[1], mark_func);
}

void UJS_SettlePromise(JSContext* ctx, UJSPromise* p, bool is_reject, int argc, JSValue* argv) {
    JSValue ret = JS_Call(ctx, p->rfuncs[is_reject], JS_UNDEFINED, argc, argv);
    for (int i = 0; i < argc; i++) {
        JS_FreeValue(ctx, argv[i]);
    }
    JS_FreeValue(ctx, ret); /* XXX: what to do if exception ? */
    JS_FreeValue(ctx, p->rfuncs[0]);
    JS_FreeValue(ctx, p->rfuncs[1]);
    UJS_FreePromise(ctx, p);
}

void UJS_ResolvePromise(JSContext* ctx, UJSPromise* p, int argc, JSValue* argv) {
    UJS_SettlePromise(ctx, p, false, argc, argv);
}

void UJS_RejectPromise(JSContext* ctx, UJSPromise* p, int argc, JSValue* argv) {
    UJS_SettlePromise(ctx, p, true, argc, argv);
}

static inline JSValue ujs__settled_promise(JSContext* ctx, bool is_reject, int argc,
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

JSValue UJS_NewResolvedPromise(JSContext* ctx, int argc, JSValue* argv) {
    return ujs__settled_promise(ctx, false, argc, argv);
}

JSValue UJS_NewRejectedPromise(JSContext* ctx, int argc, JSValue* argv) {
    return ujs__settled_promise(ctx, true, argc, argv);
}

static void ujs__buf_free(JSRuntime* rt, void* opaque, void* ptr) { js_free_rt(rt, ptr); }

JSValue UJS_NewUint8Array(JSContext* ctx, uint8_t* data, size_t size) {
    return JS_NewUint8Array(ctx, data, size, ujs__buf_free, NULL, false);
}

const char* ujs_signal_map[] = {
#ifdef SIGHUP
    [SIGHUP] = "SIGHUP",
#endif
#ifdef SIGINT
    [SIGINT] = "SIGINT",
#endif
#ifdef SIGQUIT
    [SIGQUIT] = "SIGQUIT",
#endif
#ifdef SIGILL
    [SIGILL] = "SIGILL",
#endif
#ifdef SIGTRAP
    [SIGTRAP] = "SIGTRAP",
#endif
#ifdef SIGABRT
    [SIGABRT] = "SIGABRT",
#endif
#ifdef SIGBUS
    [SIGBUS] = "SIGBUS",
#endif
#ifdef SIGFPE
    [SIGFPE] = "SIGFPE",
#endif
#ifdef SIGKILL
    [SIGKILL] = "SIGKILL",
#endif
#ifdef SIGUSR1
    [SIGUSR1] = "SIGUSR1",
#endif
#ifdef SIGSEGV
    [SIGSEGV] = "SIGSEGV",
#endif
#ifdef SIGUSR2
    [SIGUSR2] = "SIGUSR2",
#endif
#ifdef SIGPIPE
    [SIGPIPE] = "SIGPIPE",
#endif
#ifdef SIGALRM
    [SIGALRM] = "SIGALRM",
#endif
#ifdef SIGTERM
    [SIGTERM] = "SIGTERM",
#endif
#ifdef SIGSTKFLT
    [SIGSTKFLT] = "SIGSTKFLT",
#endif
#ifdef SIGCHLD
    [SIGCHLD] = "SIGCHLD",
#endif
#ifdef SIGCONT
    [SIGCONT] = "SIGCONT",
#endif
#ifdef SIGSTOP
    [SIGSTOP] = "SIGSTOP",
#endif
#ifdef SIGTSTP
    [SIGTSTP] = "SIGTSTP",
#endif
#ifdef SIGBREAK
    [SIGBREAK] = "SIGBREAK",
#endif
#ifdef SIGTTIN
    [SIGTTIN] = "SIGTTIN",
#endif
#ifdef SIGTTOU
    [SIGTTOU] = "SIGTTOU",
#endif
#ifdef SIGURG
    [SIGURG] = "SIGURG",
#endif
#ifdef SIGXCPU
    [SIGXCPU] = "SIGXCPU",
#endif
#ifdef SIGXFSZ
    [SIGXFSZ] = "SIGXFSZ",
#endif
#ifdef SIGVTALRM
    [SIGVTALRM] = "SIGVTALRM",
#endif
#ifdef SIGPROF
    [SIGPROF] = "SIGPROF",
#endif
#ifdef SIGWINCH
    [SIGWINCH] = "SIGWINCH",
#endif
#ifdef SIGPOLL
    [SIGPOLL] = "SIGPOLL",
#endif
#ifdef SIGLOST
    [SIGLOST] = "SIGLOST",
#endif
#ifdef SIGPWR
    [SIGPWR] = "SIGPWR",
#endif
#ifdef SIGINFO
    [SIGINFO] = "SIGINFO",
#endif
#ifdef SIGSYS
    [SIGSYS] = "SIGSYS",
#endif
};

size_t ujs_signal_map_count = ARRAY_SIZE(ujs_signal_map);

const char* ujs_getsig(int sig) {
    if (sig < 0 || sig >= ujs_signal_map_count || !ujs_signal_map[sig]) {
        return NULL;
    }

    return ujs_signal_map[sig];
}

int ujs_getsignum(const char* sig_str) {
    for (int i = 0; i < ujs_signal_map_count; i++) {
        const char* s = ujs_signal_map[i];
        if (s && strcmp(sig_str, s) == 0) {
            return i;
        }
    }

    return -1;
}

void ujs_dbuf_init(JSContext* ctx, DynBuf* s) {
    dbuf_init2(s, JS_GetRuntime(ctx), (DynBufReallocFunc*)js_realloc_rt);
}

int js__has_suffix(const char* str, const char* suffix) {
    size_t len = strlen(str);
    size_t slen = strlen(suffix);
    return (len >= slen && !memcmp(str + len - slen, suffix, slen));
}

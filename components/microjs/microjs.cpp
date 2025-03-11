#include "microjs.h"

#include <quickjs.h>

#include "mem.h"
#include "private.h"
#include "utils.h"

#define UJS__DEFAULT_STACK_SIZE 1024 * 1024  // 1 MB

/* JS malloc functions */

static void* ujs__mf_calloc(void* opaque, size_t count, size_t size) {
    (void)opaque;
    return ujs__calloc(count, size);
}

static void* ujs__mf_malloc(void* opaque, size_t size) {
    (void)opaque;
    return ujs__malloc(size);
}

static void ujs__mf_free(void* opaque, void* ptr) {
    (void)opaque;
    ujs__free(ptr);
}

static void* ujs__mf_realloc(void* opaque, void* ptr, size_t size) {
    (void)opaque;
    return ujs__realloc(ptr, size);
}

static const JSMallocFunctions ujs_mf = {
    .js_calloc = ujs__mf_calloc,
    .js_malloc = ujs__mf_malloc,
    .js_free = ujs__mf_free,
    .js_realloc = ujs__mf_realloc,
    .js_malloc_usable_size = ujs__malloc_usable_size,
};

static void ujs__bootstrap_core(JSContext* ctx, JSValue ns) { ujs__mod_fs_init(ctx, ns); }

static JSValue ujs__dispatch_event(JSContext* ctx, JSValue* event) {
    UJSRuntime* ujs_rt = UJS_GetRuntime(ctx);
    CHECK_NOT_NULL(ujs_rt);

    if (ujs_rt->freeing) {
        return JS_UNDEFINED;
    }

    JSValue global_obj = JS_GetGlobalObject(ctx);
    JSValue ret = JS_Call(ctx, ujs_rt->builtins.dispatch_event_func, global_obj, 1, event);
    JS_FreeValue(ctx, global_obj);

    return ret;
}

static void ujs__promise_rejection_tracker(JSContext* ctx, JSValue promise, JSValue reason,
                                           bool is_handled, void* opaque) {
    UJSRuntime* ujs_rt = UJS_GetRuntime(ctx);
    CHECK_NOT_NULL(ujs_rt);

    if (ujs_rt->freeing) {
        return;
    }

    if (!is_handled) {
        JSValue event_name = JS_NewString(ctx, "unhandledrejection");
        JSValue args[3];
        args[0] = event_name;
        args[1] = promise;
        args[2] = reason;

        JSValue event =
            JS_CallConstructor(ctx, ujs_rt->builtins.promise_event_ctor, countof(args), args);
        CHECK_EQ(JS_IsException(event), 0);
        JSValue ret = ujs__dispatch_event(ctx, &event);

        JS_FreeValue(ctx, event);
        JS_FreeValue(ctx, event_name);

        if (JS_IsException(ret)) {
            ujs_dump_error(ctx);
            goto fail;
        } else {
            if (JS_ToBool(ctx, ret)) {
            // The event wasn't cancelled, maybe abort.
            fail:;
                UJSRuntime* ujs_rt = UJS_GetRuntime(ctx);
                CHECK_NOT_NULL(ujs_rt);
                JS_Throw(ujs_rt->ctx, JS_DupValue(ujs_rt->ctx, reason));
                UJS_Stop(ujs_rt);
            }
        }

        JS_FreeValue(ctx, ret);
    }
}

void UJS_DefaultOptions(UJSRunOptions* options) {
    static UJSRunOptions default_options = {.mem_limit = 0, .stack_size = UJS__DEFAULT_STACK_SIZE};

    memcpy(options, &default_options, sizeof(*options));
}

UJSRuntime* UJS_NewRuntime(void) {
    UJSRunOptions options;
    UJS_DefaultOptions(&options);
    return UJS_NewRuntimeInternal(&options);
}

UJSRuntime* UJS_NewRuntimeOptions(UJSRunOptions* options) {
    return UJS_NewRuntimeInternal(options);
}

UJSRuntime* UJS_NewRuntimeInternal(UJSRunOptions* options) {
    JSRuntime* rt = NULL;
    JSContext* ctx = NULL;
    UJSRuntime* ujs_rt = static_cast<UJSRuntime*>(ujs__mallocz(sizeof(*ujs_rt)));

    memcpy(&ujs_rt->options, options, sizeof(*options));

    rt = JS_NewRuntime2(&ujs_mf, NULL);
    CHECK_NOT_NULL(rt);
    ujs_rt->rt = rt;

    ctx = JS_NewContext(rt);
    CHECK_NOT_NULL(ctx);
    ujs_rt->ctx = ctx;

    JS_SetRuntimeOpaque(rt, ujs_rt);
    JS_SetContextOpaque(ctx, ujs_rt);

    /* Set memory limit */
    JS_SetMemoryLimit(rt, options->mem_limit);

    /* Set stack size */
    JS_SetMaxStackSize(rt, options->stack_size);
    /* loader for ES modules */
    JS_SetModuleLoaderFunc(rt, ujs_module_normalizer, ujs_module_loader, ujs_rt);

    /* unhandled promise rejection tracker */
    JS_SetHostPromiseRejectionTracker(rt, ujs__promise_rejection_tracker, NULL);

    /* start bootstrap */
    JSValue global_obj = JS_GetGlobalObject(ctx);
    JSValue core_sym = JS_NewSymbol(ctx, "ujs.internal.core", true);
    JSAtom core_atom = JS_ValueToAtom(ctx, core_sym);
    JSValue core = JS_NewObjectProto(ctx, JS_NULL);

    CHECK_EQ(JS_DefinePropertyValue(ctx, global_obj, core_atom, core, JS_PROP_C_W_E), true);

    ujs__bootstrap_core(ctx, core);

    /* Load some builtin references for easy access */
    ujs_rt->builtins.dispatch_event_func = JS_GetPropertyStr(ctx, global_obj, "dispatchEvent");
    // CHECK_EQ(JS_IsUndefined(ujs_rt->builtins.dispatch_event_func), 0);
    ujs_rt->builtins.promise_event_ctor =
        JS_GetPropertyStr(ujs_rt->ctx, global_obj, "PromiseRejectionEvent");
    // CHECK_EQ(JS_IsUndefined(ujs_rt->builtins.promise_event_ctor), 0);

    /* end bootstrap */
    JS_FreeAtom(ctx, core_atom);
    JS_FreeValue(ctx, core_sym);
    JS_FreeValue(ctx, global_obj);

    /* Timers */
    ujs_rt->timers.timers = NULL;
    ujs_rt->timers.next_timer = 1;

    return ujs_rt;
}

void UJS_FreeRuntime(UJSRuntime* ujs_rt) {
    ujs_rt->freeing = true;

    /* Destroy all timers */
    ujs__timers_destroy(ujs_rt->ctx);

    /* Destroy the JS engine. */
    JS_FreeValue(ujs_rt->ctx, ujs_rt->builtins.dispatch_event_func);
    ujs_rt->builtins.dispatch_event_func = JS_UNDEFINED;
    JS_FreeValue(ujs_rt->ctx, ujs_rt->builtins.promise_event_ctor);
    ujs_rt->builtins.promise_event_ctor = JS_UNDEFINED;
    JS_FreeContext(ujs_rt->ctx);
    JS_FreeRuntime(ujs_rt->rt);
#ifdef DEBUG
    CHECK_EQ(closed, 1);
#else
#endif

    ujs__free(ujs_rt);
}

JSContext* UJS_GetJSContext(UJSRuntime* ujs_rt) { return ujs_rt->ctx; }

UJSRuntime* UJS_GetRuntime(JSContext* ctx) {
    return static_cast<UJSRuntime*>(JS_GetContextOpaque(ctx));
}

void ujs__execute_jobs(JSContext* ctx) {
    JSContext* ctx1;
    int err;

    /* execute the pending jobs */
    for (;;) {
        err = JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx1);
        if (err <= 0) {
            if (err < 0) {
                UJSRuntime* ujs_rt = UJS_GetRuntime(ctx);
                CHECK_NOT_NULL(ujs_rt);
                UJS_Stop(ujs_rt);
            }

            break;
        }
    }
}

/* main loop which calls the user JS callbacks */
int UJS_Loop(UJSRuntime* ujs_rt) {
    int ret = 0;

    if (ret != 0) {
        return ret;
    }

    int r;
    // do {
    //    // todo
    //} while (r == 0 && JS_IsJobPending(ujs_rt->rt));

    if (JS_HasException(ujs_rt->ctx)) {
        ujs_dump_error(ujs_rt->ctx);
        ret = 1;
    }

    return ret;
}

void UJS_Stop(UJSRuntime* ujs_rt) { CHECK_NOT_NULL(ujs_rt); }

int ujs__load_file(JSContext* ctx, DynBuf* dbuf, const char* filename) {  // todo
    return 0;
}

JSValue UJS_EvalModuleContent(JSContext* ctx, const char* filename, const char* content,
                              size_t len) {
    /* Compile then run to be able to set import.meta */
    JSValue ret =
        JS_Eval(ctx, content, len, filename, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(ret)) {
        // js_module_set_import_meta(ctx, ret, use_real_path, is_main);
        ret = JS_EvalFunction(ctx, ret);
    }
    return ret;
}

// @todo remove For debugging only
JSValue UJS_EvalGlobalDebug(JSContext* ctx, const char* filename, const char* content, size_t len) {
    /* Compile then run to be able to set import.meta */
    return JS_Eval(ctx, content, len, filename, JS_EVAL_TYPE_GLOBAL);
}

JSValue UJS_EvalScript(JSContext* ctx, const char* filename) {
    DynBuf dbuf;
    size_t dbuf_size;
    int r;
    JSValue ret;

    ujs_dbuf_init(ctx, &dbuf);
    r = ujs__load_file(ctx, &dbuf, filename);
    if (r != 0) {
        dbuf_free(&dbuf);
        JS_ThrowReferenceError(ctx, "could not load '%s' - %s: %s", filename, "TODO:ErrName",
                               "TODO:ErrMsg");
        return JS_EXCEPTION;
    }

    dbuf_size = dbuf.size;

    /* Add null termination, required by JS_Eval. */
    dbuf_putc(&dbuf, '\0');

    ret = JS_Eval(ctx, (char*)dbuf.buf, dbuf_size - 1, filename, JS_EVAL_TYPE_GLOBAL);

    dbuf_free(&dbuf);
    return ret;
}

JSValue UJS_EvalModule(JSContext* ctx, const char* filename, bool is_main) {
    DynBuf dbuf;
    size_t dbuf_size;
    int r;
    JSValue ret;

    ujs_dbuf_init(ctx, &dbuf);
    r = ujs__load_file(ctx, &dbuf, filename);
    if (r != 0) {
        dbuf_free(&dbuf);
        JS_ThrowReferenceError(ctx, "could not load '%s' - %s: %s", filename, "TODO:ErrName",
                               "TODO:ErrMsg");

        return JS_EXCEPTION;
    }

    dbuf_size = dbuf.size;

    /* Add null termination, required by JS_Eval. */
    dbuf_putc(&dbuf, '\0');

    ret = UJS_EvalModuleContent(ctx, filename, (char*)dbuf.buf, dbuf_size - 1);

    dbuf_free(&dbuf);
    return ret;
}

#include "mikrojs/mikrojs.h"

#include <quickjs.h>

#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <vector>

#include "mikrojs/mem.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK__DEFAULT_STACK_SIZE 1024 * 1024  // 1 MB

/* JS malloc functions. Routed through the mik__js_* family so the QuickJS
 * heap can be relocated to PSRAM on chips with both internal SRAM and PSRAM,
 * leaving internal SRAM free for mbedTLS, WiFi/BLE, and DMA buffers. */

static void* mik__mf_calloc(void* opaque, size_t count, size_t size) {
    (void)opaque;
    return mik__js_calloc(count, size);
}

static void* mik__mf_malloc(void* opaque, size_t size) {
    (void)opaque;
    return mik__js_malloc(size);
}

static void mik__mf_free(void* opaque, void* ptr) {
    (void)opaque;
    mik__free(ptr);
}

static void* mik__mf_realloc(void* opaque, void* ptr, size_t size) {
    (void)opaque;
    return mik__js_realloc(ptr, size);
}

static const JSMallocFunctions mik_mf = {
    .js_calloc = mik__mf_calloc,
    .js_malloc = mik__mf_malloc,
    .js_free = mik__mf_free,
    .js_realloc = mik__mf_realloc,
    .js_malloc_usable_size = mik__malloc_usable_size,
};

/* Build a frozen object from stored env vars. */
static JSValue mik__build_env_object(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    JSValue env = JS_NewObject(ctx);

    for (const auto& [key, value] : mik_rt->env_vars) {
        JS_DefinePropertyValueStr(ctx, env, key.c_str(), JS_NewString(ctx, value.c_str()),
                                  JS_PROP_ENUMERABLE);
    }

    /* Freeze to prevent mutation */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue object_ctor = JS_GetPropertyStr(ctx, global, "Object");
    JSValue freeze = JS_GetPropertyStr(ctx, object_ctor, "freeze");
    JSValue frozen = JS_Call(ctx, freeze, object_ctor, 1, &env);
    JS_FreeValue(ctx, frozen);
    JS_FreeValue(ctx, freeze);
    JS_FreeValue(ctx, object_ctor);
    JS_FreeValue(ctx, global);

    return env;
}

/* Helper: copy named properties from a namespace object into module exports */
static void mik__export_from_ns(JSContext* ctx, JSModuleDef* m, JSValue ns,
                                const char* const* names, size_t count) {
    for (size_t i = 0; i < count; i++) {
        JS_SetModuleExport(ctx, m, names[i], JS_GetPropertyStr(ctx, ns, names[i]));
    }
}

/* Helper: register export names on a module definition */
static void mik__add_exports(JSContext* ctx, JSModuleDef* m, const char* const* names,
                             size_t count) {
    for (size_t i = 0; i < count; i++) {
        JS_AddModuleExport(ctx, m, names[i]);
    }
}

static const char* const sys_exports[] = {
    "evalScript", "memoryUsage", "jsMemoryUsage", "gc",       "setTime",      "uptime",
    "restart",    "version",     "board",         "firmware", "deviceId",     "activeTimers"};

static int mik__sys_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ns = JS_NewObjectProto(ctx, JS_NULL);
    mik__sys_api_init(ctx, ns);
    mik__export_from_ns(ctx, m, ns, sys_exports, countof(sys_exports));
    JS_FreeValue(ctx, ns);
    return 0;
}

static const char* const stdio_exports[] = {"stdout", "stdin"};

static int mik__stdio_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ns = JS_NewObjectProto(ctx, JS_NULL);
    mik__stdio_init(ctx, ns);
    mik__export_from_ns(ctx, m, ns, stdio_exports, countof(stdio_exports));
    JS_FreeValue(ctx, ns);
    return 0;
}

static JSValue mik__dispatch_event(JSContext* ctx, JSValue* event) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (mik_rt->freeing) {
        return JS_UNDEFINED;
    }

    JSValue global_obj = JS_GetGlobalObject(ctx);
    JSValue ret = JS_Call(ctx, mik_rt->builtins.dispatch_event_func, global_obj, 1, event);
    JS_FreeValue(ctx, global_obj);

    return ret;
}

static void mik__promise_rejection_tracker(JSContext* ctx, JSValue promise, JSValue reason,
                                           bool is_handled, void* opaque) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (mik_rt->freeing) {
        return;
    }

    if (!is_handled) {
        /* If the runtime hasn't loaded the event infrastructure yet,
         * report and bail. */
        if (JS_IsUndefined(mik_rt->builtins.promise_event_ctor) ||
            JS_IsUndefined(mik_rt->builtins.dispatch_event_func)) {
            /* During REPL eval, sync errors are wrapped by the async eval
             * wrapper and appear as promise rejections — don't label them
             * "(in promise)".  Outside eval (e.g. timer callbacks), they
             * are genuine unhandled promise rejections. */
            bool in_promise = !mik__repl_is_evaluating();
            mik__report_uncaught(ctx, reason, in_promise);
            /* Notify the error handler (e.g. host bridge) directly.
             * Don't JS_Throw here — we're inside a QuickJS callback
             * during promise resolution; throwing would corrupt engine
             * state and cause mik__execute_jobs to dump the error a
             * second time. MIK_Stop itself gates on whether we're inside
             * an interactive REPL eval so a typo at the prompt doesn't
             * reboot the device. */
            if (mik_rt->error_handler_fn) {
                mik_rt->error_handler_fn(ctx, reason, mik_rt->error_handler_opaque);
            }
            mik_rt->stop_requested = true;
            MIK_Stop(mik_rt);
            return;
        }

        JSValue event_name = JS_NewString(ctx, "unhandledrejection");
        JSValue args[3];
        args[0] = event_name;
        args[1] = promise;
        args[2] = reason;

        JSValue event =
            JS_CallConstructor(ctx, mik_rt->builtins.promise_event_ctor, countof(args), args);
        if (JS_IsException(event)) {
            JS_FreeValue(ctx, event_name);
            mik_dump_error(ctx);
            return;
        }
        JSValue ret = mik__dispatch_event(ctx, &event);

        JS_FreeValue(ctx, event);
        JS_FreeValue(ctx, event_name);

        if (JS_IsException(ret)) {
            mik_dump_error(ctx);
            goto fail;
        } else {
            if (JS_ToBool(ctx, ret)) {
            // The event wasn't cancelled, maybe abort.
            fail:;
                MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
                CHECK_NOT_NULL(mik_rt);
                mik__report_uncaught(ctx, reason, true);
                if (mik_rt->error_handler_fn) {
                    mik_rt->error_handler_fn(ctx, reason, mik_rt->error_handler_opaque);
                }
                mik_rt->stop_requested = true;
                MIK_Stop(mik_rt);
            }
        }

        JS_FreeValue(ctx, ret);
    }
}

void MIK_DefaultOptions(MIKRunOptions* options) {
    static MIKRunOptions default_options = {
        .mem_limit = 0,
        .stack_size = MIK__DEFAULT_STACK_SIZE,
        .use_psram_heap = false,
    };

    memcpy(options, &default_options, sizeof(*options));
}

MIKRuntime* MIK_NewRuntime(void) {
    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    return MIK_NewRuntimeInternal(&options);
}

MIKRuntime* MIK_NewRuntimeOptions(MIKRunOptions* options) {
    return MIK_NewRuntimeInternal(options);
}

static void mik__check_module_collisions(void);

MIKRuntime* MIK_NewRuntimeInternal(MIKRunOptions* options) {
    const MIKPlatform* platform = MIK_GetPlatform();
    JSRuntime* rt = NULL;
    JSContext* ctx = NULL;
    MIKRuntime* mik_rt = static_cast<MIKRuntime*>(mik__mallocz(sizeof(*mik_rt)));

    /* Placement-new to initialize C++ members (vectors, strings) */
    new (mik_rt) MIKRuntime();

    memcpy(&mik_rt->options, options, sizeof(*options));
    MIK_DefaultConfig(&mik_rt->config);

    /* Switch the QuickJS heap to PSRAM before constructing the runtime,
     * so JS_NewRuntime2 and every subsequent QuickJS allocation lands
     * in PSRAM. The MIKRuntime struct itself stays in internal SRAM:
     * it was allocated before this point. */
    mik__set_quickjs_heap_psram(options->use_psram_heap);

    rt = JS_NewRuntime2(&mik_mf, NULL);
    CHECK_NOT_NULL(rt);
    mik_rt->rt = rt;

    /* Seed Math.random() with real entropy.
     * On ESP32 the system clock starts near epoch 0 on every boot, producing
     * the same seed. Use platform RNG to inject entropy. */
    struct timeval tv_orig;
    gettimeofday(&tv_orig, NULL);
    struct timeval tv_rand = {
        .tv_sec = tv_orig.tv_sec,
        .tv_usec = static_cast<suseconds_t>(platform->random() % 1000000),
    };
    settimeofday(&tv_rand, NULL);

    /* Replacement for JS_NewContext that drops DOMException. Per-intrinsic
     * measurement showed DOMException alone costs ~4.3 KB heap per runtime,
     * while the other optional intrinsics (Proxy ~274 B, Performance ~303 B)
     * are cheap enough to keep for language/standards completeness. Eval
     * must be kept because the JS_Eval C API crashes without it. */
    ctx = JS_NewContextRaw(rt);
    CHECK_NOT_NULL(ctx);
    if (JS_AddIntrinsicBaseObjects(ctx) || JS_AddIntrinsicDate(ctx) ||
        JS_AddIntrinsicEval(ctx) || JS_AddIntrinsicRegExp(ctx) ||
        JS_AddIntrinsicJSON(ctx) || JS_AddIntrinsicProxy(ctx) ||
        JS_AddIntrinsicMapSet(ctx) || JS_AddIntrinsicTypedArrays(ctx) ||
        JS_AddIntrinsicPromise(ctx) || JS_AddIntrinsicWeakRef(ctx) ||
        JS_AddPerformance(ctx)) {
        JS_FreeContext(ctx);
        ctx = NULL;
    }
    CHECK_NOT_NULL(ctx);

    settimeofday(&tv_orig, NULL);
    mik_rt->ctx = ctx;

    JS_SetRuntimeOpaque(rt, mik_rt);
    JS_SetContextOpaque(ctx, mik_rt);

    /* Initialize lazily-assigned JSValue fields so module init code can
     * distinguish "unset" from "set to some object". */
    mik_rt->result_proto = JS_UNDEFINED;
    mik_rt->result_ok_void_singleton = JS_UNDEFINED;

    /* Default fs read cap: 64 KiB. Large enough for typical config/JSON
     * payloads on MCU; small enough that a runaway readFile() can't
     * exhaust the heap. Overridden via MIK_SetFSReadMax. */
    mik_rt->fs_read_max = 65536;

    /* Check for duplicate native module registrations (global registry) */
    mik__check_module_collisions();

    /* Set memory limit */
    JS_SetMemoryLimit(rt, options->mem_limit);

    /* Set stack size */
    JS_SetMaxStackSize(rt, options->stack_size);
    /* loader for ES modules */
    JS_SetModuleLoaderFunc(rt, mik_module_normalizer, mik_module_loader, mik_rt);

    /* unhandled promise rejection tracker */
    JS_SetHostPromiseRejectionTracker(rt, mik__promise_rejection_tracker, NULL);

    /* Register internal C modules */
    JSModuleDef* sys_mod = JS_NewCModule(ctx, "native:sys", mik__sys_module_init);
    CHECK_NOT_NULL(sys_mod);
    mik__add_exports(ctx, sys_mod, sys_exports, countof(sys_exports));

    /* Core native modules registered explicitly (not via MIK_REGISTER_MODULE
     * which relies on linker magic that doesn't work in all build contexts).
     *
     * Result must be initialized before anything that might allocate a
     * Result object — the helpers mik__result_ok/mik__result_err rely on
     * rt->result_proto being set. */
    mik__result_init(ctx);
    mik__cbor_init(ctx);
    mik__udp_init(ctx);
    mik__observable_init(ctx);

    /* Native mikrojs modules (replace bytecode builtins) */
    mik__inspect_register(ctx);
    mik__pub_fs_register(ctx);

    /* Call registered native module init functions */
    for (const auto& mod : mik_rt->native_modules) {
        mod.init_fn(ctx);
    }

    JSModuleDef* stdio_mod = JS_NewCModule(ctx, "native:stdio", mik__stdio_module_init);
    CHECK_NOT_NULL(stdio_mod);
    mik__add_exports(ctx, stdio_mod, stdio_exports, countof(stdio_exports));

    /* Web standard globals */
    JSValue global_obj = JS_GetGlobalObject(ctx);
    mik__text_encoding_init(ctx, global_obj);
    mik__abort_init(ctx, global_obj);

    /* Load some builtin references for easy access */
    mik_rt->builtins.dispatch_event_func = JS_GetPropertyStr(ctx, global_obj, "dispatchEvent");
    mik_rt->builtins.promise_event_ctor =
        JS_GetPropertyStr(mik_rt->ctx, global_obj, "PromiseRejectionEvent");

    /* Timers */
    mik_rt->timers = MIK_NewTimerRegistry();
    mik__timers_init(ctx, global_obj);

    /* Console global (native C++) */
    mik__console_init(ctx, global_obj);

    JS_FreeValue(ctx, global_obj);

    /* Build import.meta.env as a frozen object from stored env vars. */
    mik_rt->env_obj = mik__build_env_object(ctx);

    /* Stdin */
    mik_rt->stdin_state.on_data = JS_UNDEFINED;

    return mik_rt;
}

void MIK_FreeRuntime(MIKRuntime* mik_rt) {
    mik_rt->freeing = true;

    /* Release stdin handler */
    if (!JS_IsUndefined(mik_rt->stdin_state.on_data)) {
        JS_FreeValue(mik_rt->ctx, mik_rt->stdin_state.on_data);
        mik_rt->stdin_state.on_data = JS_UNDEFINED;
    }

    /* Destroy registered loop consumers */
    for (const auto& consumer : mik_rt->loop_consumers) {
        if (consumer.destroy_fn) {
            consumer.destroy_fn(mik_rt->ctx);
        }
    }

    /* Destroy all timers */
    mik__timers_destroy(mik_rt->ctx);
    delete mik_rt->timers;
    mik_rt->timers = nullptr;

    /* Destroy the JS engine. */
    JS_FreeValue(mik_rt->ctx, mik_rt->env_obj);
    mik_rt->env_obj = JS_UNDEFINED;
    JS_FreeValue(mik_rt->ctx, mik_rt->builtins.dispatch_event_func);
    mik_rt->builtins.dispatch_event_func = JS_UNDEFINED;
    JS_FreeValue(mik_rt->ctx, mik_rt->builtins.promise_event_ctor);
    mik_rt->builtins.promise_event_ctor = JS_UNDEFINED;
    JS_FreeValue(mik_rt->ctx, mik_rt->result_ok_void_singleton);
    mik_rt->result_ok_void_singleton = JS_UNDEFINED;
    JS_FreeValue(mik_rt->ctx, mik_rt->result_proto);
    mik_rt->result_proto = JS_UNDEFINED;
    JS_FreeContext(mik_rt->ctx);
    JS_FreeRuntime(mik_rt->rt);

    /* Call destructor for C++ members, then free */
    mik_rt->~MIKRuntime();
    mik__free(mik_rt);
}

JSContext* MIK_GetJSContext(MIKRuntime* mik_rt) { return mik_rt->ctx; }

MIKRuntime* MIK_GetRuntime(JSContext* ctx) {
    return static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
}

void MIK_SetFSBasePath(MIKRuntime* mik_rt, const char* base_path) {
    mik_rt->fs_base_path = base_path;
}

void MIK_SetFSRoot(MIKRuntime* mik_rt, const char* fs_root) {
    mik_rt->fs_root = fs_root;
}

void MIK_SetFSLimit(MIKRuntime* mik_rt, size_t limit) {
    mik_rt->fs_limit = limit;
}

void MIK_SetFSReadMax(MIKRuntime* mik_rt, size_t bytes) {
    mik_rt->fs_read_max = bytes ? bytes : 65536;
}

void MIK_SetEnvVar(MIKRuntime* mik_rt, const char* key, const char* value) {
    for (auto& [k, v] : mik_rt->env_vars) {
        if (k == key) {
            v = value;
            return;
        }
    }
    mik_rt->env_vars.emplace_back(key, value);
}

void MIK_RebuildEnv(MIKRuntime* mik_rt) {
    JS_FreeValue(mik_rt->ctx, mik_rt->env_obj);
    mik_rt->env_obj = mik__build_env_object(mik_rt->ctx);
}

void MIK_RegisterVirtualModule(MIKRuntime* mik_rt, const char* name, const char* source,
                               size_t source_len) {
    mik_rt->virtual_modules[name] = std::string(source, source_len);
}

void MIK_SetPreprocessor(MIKRuntime* mik_rt, MIKPreprocessFn fn, void* opaque) {
    mik_rt->preprocess_fn = fn;
    mik_rt->preprocess_opaque = opaque;
}

void MIK_SetErrorHandler(MIKRuntime* mik_rt, MIKErrorHandlerFn fn, void* opaque) {
    mik_rt->error_handler_fn = fn;
    mik_rt->error_handler_opaque = opaque;
}

void MIK_SetTestEmitHandler(MIKRuntime* mik_rt, MIKTestEmitHandlerFn fn, void* opaque) {
    mik_rt->test_emit_fn = fn;
    mik_rt->test_emit_opaque = opaque;
}

void MIK_RegisterNativeModuleInit(MIKRuntime* mik_rt, const char* name,
                                  MIKNativeModuleInitFn init_fn) {
    mik_rt->native_modules.push_back({name, init_fn});
}

void MIK_RegisterLoopConsumer(MIKRuntime* mik_rt, MIKLoopConsumeFn consume_fn,
                              MIKLoopDestroyFn destroy_fn) {
    mik_rt->loop_consumers.push_back({consume_fn, destroy_fn});
}

void MIK_SetModuleData(MIKRuntime* mik_rt, int slot, void* data) {
    if (slot >= 0 && slot < MIK_MODULE_DATA_SLOTS) {
        mik_rt->module_data[slot] = data;
    }
}

void* MIK_GetModuleData(MIKRuntime* mik_rt, int slot) {
    if (slot >= 0 && slot < MIK_MODULE_DATA_SLOTS) {
        return mik_rt->module_data[slot];
    }
    return nullptr;
}

/* ── Global module registry (populated by MIK_REGISTER_MODULE constructors) ── */

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables)
mik_module_desc_t* mik__module_registry_head = nullptr;

int MIK_AllocModuleSlot(MIKRuntime* mik_rt) {
    int slot = mik_rt->next_module_slot++;
    CHECK(slot < MIK_MODULE_DATA_SLOTS);
    return slot;
}

static void mik__check_module_collisions(void) {
    for (mik_module_desc_t* a = mik__module_registry_head; a != nullptr; a = a->next) {
        for (mik_module_desc_t* b = a->next; b != nullptr; b = b->next) {
            if (strcmp(a->name, b->name) == 0) {
                fprintf(stderr, "FATAL: native module name collision: \"%s\"\n", a->name);
                abort();
            }
        }
    }
    for (mik_ext_builtin_t* a = mik__ext_builtin_head; a != nullptr; a = a->next) {
        for (mik_ext_builtin_t* b = a->next; b != nullptr; b = b->next) {
            if (strcmp(a->name, b->name) == 0) {
                fprintf(stderr, "FATAL: builtin module name collision: \"%s\"\n", a->name);
                abort();
            }
        }
    }
}

void mik__execute_jobs(JSContext* ctx) {
    JSContext* ctx1;
    int err;

    /* execute the pending jobs */
    for (;;) {
        err = JS_ExecutePendingJob(JS_GetRuntime(ctx), &ctx1);
        if (err <= 0) {
            if (err < 0) {
                MIKRuntime* mik_rt = MIK_GetRuntime(ctx1);
                if (mik_rt && mik_rt->error_handler_fn && JS_HasException(ctx1)) {
                    JSValue exc = JS_GetException(ctx1);
                    mik_rt->error_handler_fn(ctx1, exc, mik_rt->error_handler_opaque);
                    JS_Throw(ctx1, exc);
                }
                mik_dump_error(ctx1);
            }
            break;
        }
    }
}

/* main loop which calls the user JS callbacks */
int MIK_Loop(MIKRuntime* mik_rt) {
    /* Deferred restart (see MIK_Stop): once the grace window elapses, reboot
     * the device. While we're still in the window, return 0 without running
     * any more user JS so the protocol serve loop keeps reading host
     * commands but no further timers/microtasks fire on the dead runtime. */
    if (mik_rt->restart_at_us > 0) {
        const MIKPlatform* platform = MIK_GetPlatform();
        if (platform->get_boot_us() >= mik_rt->restart_at_us) {
            platform->restart();
        }
        return 0;
    }
    if (mik_rt->stop_requested) {
        return 1;
    }
    if (JS_HasException(mik_rt->ctx)) {
        if (mik_rt->error_handler_fn) {
            JSValue exc = JS_GetException(mik_rt->ctx);
            mik_rt->error_handler_fn(mik_rt->ctx, exc, mik_rt->error_handler_opaque);
            /* Re-set the exception so mik_dump_error can consume it */
            JS_Throw(mik_rt->ctx, exc);
        }
        mik_dump_error(mik_rt->ctx);
        return 1;
    }
    mik__stdin_consume(mik_rt->ctx);
    mik__timers_consume(mik_rt->ctx);

    /* Call registered loop consumers */
    for (const auto& consumer : mik_rt->loop_consumers) {
        consumer.consume_fn(mik_rt->ctx);
    }

    mik__execute_jobs(mik_rt->ctx);
    return 0;
}

void MIK_SetConfig(MIKRuntime* mik_rt, const MIKConfig* config) {
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(config);
    memcpy(&mik_rt->config, config, sizeof(*config));
    if (config->fs_read_max > 0) {
        mik_rt->fs_read_max = config->fs_read_max;
    }
}

/* Record a profile entry for the entry module loaded via MIK_EvalModule.
 * Uses the same exclusive-delta accounting as the module loader. */
static void mik__record_entry_profile(MIKRuntime* mik_rt,
                                      JSRuntime* rt,
                                      const char* name,
                                      int64_t malloc_before,
                                      size_t entries_before) {
    JSMemoryUsage after;
    JS_ComputeMemoryUsage(rt, &after);
    size_t total_delta = after.malloc_size > malloc_before
                             ? (size_t)(after.malloc_size - malloc_before)
                             : 0;
    size_t children_delta = 0;
    for (size_t i = entries_before; i < mik_rt->profile_entries.size(); i++) {
        children_delta += mik_rt->profile_entries[i].delta_bytes;
    }
    size_t exclusive_delta = total_delta > children_delta ? total_delta - children_delta : 0;

    MIKProfileEntry entry = {};
    size_t name_len = strlen(name);
    if (name_len >= MIK_PROFILE_NAME_MAX) {
        name_len = MIK_PROFILE_NAME_MAX - 1;
    }
    memcpy(entry.name, name, name_len);
    entry.name[name_len] = '\0';
    entry.delta_bytes = exclusive_delta;
    entry.order = mik_rt->profile_entries.size();
    if (mik_rt->profile_entries.size() < mik_rt->profile_entries.capacity()) {
        mik_rt->profile_entries.push_back(entry);
    }
}

void MIK_EnableProfiling(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    mik_rt->profile_enabled = true;
    /* Capture the QuickJS heap baseline (runtime + context + built-in
     * prototypes). Everything profiled after this is module cost. */
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(mik_rt->rt, &mu);
    mik_rt->profile_baseline = mu.malloc_size > 0 ? (size_t)mu.malloc_size : 0;
    /* Reserve up-front so push_back during module loads never reallocates —
     * a reallocation mid-load would be invisible to JS_ComputeMemoryUsage
     * but could still blip memory the app doesn't see, which we want to
     * avoid even in the "profile buffer" itself. 256 slots covers every
     * realistic app import graph. */
    mik_rt->profile_entries.reserve(256);
}

size_t MIK_GetProfileEntryCount(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    return mik_rt->profile_entries.size();
}

const MIKProfileEntry* MIK_GetProfileEntries(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    return mik_rt->profile_entries.data();
}

size_t MIK_GetProfileBaseline(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    return mik_rt->profile_baseline;
}

void MIK_SetOOMHandler(MIKRuntime* mik_rt, MIKOOMHandlerFn fn, void* opaque) {
    CHECK_NOT_NULL(mik_rt);
    mik_rt->oom_handler_fn = fn;
    mik_rt->oom_handler_opaque = opaque;
}

bool MIK_ConsumeOOMFlag(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    bool was_set = mik_rt->oom_flagged;
    mik_rt->oom_flagged = false;
    return was_set;
}

void MIK_ReportOOM(MIKRuntime* mik_rt, const MIKOOMEvent* event) {
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(event);
    mik_rt->oom_flagged = true;
    if (mik_rt->oom_handler_fn) {
        mik_rt->oom_handler_fn(event, mik_rt->oom_handler_opaque);
    }
}

bool MIK_IsStopRequested(MIKRuntime* mik_rt) {
    return mik_rt && mik_rt->stop_requested;
}

void MIK_Stop(MIKRuntime* mik_rt) {
    CHECK_NOT_NULL(mik_rt);
    /* Only firmware (protocol REPL attached) auto-restarts on uncaught
     * exceptions. Host embedders (Node addon, standalone tests) own their
     * own process lifecycle and surface errors via the error handler. */
    if (!MIK_IsReplActive()) {
        return;
    }
    /* A throw inside an interactive REPL eval is a user typo, not an app
     * crash — don't reboot the device. */
    if (mik__repl_is_evaluating()) {
        return;
    }
    /* Defer the restart so the host can still issue deploy/clean/--recover
     * commands during the grace window. The actual platform->restart()
     * fires from MIK_Loop once the deadline elapses. */
    if (mik_rt->restart_at_us == 0) {
        const MIKPlatform* platform = MIK_GetPlatform();
        mik_rt->restart_at_us =
            platform->get_boot_us() + (int64_t)mik_rt->config.panic_restart_delay_ms * 1000;
    }
}

int mik__load_file(JSContext* ctx, DynBuf* dbuf, const char* filename) {
    int fd = open(filename, O_RDONLY);
    if (fd < 0) {
        return -1;
    }

    uint8_t buf[512];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf))) > 0) {
        if (dbuf_put(dbuf, buf, n)) {
            close(fd);
            return -1;
        }
    }

    if (n < 0) {
        close(fd);
        return -1;
    }

    close(fd);
    return 0;
}

void mik__resolve_fs_path(JSContext* ctx, const char* module_name, char* out, size_t out_size) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt && mik_rt->fs_base_path) {
        snprintf(out, out_size, "%s%s", mik_rt->fs_base_path, module_name);
    } else {
        snprintf(out, out_size, "%s", module_name);
    }
}

/* Minimum QuickJS heap budget that should be available after the module
 * graph is fully compiled, before entering the evaluation phase. Top-level
 * code in each module typically allocates closures, atoms, and any
 * eagerly-constructed data structures, so the eval phase needs its own
 * headroom separate from what the compiled bytecode already consumed.
 *
 * Falling below this threshold is the #1 cause of `Error: null` failures —
 * QuickJS OOMs partway through eval, and the recursive-OOM guard in
 * JS_ThrowOutOfMemory leaves the exception slot holding whatever garbage
 * was there. Emitting a proactive warning here gives the user a fighting
 * chance to diagnose it before they see the cryptic symptom.
 *
 * 16 KB is a deliberate middle-ground: large enough that normal apps won't
 * trigger it, small enough that any realistic app running this close to
 * the ceiling IS actually at risk. */
#define MIK__PRE_EVAL_HEADROOM_WARN 16384

static void mik__check_pre_eval_headroom(JSContext* ctx, const char* filename) {
    JSMemoryUsage mem;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);
    if (mem.malloc_limit <= 0) return; /* No limit configured — nothing to warn about. */

    long headroom = (long)mem.malloc_limit - (long)mem.malloc_size;
    if (headroom >= MIK__PRE_EVAL_HEADROOM_WARN) return;

    const MIKPlatform* platform = MIK_GetPlatform();
    platform->log(MIK_LOG_WARN, "mikrojs",
                  "Low QuickJS heap headroom before evaluating '%s': %ld bytes left "
                  "(%ld / %ld used). Module evaluation may fail with OOM. Lower "
                  "`memReserved` in mikro.config.ts or split the module graph with "
                  "dynamic imports.",
                  filename, headroom, (long)mem.malloc_size, (long)mem.malloc_limit);

    /* Signal the host so it can take application-level action (flash LED,
     * log metric, trigger reset, forward to telemetry). Operates on C state
     * only, safe to call even though the JS heap is nearly exhausted. */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt != nullptr) {
        MIKOOMEvent event = {};
        event.phase = MIK_OOM_PRE_EVAL_WARN;
        event.filename = filename;
        event.malloc_size = (size_t)mem.malloc_size;
        event.malloc_limit = (size_t)mem.malloc_limit;
        event.headroom = headroom > 0 ? (size_t)headroom : 0;
        MIK_ReportOOM(mik_rt, &event);
    }
}

JSValue MIK_EvalModuleContent(JSContext* ctx, const char* filename, const char* content,
                              size_t len) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    char* pp_source = NULL;
    size_t pp_len = 0;
    if (mik_rt && mik_rt->preprocess_fn) {
        pp_source =
            mik_rt->preprocess_fn(filename, content, len, &pp_len, mik_rt->preprocess_opaque);
    }
    const char* eval_src = pp_source ? pp_source : content;
    size_t eval_len = pp_source ? pp_len : len;

    /* Compile then run to be able to set import.meta */
    JSValue ret =
        JS_Eval(ctx, eval_src, eval_len, filename, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(pp_source);
    if (!JS_IsException(ret)) {
        js_module_set_import_meta(ctx, ret, true, true);
        mik__check_pre_eval_headroom(ctx, filename);
        ret = JS_EvalFunction(ctx, ret);
    }
    return ret;
}

JSValue MIK_EvalScriptContent(JSContext* ctx, const char* content, size_t len) {
    return JS_Eval(ctx, content, len, "<eval>", JS_EVAL_TYPE_GLOBAL);
}

JSValue MIK_EvalScript(JSContext* ctx, const char* filename) {
    DynBuf dbuf;
    size_t dbuf_size;
    int r;
    JSValue ret;

    mik_dbuf_init(ctx, &dbuf);
    r = mik__load_file(ctx, &dbuf, filename);
    if (r != 0) {
        dbuf_free(&dbuf);
        JS_ThrowReferenceError(ctx, "could not load '%s': %s", filename, strerror(errno));
        return JS_EXCEPTION;
    }

    dbuf_size = dbuf.size;

    /* Add null termination, required by JS_Eval. */
    dbuf_putc(&dbuf, '\0');

    ret = JS_Eval(ctx, (char*)dbuf.buf, dbuf_size - 1, filename, JS_EVAL_TYPE_GLOBAL);

    dbuf_free(&dbuf);
    return ret;
}

JSValue MIK_EvalModule(JSContext* ctx, const char* filename, bool is_main) {
    DynBuf dbuf;
    size_t dbuf_size;
    int r;
    JSValue ret;

    /* Resolve logical module name to filesystem path */
    char fs_path[PATH_MAX];
    mik__resolve_fs_path(ctx, filename, fs_path, sizeof(fs_path));

    /* Prefer pre-compiled bytecode (.bjs) over source (.js), mirroring
     * the same fallback in mik_module_loader_inner. This lets callers
     * always pass .js names; the profile then records consistent .js
     * names for both the entry and its imports. */
    bool is_bjs = js__has_suffix(filename, ".bjs");
    if (!is_bjs && js__has_suffix(filename, ".js")) {
        char bjs_path[PATH_MAX];
        size_t len = strlen(fs_path);
        memcpy(bjs_path, fs_path, len - 3);
        strcpy(bjs_path + len - 3, ".bjs");
        struct stat st;
        if (stat(bjs_path, &st) == 0) {
            memcpy(fs_path, bjs_path, strlen(bjs_path) + 1);
            is_bjs = true;
        }
    }

    mik_dbuf_init(ctx, &dbuf);
    r = mik__load_file(ctx, &dbuf, fs_path);
    if (r != 0) {
        dbuf_free(&dbuf);
        JS_ThrowReferenceError(ctx, "could not load '%s': %s", filename, strerror(errno));

        return JS_EXCEPTION;
    }

    dbuf_size = dbuf.size;

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    bool profile = mik_rt != nullptr && mik_rt->profile_enabled;
    int64_t malloc_before = 0;
    size_t entries_before = 0;
    if (profile) {
        JSMemoryUsage before;
        JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &before);
        malloc_before = before.malloc_size;
        entries_before = mik_rt->profile_entries.size();
    }

    /* Pre-compiled bytecode (.bjs) — deserialize directly */
    if (is_bjs) {
        ret = JS_ReadObject(ctx, dbuf.buf, dbuf_size, JS_READ_OBJ_BYTECODE);
        dbuf_free(&dbuf);
        if (JS_IsException(ret)) {
            return ret;
        }
        if (JS_ResolveModule(ctx, ret) < 0) {
            JS_FreeValue(ctx, ret);
            return JS_EXCEPTION;
        }
        js_module_set_import_meta(ctx, ret, true, is_main);

        /* Record the entry's load cost before JS_EvalFunction. The entry
         * bypasses the module loader, so it needs its own profile entry.
         * JS_ResolveModule above triggered the loader for all imports,
         * which are profiled as children and subtracted. */
        if (profile) {
            mik__record_entry_profile(mik_rt, JS_GetRuntime(ctx), filename, malloc_before,
                                      entries_before);
        }

        mik__check_pre_eval_headroom(ctx, filename);
        return JS_EvalFunction(ctx, ret);
    }

    /* Source module — compile, resolve, evaluate.
     * JS_Eval with COMPILE_ONLY + JS_ResolveModule triggers the module
     * loader for imports (profiled as children). Record the entry's own
     * load cost, then call JS_EvalFunction separately. */
    dbuf_putc(&dbuf, '\0');
    {
        const char* src = (char*)dbuf.buf;
        size_t src_len = dbuf_size - 1;
        char* pp_source = NULL;
        size_t pp_len = 0;
        if (mik_rt && mik_rt->preprocess_fn) {
            pp_source = mik_rt->preprocess_fn(filename, src, src_len, &pp_len,
                                              mik_rt->preprocess_opaque);
        }
        const char* eval_src = pp_source ? pp_source : src;
        size_t eval_len = pp_source ? pp_len : src_len;

        ret = JS_Eval(ctx, eval_src, eval_len, filename,
                      JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
        free(pp_source);
        dbuf_free(&dbuf);

        if (JS_IsException(ret)) {
            return ret;
        }
        js_module_set_import_meta(ctx, ret, true, is_main);

        if (profile) {
            mik__record_entry_profile(mik_rt, JS_GetRuntime(ctx), filename, malloc_before,
                                      entries_before);
        }

        mik__check_pre_eval_headroom(ctx, filename);
        return JS_EvalFunction(ctx, ret);
    }
}

int MIK_RunEntry(MIKRuntime* mik_rt, const char* entry) {
    if (!mik_rt || !entry || entry[0] == '\0') {
        return -EINVAL;
    }

    JSContext* ctx = MIK_GetJSContext(mik_rt);

    char fs_path[PATH_MAX];
    mik__resolve_fs_path(ctx, entry, fs_path, sizeof(fs_path));

    struct stat st;
    bool found = stat(fs_path, &st) == 0;
    if (!found && js__has_suffix(entry, ".js")) {
        char bjs_path[PATH_MAX];
        size_t len = strlen(fs_path);
        if (len >= 3 && len - 3 + sizeof(".bjs") <= sizeof(bjs_path)) {
            memcpy(bjs_path, fs_path, len - 3);
            memcpy(bjs_path + len - 3, ".bjs", sizeof(".bjs"));
            found = stat(bjs_path, &st) == 0;
        }
    }
    if (!found) {
        return -ENOENT;
    }

    JSValue result = MIK_EvalModule(ctx, entry, true);
    bool failed = JS_IsException(result);
    /* Modules with top-level await return a Promise. A module body that
     * throws synchronously rejects that promise before JS_EvalFunction
     * returns, but the value itself is still an Object (rejected Promise),
     * not a JS_EXCEPTION sentinel. Treat sync-rejected as an eval failure
     * so callers (e.g. the test supervisor) don't mistake a fatal module
     * for a successful launch and wait for events that will never come.
     * Pending promises (real TLA awaiting something) continue as normal. */
    if (!failed && JS_IsObject(result)) {
        JSPromiseStateEnum state = JS_PromiseState(ctx, result);
        if (state == JS_PROMISE_REJECTED) {
            failed = true;
        }
    }
    JS_FreeValue(ctx, result);
    return failed ? -EFAULT : 0;
}

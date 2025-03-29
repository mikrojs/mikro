#pragma once

#include <vector>

#include "dbuf.h"
#include "microjs.h"
#include "quickjs.h"

typedef struct UJSTimerEntry {
    uint32_t id;
    // is it an interval or a one-shot timer?
    bool is_interval;
    // original timeout (delay) value
    uint32_t timeout;
    // next deadline, based on system time
    uint32_t next_deadline;
    JSValue func;
    int argc;
    JSValue argv[];
} UJSTimerEntry;

typedef struct UJSTimers {
    std::vector<UJSTimerEntry> entries;
    // note: start at 1 to avoid if (timerId) {...} bugs
    uint32_t next_timer_id = 1;
} UJSTimerRegistry;

typedef struct UJSFS UJSFS;

struct UJSRuntime {
    UJSRunOptions options;
    JSRuntime* rt;
    JSContext* ctx;
    struct {
    } jobs;
    bool is_worker;
    bool freeing;
    UJSFS* fs;
    UJSTimerRegistry* timers;
    struct {
        JSValue promise_event_ctor;
        JSValue dispatch_event_func;
    } builtins;
};

void ujs__mod_fs_init(JSContext* ctx, JSValue ns);

JSValue ujs_new_error(JSContext* ctx, int err);
JSValue ujs_throw_errno(JSContext* ctx, int err);

void ujs__execute_jobs(JSContext* ctx);
JSModuleDef* ujs__load_builtin(JSContext* ctx, const char* name);
int ujs__load_file(JSContext* ctx, DynBuf* dbuf, const char* filename);
JSModuleDef* ujs_module_loader(JSContext* ctx, const char* module_name, void* opaque);
char* ujs_module_normalizer(JSContext* ctx, const char* base_name, const char* name, void* opaque);

int js_module_set_import_meta(JSContext* ctx, JSValue func_val, bool use_realpath, bool is_main);

JSValue ujs__get_args(JSContext* ctx);

int ujs__eval_bytecode(JSContext* ctx, const uint8_t* buf, size_t buf_len, bool check_promise);


void ujs__sab_free(void* opaque, void* ptr);
void ujs__sab_dup(void* opaque, void* ptr);

UJSTimerRegistry* UJS_NewTimerRegistry(void);
UJSRuntime* UJS_NewRuntimeWorker(void);
UJSRuntime* UJS_NewRuntimeInternal(UJSRunOptions* options);
JSValue UJS_EvalScript(JSContext* ctx, const char* filename);
JSValue UJS_EvalModule(JSContext* ctx, const char* filename, bool is_main);
JSValue UJS_EvalModuleContent(JSContext* ctx, const char* filename, const char* content,
                              size_t len);


void ujs__timers_init(JSContext* ctx, JSValue ns);
void ujs__timers_consume(JSContext* ctx);
void ujs__timers_destroy(JSContext* ctx);

#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "mikrojs/cutils_wrap.h"
#include "mikrojs/mikrojs.h"
#include "quickjs.h"

#define MIK_TIMER_MAX_ARGS 4
#define MIK_MAX_DUE_TIMERS 16
#define MIK_STDIN_BUF_SIZE 256

#ifndef PATH_MAX
#define PATH_MAX 255
#endif

typedef struct MIKTimerEntry {
    uint32_t id;
    // is it an interval or a one-shot timer?
    bool is_interval;
    // original timeout (delay) value in microseconds
    int64_t timeout;
    // next deadline in microseconds
    int64_t next_deadline;
    JSValue func;
    int argc;
    JSValue argv[MIK_TIMER_MAX_ARGS];
} MIKTimerEntry;

typedef struct MIKTimers {
    std::vector<MIKTimerEntry> entries;
    // note: start at 1 to avoid if (timerId) {...} bugs
    uint32_t next_timer_id = 1;
} MIKTimerRegistry;

/* Registered native module init function */
struct MIKNativeModuleEntry {
    std::string name;
    MIKNativeModuleInitFn init_fn;
};

/* Registered loop consumer */
struct MIKLoopConsumerEntry {
    MIKLoopConsumeFn consume_fn;
    MIKLoopDestroyFn destroy_fn;
};

/* A promise that rejected without a handler, awaiting the end-of-turn
 * unhandled-rejection check. Mirrors quickjs-libc's JSRejectedPromiseEntry:
 * we hold a reference to both the promise (matched by identity on `handle`)
 * and its reason (reported at flush time). */
struct MIKRejectedPromise {
    JSValue promise;
    JSValue reason;
};

struct MIKRuntime {
    MIKRunOptions options;
    MIKConfig config;
    JSRuntime* rt;
    JSContext* ctx;
    bool is_worker;
    bool freeing;
    bool stop_requested;  /* Set by promise rejection tracker to stop the loop */
    /* Set by MIK_EnableTestHelpers — the test supervisor wants stop_requested
     * to bubble up cleanly so it can synthesize a failing-test event and move
     * to the next file. Without this flag, MIK_Stop would arm a panic-restart
     * deadline and reboot the whole device mid-manifest on the first async
     * rejection. */
    bool test_mode;
    /* Deferred restart deadline (boot_us, 0 = no pending restart). Set by
     * MIK_Stop when an uncaught exception happens with a protocol REPL
     * attached: the serve loop keeps reading commands until the deadline so
     * the host can still deploy/clean/--recover during the grace window,
     * then platform->restart() fires from MIK_Loop. */
    int64_t restart_at_us;
    const char* fs_base_path;
    const char* fs_root;  /* Sandbox root for mikrojs/fs operations (separate from module resolution) */
    size_t fs_limit;      /* Max bytes for fs_root (0 = unlimited) */
    /* Cached bytes used under fs_root. Populated lazily on the first quota
     * check; adjusted in-place on write/unlink so the O(tree) walk only
     * happens once per run, not per write. Callers invalidate by setting
     * fs_used_known=false when they can't cheaply compute the delta. */
    size_t fs_used;
    bool fs_used_known;
    /* Max bytes a single readFile() call will return. Files larger than
     * this throw FSError(EFBIG); callers use open() for streaming. */
    size_t fs_read_max;
    MIKTimerRegistry* timers;
    std::vector<MIKNativeModuleEntry> native_modules;
    std::vector<MIKLoopConsumerEntry> loop_consumers;
    /* Promises that rejected without a handler, awaiting the end-of-turn
     * unhandled-rejection check. The host rejection tracker adds a promise
     * here on `reject` and removes it on `handle`; whatever remains after a
     * microtask drain (mik__execute_jobs) is a genuine unhandled rejection
     * and gets reported. This deferral mirrors the HTML/WinterCG algorithm
     * and is what prevents a transiently-unhandled promise (e.g. a module's
     * evaluation promise, rejected before the import loader attaches its
     * .then) from being reported. Entries hold dup'd references owned by this
     * vector and freed when removed or flushed. */
    std::vector<MIKRejectedPromise> pending_rejections;
    /* Shared prototype for Result objects ({ok, value} / {ok, error}) created
     * by mik__result_ok/mik__result_err and the native:result ok()/err()
     * functions.  Holds .map/.mapErr/.andThen/.match/.orDefault/.orPanic +
     * Symbol.for('mikrojs.inspect').  Initialized eagerly by mik__result_init
     * and freed in MIK_FreeRuntime. */
    JSValue result_proto;
    /* Frozen {ok: true} singleton returned (via JS_DupValue) from
     * mik__result_ok_void. Safe to share because Result is immutable by
     * convention, and the singleton is frozen + non-extensible. */
    JSValue result_ok_void_singleton;
    JSValue env_obj;  /* Frozen object with env vars, set on import.meta.env */
    struct {
        JSValue on_data;  /* JS callback for stdin data, JS_UNDEFINED when not listening */
    } stdin_state;
    /* Env vars stored before runtime init (for building env_obj) */
    std::vector<std::pair<std::string, std::string>> env_vars;
    /* Opaque per-module data slots for platform-specific modules.
     * Used by registered native modules to store their state on the runtime.
     * Slots are allocated dynamically via MIK_AllocModuleSlot(). */
    void* module_data[MIK_MODULE_DATA_SLOTS] = {};
    int next_module_slot = 0;
    /* Virtual modules: name → JS source.  Checked by the module loader before
     * the builtin bytecode table, allowing host-side JS to override any
     * native:* C module (e.g. mocking device modules for desktop dev). */
    std::unordered_map<std::string, std::string> virtual_modules;
    /* Module dependency graph, populated by mik_module_normalizer on every
     * successful normalization call. module_imports[A] = set of modules A
     * statically imports; module_importers[B] = set of modules that import B.
     * Both are keyed by normalized module names (the same strings that
     * appear as JSAtom values on JSModuleDef). Used by mik__unload_module to
     * locate orphaned transitive dependencies. Edges for non-module bases
     * (REPL input, "<input>", task wrappers) are skipped. */
    std::unordered_map<std::string, std::unordered_set<std::string>> module_imports;
    std::unordered_map<std::string, std::unordered_set<std::string>> module_importers;
    /* Optional preprocessor called on module source before compilation.
     * Returns a malloc'd string (caller frees), or NULL to use original source.
     * Used by the Node.js addon to strip TypeScript types. */
    char* (*preprocess_fn)(const char* filename, const char* source, size_t source_len,
                           size_t* out_len, void* opaque) = nullptr;
    void* preprocess_opaque = nullptr;
    /* Optional error handler called with the exception value before mik_dump_error
     * consumes it.  The handler receives the exception as a borrowed JSValue
     * (do NOT free it).  Used by the Node.js addon to forward errors to the host. */
    void (*error_handler_fn)(JSContext* ctx, JSValue error, void* opaque) = nullptr;
    void* error_handler_opaque = nullptr;
    /* Memory profiling: per-module load deltas. Vector capacity is reserved
     * up-front when profiling is enabled so loads don't trigger reallocations
     * that would themselves be visible to JS_ComputeMemoryUsage. The vector
     * itself lives in the regular C++ heap, not the js_malloc pool, so it's
     * invisible to the numbers we're measuring. */
    bool profile_enabled = false;
    std::vector<MIKProfileEntry> profile_entries;
    size_t profile_baseline = 0; /* malloc_size at profiling start */
    /* OOM signalling: flag set by MIK_ReportOOM() when the detection code
     * thinks the runtime is at or past its QuickJS memory ceiling. Cleared
     * by MIK_ConsumeOOMFlag(). Cold path — not read during bytecode
     * execution or allocation, so it adds zero runtime tax. */
    bool oom_flagged = false;
    MIKOOMHandlerFn oom_handler_fn = nullptr;
    void* oom_handler_opaque = nullptr;
    /* Optional handler for __testEmit when not running in protocol mode.
     * The firmware uses protocol mode + mik__repl_proto_send_output to
     * deliver MSG_TEST frames; the Node addon registers a handler here
     * that pushes the same payload onto the host bridge so vitest-style
     * test runners (mikro sim test) can receive events without going
     * through the wire protocol. NULL means __testEmit is a no-op. */
    void (*test_emit_fn)(const char* json, size_t len, void* opaque) = nullptr;
    void* test_emit_opaque = nullptr;
};

void mik__pub_fs_register(JSContext* ctx);
void mik__stdio_init(JSContext* ctx, JSValue ns);
void mik__sys_api_init(JSContext* ctx, JSValue ns);
void mik__text_encoding_init(JSContext* ctx, JSValue global);
void mik__abort_init(JSContext* ctx, JSValue global_obj);

JSValue mik_new_error(JSContext* ctx, int err);
JSValue mik_throw_errno(JSContext* ctx, int err);

void mik__execute_jobs(JSContext* ctx);
/* End-of-turn unhandled-rejection check; called after each microtask drain. */
void mik__flush_unhandled_rejections(JSContext* ctx);
/* Drop a promise from the pending-rejection queue without reporting it. */
void mik__forget_rejection(JSContext* ctx, JSValue promise);
JSModuleDef* mik__load_builtin(JSContext* ctx, const char* name);
int mik__load_file(JSContext* ctx, DynBuf* dbuf, const char* filename);
void mik__resolve_fs_path(JSContext* ctx, const char* module_name, char* out, size_t out_size);
int mik__resolve_fs_root(JSContext* ctx, const char* path, char* out, size_t out_size);
size_t mik__fs_dir_usage(const char* dir_path);
JSModuleDef* mik_module_loader(JSContext* ctx, const char* module_name, void* opaque);
char* mik_module_normalizer(JSContext* ctx, const char* base_name, const char* name, void* opaque);

/* Unload a module by its normalized name. Walks the mikrojs-side import
 * dependency graph, recursively unloading any transitive dependency
 * whose importer set becomes empty (builtin prefixes native:, mikrojs/,
 * @mikrojs/ are anchored and skipped). Safe to call only on
 * modules in JS_MODULE_STATUS_EVALUATED state; returns the number of
 * modules actually freed, or -1 with a JS exception on invalid,
 * mid-evaluation, or unknown modules. */
int mik__unload_module(JSContext* ctx, const char* normalized_name);

/* Unload the module whose namespace object is `ns` (reverse lookup via
 * JS_FindModuleByNamespace, then mik__unload_module by name). Returns the
 * number of modules freed, 0 if `ns` is not a currently-loaded module's
 * namespace, or -1 with a pending JS exception. Backs `disposable()`. */
int mik__unload_namespace(JSContext* ctx, JSValueConst ns);

/* True if `ns` is the namespace of a currently-loaded, non-anchored module
 * (i.e. one that disposable() is allowed to unload). */
bool mik__is_unloadable_namespace(JSContext* ctx, JSValueConst ns);

int js_module_set_import_meta(JSContext* ctx, JSValue func_val, bool use_realpath, bool is_main);

JSValue mik__get_args(JSContext* ctx);

int mik__eval_bytecode(JSContext* ctx, const uint8_t* buf, size_t buf_len, bool check_promise);


void mik__sab_free(void* opaque, void* ptr);
void mik__sab_dup(void* opaque, void* ptr);

MIKTimerRegistry* MIK_NewTimerRegistry(void);
MIKRuntime* MIK_NewRuntimeWorker(void);
MIKRuntime* MIK_NewRuntimeInternal(MIKRunOptions* options);
JSValue MIK_EvalScript(JSContext* ctx, const char* filename);
JSValue MIK_EvalModule(JSContext* ctx, const char* filename, bool is_main);
JSValue MIK_EvalModuleContent(JSContext* ctx, const char* filename, const char* content,
                              size_t len);


void mik__timers_init(JSContext* ctx, JSValue ns);
void mik__timers_consume(JSContext* ctx);
void mik__timers_destroy(JSContext* ctx);

void mik__stdin_consume(JSContext* ctx);

/* Console global (mik_console.cpp) */
void mik__console_init(JSContext* ctx, JSValue global_obj);
/* Reports an uncaught error/rejection. Dedups by error-object identity:
 * returns true if it reported, false if this same object was already
 * reported. */
bool mik__report_uncaught(JSContext* ctx, JSValue exc, bool in_promise = false);

/* Inspect (mik_inspect.cpp) */
std::string mik_inspect(JSContext* ctx, JSValue value, int depth = 2, bool colors = false,
                        bool show_hidden = false);
void mik__inspect_register(JSContext* ctx);

/* CBOR module (mik_cbor.cpp) */
JSModuleDef* mik__cbor_init(JSContext* ctx);

/* Result module (mik_result.cpp) */
JSModuleDef* mik__result_init(JSContext* ctx);

/* UDP module (mik_udp.cpp) */
JSModuleDef* mik__udp_init(JSContext* ctx);

/* Observable module (mik_observable.cpp) */
JSModuleDef* mik__observable_init(JSContext* ctx);

bool mik__repl_is_evaluating(void);

/* REPL protocol mode (mik_repl.cpp) — used by mik_console.cpp, mik_stdio.cpp */
bool mik__repl_is_protocol_mode(void);
void mik__repl_proto_send_output(uint8_t msg_type, const void* data, size_t len);

/* Suspend/resume MIK_Loop pumping (timers + loop consumers). Microtasks
 * still drain so in-flight promises can settle. Used by mik_deploy.cpp to
 * freeze user code while a deploy is streaming in. */
bool mik__repl_is_paused(void);
void mik__repl_set_paused(bool paused);

/* ── Unified MIK Protocol ───────────────────────────────────────── */
/* Frame format: [type: u8][length: u32le][payload: bytes]          */

/* Escape hatch: raw byte that triggers hard restart */
#define MIK_CTRL_R 0x12

/* Header size: 1 (type) + 4 (u32le length) */
#define MIK_PROTO_HEADER_SIZE 5

/* Device → CLI message types */
#define MIK_MSG_READY 0x01
#define MIK_MSG_LOG 0x02
#define MIK_MSG_WARN 0x03
#define MIK_MSG_ERROR 0x04
#define MIK_MSG_RESULT 0x05
#define MIK_MSG_INFO 0x06
#define MIK_MSG_COMPLETIONS 0x07
#define MIK_MSG_EVAL_ERROR 0x08
#define MIK_MSG_PROMPT 0x09
#define MIK_MSG_TEST 0x0B
#define MIK_MSG_DEBUG 0x0C
/* Emitted once after the last test file's run_done when the device drove
 * a supervisor-mode manifest. Signals "no more tests coming" to the CLI. */
#define MIK_MSG_MANIFEST_DONE 0x0D

#define MIK_MSG_OK 0x80
#define MIK_MSG_ERR 0x81
#define MIK_MSG_CHECKSUM_RESULT 0x82
#define MIK_MSG_CONFIG_ENTRIES 0x83
/* Chunk of file bytes streamed in response to MIK_CMD_FS_GET.
 * Multiple frames precede a final MSG_OK signaling end-of-file. */
#define MIK_MSG_FS_CHUNK 0x84

/* CLI → Device command types */
#define MIK_CMD_EVAL 0x10
#define MIK_CMD_COMPLETE 0x11
/* 0x12 reserved for CTRL_R hard-restart escape hatch */
#define MIK_CMD_DIRECTIVE 0x13
#define MIK_CMD_EXIT 0x14
#define MIK_CMD_HELLO 0x15

/* PUT opens the staged file and records the total size; the body arrives in
 * one or more PUT_CHUNK frames so a single TLV frame never exceeds the USJ
 * RX ring. PUT payload: u16le name_len | name | u32le total_size. */
#define MIK_CMD_DEPLOY_PUT 0x20
#define MIK_CMD_DEPLOY_DONE 0x21
#define MIK_CMD_DEPLOY_ABORT 0x22
#define MIK_CMD_DEPLOY_ERASE 0x23
/* PUT_CHUNK payload: file bytes (1..N). Appended to the file opened by the
 * preceding PUT; closed automatically when total_remaining reaches zero. */
#define MIK_CMD_DEPLOY_PUT_CHUNK 0x24
/* 0x25 formerly MIK_CMD_DEPLOY_ENV_CLEAR — no longer needed; deploy diffs env via CONFIG_DELETE */
#define MIK_CMD_DEPLOY_KEEP 0x26
#define MIK_CMD_DEPLOY_CHECKSUM 0x27
#define MIK_CMD_RESTART 0x28
#define MIK_CMD_RUNTIME_PAUSE 0x29
#define MIK_CMD_RUNTIME_RESUME 0x2A
/* Pull a file off the device. Payload: u16le path_len | path.
 * Device replies with zero-or-more MIK_MSG_FS_CHUNK frames followed by
 * MIK_MSG_OK on EOF, or MIK_MSG_ERR if the path can't be opened. */
#define MIK_CMD_FS_GET 0x2B
/* Clear the on-device log files (log.txt + log.txt.1). No payload.
 * Device suspends the logger, deletes both files, reopens a fresh
 * log.txt, and replies MIK_MSG_OK. No-op (still OK) when file logging
 * is disabled. */
#define MIK_CMD_LOG_RESET 0x2C

#define MIK_CMD_CONFIG_LIST 0x40
#define MIK_CMD_CONFIG_SET 0x41
#define MIK_CMD_CONFIG_DELETE 0x42

/* Env entry flags */
#define MIK_ENV_FLAG_SECRET 0x01



#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <vector>

#include <quickjs.h>

#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/* ── Printf-style format (port of format.ts) ────────────────────── */

static std::string mik__format(JSContext* ctx, int argc, JSValue* argv, bool colors) {
    if (argc == 0) return "";

    /* If first arg is not a string, just inspect all args */
    if (!JS_IsString(argv[0])) {
        std::string out;
        for (int i = 0; i < argc; i++) {
            if (i > 0) out += ", ";
            out += mik_inspect(ctx, argv[i], 2, colors);
        }
        return out;
    }

    const char* fmt = JS_ToCString(ctx, argv[0]);
    if (!fmt) return "";

    std::string result;
    int arg_idx = 1;  /* next arg to consume */

    for (const char* p = fmt; *p; p++) {
        if (*p != '%') {
            result += *p;
            continue;
        }

        /* Look at next char */
        char next = *(p + 1);
        if (next == '\0') {
            result += '%';
            break;
        }

        if (next == '%') {
            result += '%';
            p++;
            continue;
        }

        if (arg_idx >= argc) {
            /* No more args — keep the format specifier literal */
            result += '%';
            result += next;
            p++;
            continue;
        }

        switch (next) {
            case 's': {
                const char* s = JS_ToCString(ctx, argv[arg_idx]);
                if (s) {
                    result += s;
                    JS_FreeCString(ctx, s);
                }
                arg_idx++;
                p++;
                break;
            }
            case 'd': {
                const char* s = JS_ToCString(ctx, argv[arg_idx]);
                if (s) {
                    result += s;
                    JS_FreeCString(ctx, s);
                }
                arg_idx++;
                p++;
                break;
            }
            case 'f': {
                double d;
                JS_ToFloat64(ctx, &d, argv[arg_idx]);
                char buf[64];
                snprintf(buf, sizeof(buf), "%f", d);
                result += buf;
                arg_idx++;
                p++;
                break;
            }
            case 'o':
            case 'O': {
                result += mik_inspect(ctx, argv[arg_idx], 2, colors);
                arg_idx++;
                p++;
                break;
            }
            case 'c': {
                /* CSS colors not supported — consume arg, output nothing */
                arg_idx++;
                p++;
                break;
            }
            default:
                result += '%';
                result += next;
                p++;
                break;
        }
    }

    JS_FreeCString(ctx, fmt);

    /* Append remaining args */
    for (int i = arg_idx; i < argc; i++) {
        result += ' ';
        result += mik_inspect(ctx, argv[i], 2, colors);
    }

    return result;
}

/* ── Error formatting (port of console.ts formatError) ───────────── */

static std::string mik__format_error(JSContext* ctx, JSValue error) {
    JSValue stack_val = JS_GetPropertyStr(ctx, error, "stack");
    JSValue msg_val = JS_GetPropertyStr(ctx, error, "message");

    const char* stack = JS_ToCString(ctx, stack_val);
    const char* msg = JS_ToCString(ctx, msg_val);

    std::string result;
    if (stack && msg && strstr(stack, msg)) {
        /* Stack already includes message */
        result = stack;
    } else {
        JSValue name_val = JS_GetPropertyStr(ctx, error, "name");
        const char* name = JS_ToCString(ctx, name_val);
        result = name ? name : "Error";
        result += ": ";
        result += msg ? msg : "";
        if (stack) {
            result += "\n";
            result += stack;
        }
        if (name) JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, name_val);
    }

    if (stack) JS_FreeCString(ctx, stack);
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, stack_val);
    JS_FreeValue(ctx, msg_val);

    return result;
}

/* ── Console methods ─────────────────────────────────────────────── */

static JSValue mik__console_log(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    std::string output = mik__format(ctx, argc, argv, true);

    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(MIK_MSG_LOG, output.c_str(), output.size());
        return JS_UNDEFINED;
    }

    output += "\r\n";
    MIK_GetPlatform()->stdout_write(output.c_str(), output.size());
    fsync(fileno(stdout));
    return JS_UNDEFINED;
}

static JSValue mik__console_info(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    std::string output = mik__format(ctx, argc, argv, true);

    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(MIK_MSG_INFO, output.c_str(), output.size());
        return JS_UNDEFINED;
    }

    output += "\r\n";
    MIK_GetPlatform()->stdout_write(output.c_str(), output.size());
    fsync(fileno(stdout));
    return JS_UNDEFINED;
}

static JSValue mik__console_debug(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    std::string output = mik__format(ctx, argc, argv, true);

    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(MIK_MSG_DEBUG, output.c_str(), output.size());
        return JS_UNDEFINED;
    }

    output += "\r\n";
    MIK_GetPlatform()->stdout_write(output.c_str(), output.size());
    fsync(fileno(stdout));
    return JS_UNDEFINED;
}

static JSValue mik__console_error_warn(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                                       int magic) {
    uint8_t msg_type = magic == 0 ? MIK_MSG_ERROR : MIK_MSG_WARN;

    /* Map Error objects to their stack traces */
    std::vector<JSValue> mapped;
    mapped.reserve(argc);

    for (int i = 0; i < argc; i++) {
        if (JS_IsError(argv[i])) {
            std::string err_str = mik__format_error(ctx, argv[i]);
            mapped.push_back(JS_NewString(ctx, err_str.c_str()));
        } else {
            mapped.push_back(JS_DupValue(ctx, argv[i]));
        }
    }

    std::string output = mik__format(ctx, argc, mapped.data(), true);

    for (auto& v : mapped) {
        JS_FreeValue(ctx, v);
    }

    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(msg_type, output.c_str(), output.size());
        return JS_UNDEFINED;
    }

    output += "\r\n";
    MIK_GetPlatform()->stderr_write(output.c_str(), output.size());
    return JS_UNDEFINED;
}

/* ── Uncaught error reporting ─────────────────────────────────────── */

/* Dedup: the rejection tracker can fire multiple times for the same
 * error (e.g. inner Promise.reject + async wrapper rejection). Skip
 * if the same object pointer was just reported. */
static void* last_reported_ptr = nullptr;
static int64_t last_reported_time = 0;

void mik__report_uncaught_reset(void) {
    last_reported_ptr = nullptr;
}

void mik__report_uncaught(JSContext* ctx, JSValue exc, bool in_promise) {
    if (JS_IsObject(exc)) {
        void* ptr = JS_VALUE_GET_PTR(exc);
        int64_t now = MIK_GetPlatform()->get_boot_us();
        /* Deduplicate only within 1ms — the rejection tracker can fire
         * twice for the same error (inner + async wrapper) essentially
         * instantly, but a new error 1s later at a recycled address
         * must not be suppressed. */
        if (ptr == last_reported_ptr && (now - last_reported_time) < 1000) {
            return;
        }
        last_reported_ptr = ptr;
        last_reported_time = now;
    } else {
        last_reported_ptr = nullptr;
    }

    /* Fixed-size stack buffer so this function never allocates from the
     * C++ heap. Previously we used std::string + mik_inspect here; both
     * can throw std::bad_alloc under memory pressure, and with
     * CONFIG_COMPILER_CXX_EXCEPTIONS=n on ESP32 that turns into
     * abort() — masking the real OOM the reporter was trying to surface.
     * Messages longer than the buffer get truncated, which beats
     * aborting. */
    char buf[512];
    size_t pos = 0;
    auto append = [&](const char* s, size_t len) {
        if (pos >= sizeof(buf) - 1) return;
        size_t avail = sizeof(buf) - 1 - pos;
        size_t n = len < avail ? len : avail;
        memcpy(buf + pos, s, n);
        pos += n;
    };
    auto append_cstr = [&](const char* s) {
        if (s) append(s, strlen(s));
    };

    append_cstr(in_promise ? "Uncaught (in promise) " : "Uncaught ");

    if (JS_IsObject(exc)) {
        JSValue name_val = JS_GetPropertyStr(ctx, exc, "name");
        JSValue msg_val = JS_GetPropertyStr(ctx, exc, "message");
        const char* name = JS_ToCString(ctx, name_val);
        const char* emsg = JS_ToCString(ctx, msg_val);

        if (name && name[0]) {
            append_cstr(name);
            if (emsg && emsg[0]) {
                append_cstr(": ");
                append_cstr(emsg);
            }
        } else if (emsg && emsg[0]) {
            append_cstr(emsg);
        } else {
            append_cstr("[object]");
        }

        if (name) JS_FreeCString(ctx, name);
        if (emsg) JS_FreeCString(ctx, emsg);
        JS_FreeValue(ctx, name_val);
        JS_FreeValue(ctx, msg_val);

        JSValue stack_val = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsString(stack_val)) {
            const char* stack = JS_ToCString(ctx, stack_val);
            if (stack && stack[0]) {
                append_cstr("\n");
                append_cstr(stack);
            }
            if (stack) JS_FreeCString(ctx, stack);
        }
        JS_FreeValue(ctx, stack_val);
    } else {
        /* Describe primitive rejections by type without going through
         * mik_inspect (which allocates a std::string). */
        if (JS_IsNull(exc)) {
            append_cstr("null");
        } else if (JS_IsUndefined(exc)) {
            append_cstr("undefined");
        } else if (JS_IsBool(exc)) {
            append_cstr(JS_ToBool(ctx, exc) ? "true" : "false");
        } else if (JS_IsNumber(exc)) {
            double d = 0;
            JS_ToFloat64(ctx, &d, exc);
            char num[32];
            int n = snprintf(num, sizeof(num), "%g", d);
            if (n > 0) append(num, (size_t)n);
        } else if (JS_IsString(exc)) {
            const char* s = JS_ToCString(ctx, exc);
            if (s) {
                append_cstr(s);
                JS_FreeCString(ctx, s);
            }
        } else {
            append_cstr("[primitive]");
        }

        /* Primitive rejections lose the throw-site stack (the async
         * chain has already unwound). Attach current system-heap free
         * bytes so logs hint at whether this was an allocation failure
         * — QuickJS surfaces OOM as a null rejection when it can't
         * allocate an Error object for the real throw. */
        const MIKPlatform* plat = MIK_GetPlatform();
        if (plat && plat->get_free_system_mem) {
            char note[96];
            int n = snprintf(note, sizeof(note),
                             "\n  (primitive rejection, systemFree=%zuB at report time)",
                             plat->get_free_system_mem());
            if (n > 0) append(note, (size_t)n);
        }
    }

    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(MIK_MSG_ERROR, buf, pos);
        return;
    }

    append_cstr("\r\n");
    MIK_GetPlatform()->stderr_write(buf, pos);
}

/* ── Test emit ────────────────────────────────────────────────────── */

static JSValue mik__test_emit(JSContext* ctx, JSValue /*this_val*/, int argc, JSValue* argv) {
    if (argc < 1) return JS_UNDEFINED;
    size_t len;
    const char* str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!str) return JS_EXCEPTION;
    if (mik__repl_is_protocol_mode()) {
        mik__repl_proto_send_output(MIK_MSG_TEST, str, len);
    } else {
        /* Non-protocol mode (e.g. Node addon for the simulator): if the host
         * registered a handler via MIK_SetTestEmitHandler, route the payload
         * there. Without a handler, this is a no-op — same as before. */
        MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
        if (mik_rt && mik_rt->test_emit_fn) {
            mik_rt->test_emit_fn(str, len, mik_rt->test_emit_opaque);
        }
    }
    JS_FreeCString(ctx, str);
    return JS_UNDEFINED;
}

/* Signals the current ServeLoop to return so a supervisor driving multiple
 * test files through one transport session can tear down the runtime and
 * move to the next file. Called from the test runtime after emitting the
 * final run_done event. No-op when not running under a supervisor. */
static JSValue mik__test_file_done(JSContext* /*ctx*/, JSValue /*this_val*/, int /*argc*/,
                                   JSValue* /*argv*/) {
    MIK_ProtocolExit();
    return JS_UNDEFINED;
}

/* ── Init ────────────────────────────────────────────────────────── */

void mik__console_init(JSContext* ctx, JSValue global_obj) {
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, mik__console_log, "log", 0));
    JS_SetPropertyStr(ctx, console, "info", JS_NewCFunction(ctx, mik__console_info, "info", 0));
    JS_SetPropertyStr(ctx, console, "debug", JS_NewCFunction(ctx, mik__console_debug, "debug", 0));
    JS_SetPropertyStr(ctx, console, "warn",
                      JS_NewCFunctionMagic(ctx, mik__console_error_warn, "warn", 0,
                                           JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, console, "error",
                      JS_NewCFunctionMagic(ctx, mik__console_error_warn, "error", 0,
                                           JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, global_obj, "console", console);
}

/* Public: opt-in test helper installation. Skipped for ordinary runtimes so
 * they don't pay the cost of two JSCFunction allocations + global property
 * bindings they'll never use. The mikrojs/test built-in has a console.log
 * fallback for when these globals aren't present. */
void MIK_EnableTestHelpers(MIKRuntime* mik_rt) {
    JSContext* ctx = mik_rt->ctx;
    JSValue global_obj = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global_obj, "__testEmit",
                      JS_NewCFunction(ctx, mik__test_emit, "__testEmit", 1));
    JS_SetPropertyStr(ctx, global_obj, "__testFileDone",
                      JS_NewCFunction(ctx, mik__test_file_done, "__testFileDone", 0));
    JS_FreeValue(ctx, global_obj);
}

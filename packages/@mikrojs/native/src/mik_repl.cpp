#include <dirent.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <string>
#include <vector>

#include <nanocbor/nanocbor.h>

#include "mikrojs/cutils_wrap.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

static const char* TAG = "mik_repl";

/* ── REPL state ──────────────────────────────────────────────────── */

static bool repl_active = false;
static bool repl_evaluating = false;  /* true during eval */
static JSContext* repl_ctx = nullptr;
static MIKRuntime* repl_mik_rt = nullptr;
static int show_depth = 2;
static bool show_hidden = false;
static bool show_time = false;

/* ── Protocol mode state ─────────────────────────────────────────── */

static bool repl_protocol_mode = false;
static bool repl_paused = false;
static bool repl_async_skipped = false;  /* set when eval bails on paused async */
static MIKReplTransport* repl_transport = nullptr;
static uint8_t ready_buf[96];
static size_t ready_len = 0;

/* Transient flag: set by MIK_ProtocolExit to break the current ServeLoop
 * without closing the session. Distinct from repl_active (which signals
 * "session open"). Cleared at the top of each ServeLoop call. */
static bool s_exit_serve_loop = false;

bool mik__repl_is_protocol_mode(void) {
    return repl_protocol_mode && repl_active;
}

/* ── TLV frame helpers ───────────────────────────────────────────── */

/* Send a TLV-framed message: [ type: uint8 ] [ length: uint32_le ] [ payload ] */
void mik__proto_send(MIKReplTransport* transport, uint8_t type, const void* data,
                     size_t len) {
    uint8_t header[MIK_PROTO_HEADER_SIZE];
    header[0] = type;
    header[1] = (uint8_t)(len & 0xFF);
    header[2] = (uint8_t)((len >> 8) & 0xFF);
    header[3] = (uint8_t)((len >> 16) & 0xFF);
    header[4] = (uint8_t)((len >> 24) & 0xFF);
    transport->write(header, MIK_PROTO_HEADER_SIZE, transport->ctx);
    if (len > 0 && data) {
        transport->write(data, len, transport->ctx);
    }
}

void mik__proto_send_ok(MIKReplTransport* transport) {
    mik__proto_send(transport, MIK_MSG_OK, nullptr, 0);
}

void mik__proto_send_err(MIKReplTransport* transport, const char* msg) {
    mik__proto_send(transport, MIK_MSG_ERR, msg, strlen(msg));
}

/* Public wrapper used by mik_console.cpp and mik_stdio.cpp */
void mik__repl_proto_send_output(uint8_t msg_type, const void* data, size_t len) {
    if (repl_transport) {
        mik__proto_send(repl_transport, msg_type, data, len);
    }
}

/* Read exactly n bytes from transport, blocking with event loop pumping.
 * Returns false on transport EOF/error, when MIK_ProtocolExit() is
 * signalled from inside the pump (the supervisor's mechanism for ending
 * a test-file's serve loop after __testFileDone fires), or when MIK_Loop
 * reports the attached runtime has halted (e.g. an unhandled rejection
 * set stop_requested — a test that crashed mid-execution). */
bool mik__proto_read_exact(MIKReplTransport* transport, void* buf, size_t n) {
    const MIKPlatform* platform = MIK_GetPlatform();
    uint8_t* p = static_cast<uint8_t*>(buf);
    size_t total = 0;
    while (total < n) {
        int r = transport->read(p + total, n - total, transport->ctx);
        if (r > 0) {
            total += r;
        } else if (r == 0 || (r < 0 && errno != EAGAIN)) {
            return false;
        } else {
            if (repl_mik_rt && !repl_paused) {
                if (MIK_Loop(repl_mik_rt) != 0) {
                    /* Runtime halted (typically unhandled rejection sets
                     * stop_requested). Further pumping is a no-op, so
                     * exit the serve loop and let the caller swap in the
                     * next runtime — or restart, in non-supervisor mode. */
                    s_exit_serve_loop = true;
                    return false;
                }
            }
            if (repl_ctx) {
                mik__execute_jobs(repl_ctx);
            }
            /* A pumped job (e.g. the test runtime's __testFileDone) may
             * have signalled exit. Bail before yielding another time slice. */
            if (s_exit_serve_loop) return false;
            platform->yield();
        }
    }
    return true;
}

/* Discard n bytes from transport. */
bool mik__proto_drain(MIKReplTransport* transport, size_t n) {
    uint8_t buf[256];
    while (n > 0) {
        size_t chunk = n > sizeof(buf) ? sizeof(buf) : n;
        if (!mik__proto_read_exact(transport, buf, chunk)) return false;
        n -= chunk;
    }
    return true;
}

/* Read only the 5-byte TLV header. Returns false on EOF/error. */
static bool proto_read_header(MIKReplTransport* transport, uint8_t* out_type,
                              uint32_t* out_payload_len) {
    uint8_t header[MIK_PROTO_HEADER_SIZE];
    if (!mik__proto_read_exact(transport, header, MIK_PROTO_HEADER_SIZE)) {
        return false;
    }
    *out_type = header[0];
    *out_payload_len = (uint32_t)header[1] | ((uint32_t)header[2] << 8) |
                       ((uint32_t)header[3] << 16) | ((uint32_t)header[4] << 24);
    return true;
}

/* Read payload into a std::string (for small payloads like REPL commands). */
static bool proto_read_payload(MIKReplTransport* transport, uint32_t len,
                               std::string& out) {
    out.resize(len);
    if (len == 0) return true;
    return mik__proto_read_exact(transport, out.data(), len);
}


/* ── Const/let rewriting ─────────────────────────────────────────── */

/* Rewrite top-level const/let to var so re-declarations don't error */
static std::string repl_rewrite_const_let(const char* code) {
    std::string result;
    const char* p = code;
    bool at_line_start = true;

    while (*p) {
        if (at_line_start) {
            const char* start = p;
            while (*p == ' ' || *p == '\t') p++;

            if (strncmp(p, "const ", 6) == 0) {
                result.append(start, p - start);
                result.append("var ");
                p += 6;
                at_line_start = false;
                continue;
            }
            if (strncmp(p, "let ", 4) == 0) {
                result.append(start, p - start);
                result.append("var ");
                p += 4;
                at_line_start = false;
                continue;
            }
            p = start;
        }

        if (*p == '\n') {
            at_line_start = true;
        } else {
            at_line_start = false;
        }
        result.push_back(*p++);
    }
    return result;
}

/* ── Wrap object literals ────────────────────────────────────────── */

/* If the expression starts with '{' (ignoring whitespace), wrap in parens
 * to disambiguate from a block statement. */
static std::string repl_maybe_wrap_object(const std::string& code) {
    const char* p = code.c_str();
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p == '{') {
        return "(" + code + ")";
    }
    return code;
}

/* ── Eval and pump loop ──────────────────────────────────────────── */

/* Evaluate an expression, pump the event loop if it returns a promise,
 * and return the result. Caller must JS_FreeValue the return value. */
static JSValue repl_eval_and_pump(JSContext* ctx, const char* code, size_t len) {
    JSValue result = JS_Eval(ctx, code, len, "<repl>",
                             JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC |
                                 JS_EVAL_FLAG_BACKTRACE_BARRIER);

    if (JS_IsException(result)) {
        return result;
    }

    if (!JS_IsPromise(result)) {
        return result;
    }

    const MIKPlatform* platform = MIK_GetPlatform();

    for (;;) {
        JSPromiseStateEnum state = JS_PromiseState(ctx, result);
        if (state == JS_PROMISE_FULFILLED) {
            JSValue pr = JS_PromiseResult(ctx, result);
            JS_FreeValue(ctx, result);
            if (JS_IsObject(pr)) {
                JSValue value = JS_GetPropertyStr(ctx, pr, "value");
                JS_FreeValue(ctx, pr);
                return value;
            }
            return pr;
        }
        if (state == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, result);
            JS_FreeValue(ctx, result);
            JS_Throw(ctx, reason);
            return JS_EXCEPTION;
        }

        if (repl_paused) {
            repl_async_skipped = true;
            JS_FreeValue(ctx, result);
            return JS_UNDEFINED;
        }

        MIK_Loop(repl_mik_rt);
        mik__execute_jobs(ctx);
        platform->yield();
    }
}

/* ── Tab completion ──────────────────────────────────────────────── */

static constexpr int MAX_COMPLETIONS = 32;
static constexpr int MAX_COMPLETION_LEN = 128;

/* Scratch space for a single completion call. Lives on the caller's stack
 * (4 KB) so we don't pay for it in .bss — tab completion is synchronous and
 * rare, and the main task has 24 KB of stack to spare. */
struct CompletionBuf {
    char bufs[MAX_COMPLETIONS][MAX_COMPLETION_LEN];
    int count;
};

static void add_completion(CompletionBuf& cb, const char* str) {
    if (cb.count >= MAX_COMPLETIONS) return;
    strncpy(cb.bufs[cb.count], str, MAX_COMPLETION_LEN - 1);
    cb.bufs[cb.count][MAX_COMPLETION_LEN - 1] = '\0';
    cb.count++;
}

/* Walk prototype chains to collect property names for tab completion. */
static void completion_callback(CompletionBuf& cb, int argc, const char* const* argv) {
    cb.count = 0;

    if (!repl_ctx || argc == 0) return;

    const char* last_token = argv[argc - 1];

    /* Check for directive completion */
    if (argc == 1 && last_token[0] == '/') {
        static const char* directives[] = {"/help",   "/mem",    "/gc",     "/exit",
                                           "/ls",     "/cat",    "/rm",     "/time",
                                           "/depth",  "/hidden", "/df",     "/du",
                                           "/pause",  "/resume", "/info"};
        size_t tok_len = strlen(last_token);
        for (size_t i = 0; i < countof(directives); i++) {
            if (strncmp(directives[i], last_token, tok_len) == 0) {
                add_completion(cb, directives[i]);
            }
        }
        return;
    }

    /* Find the last "word" boundary within the token (after operators) */
    const char* word_start = last_token + strlen(last_token);
    while (word_start > last_token) {
        char c = *(word_start - 1);
        if (c == '(' || c == '[' || c == '{' || c == ',' || c == ';' || c == '!' || c == '=' ||
            c == '+' || c == '-' || c == '*' || c == '/' || c == '%' || c == '|' || c == '&' ||
            c == '<' || c == '>' || c == '~' || c == '^' || c == '?') {
            break;
        }
        word_start--;
    }

    /* Split "obj.prop.sub" into object part and partial property */
    std::string word(word_start, last_token + strlen(last_token));
    if (word.empty()) return;

    std::string obj_part;
    std::string prop_prefix;
    size_t last_dot = word.rfind('.');
    if (last_dot != std::string::npos) {
        obj_part = word.substr(0, last_dot);
        prop_prefix = word.substr(last_dot + 1);
    } else {
        /* Complete on globalThis properties */
        obj_part = "globalThis";
        prop_prefix = word;
    }

    /* Evaluate the object part to get a JSValue */
    JSValue obj = JS_Eval(repl_ctx, obj_part.c_str(), obj_part.size(), "<completion>",
                          JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(obj)) {
        JS_FreeValue(repl_ctx, JS_GetException(repl_ctx));
        return;
    }

    /* Build prefix: everything in the token before the word we're completing */
    std::string token_prefix(last_token, word_start);

    /* Walk the prototype chain and collect matching property names */
    JSValue cur = JS_DupValue(repl_ctx, obj);

    for (int depth = 0; depth < 10 && JS_IsObject(cur); depth++) {
        JSPropertyEnum* ptab = nullptr;
        uint32_t plen = 0;

        if (JS_GetOwnPropertyNames(repl_ctx, &ptab, &plen, cur,
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) == 0) {
            for (uint32_t i = 0; i < plen; i++) {
                const char* name = JS_AtomToCString(repl_ctx, ptab[i].atom);
                if (name) {
                    if (prop_prefix.empty() ||
                        strncmp(name, prop_prefix.c_str(), prop_prefix.size()) == 0) {
                        std::string completion;
                        if (last_dot != std::string::npos) {
                            completion = token_prefix + obj_part + "." + name;
                        } else {
                            completion = token_prefix + name;
                        }
                        add_completion(cb, completion.c_str());
                    }
                    JS_FreeCString(repl_ctx, name);
                }
                JS_FreeAtom(repl_ctx, ptab[i].atom);
            }
            js_free(repl_ctx, ptab);
        }

        JSValue proto = JS_GetPrototype(repl_ctx, cur);
        JS_FreeValue(repl_ctx, cur);
        cur = proto;
    }
    JS_FreeValue(repl_ctx, cur);
    JS_FreeValue(repl_ctx, obj);
}

/* ── Directives ──────────────────────────────────────────────────── */

/* snprintf-append helper for directive output buffer */
__attribute__((format(printf, 2, 3)))
static void dir_printf(std::string& out, const char* fmt, ...) {
    char buf[512];
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    if (n > 0) {
        out.append(buf, n < (int)sizeof(buf) ? n : (int)sizeof(buf) - 1);
    }
}

/* Returns true if the line was handled as a directive.
 * Output is written to `out`. */
static bool handle_directive_impl(JSContext* ctx, const char* line, std::string& out) {
    const MIKPlatform* platform = MIK_GetPlatform();

    if (line[0] != '/') return false;

    if (strcmp(line, "/help") == 0) {
        out.append(
            "/help      Show this help\n"
            "/mem       Show heap memory usage\n"
            "/gc        Run garbage collector\n"
            "/time      Toggle timing display\n"
            "/depth N   Set object inspection depth (default 2)\n"
            "/hidden    Toggle hidden property display\n"
            "/pause     Pause app (suspend timers/callbacks)\n"
            "/resume    Resume app\n"
            "/ls [DIR]  List directory contents\n"
            "/cat FILE  Print file contents\n"
            "/rm FILE   Remove a file\n"
            "/info      Show device and runtime info\n"
            "/df        Show filesystem free/total space\n"
            "/du [PATH] Show disk usage for path\n"
            "/exit      Exit REPL\n");
        return true;
    }

    if (strcmp(line, "/info") == 0) {
        /* Device info from transport (set by platform) */
        if (repl_transport && repl_transport->chip_name) {
            dir_printf(out, "Chip: %s\n", repl_transport->chip_name);
        }
        const char* dev_id = MIK_GetPlatform()->get_device_id();
        if (dev_id) {
            dir_printf(out, "Device ID: %s\n", dev_id);
        }

        /* Runtime uptime */
        int64_t uptime_us = platform->get_boot_us();
        double uptime_s = (double)uptime_us / 1000000.0;
        if (uptime_s < 60) {
            dir_printf(out, "Uptime: %.1fs\n", uptime_s);
        } else if (uptime_s < 3600) {
            dir_printf(out, "Uptime: %.1fm\n", uptime_s / 60.0);
        } else {
            dir_printf(out, "Uptime: %.1fh\n", uptime_s / 3600.0);
        }

        /* JS heap */
        JSMemoryUsage mem;
        JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);
        long limit = mem.malloc_limit > 0 ? (long)mem.malloc_limit : (long)mem.malloc_size;
        dir_printf(out, "JS heap: %ld / %ld bytes (%.1f%% used)\n", (long)mem.malloc_size, limit,
                   limit > 0 ? (double)mem.malloc_size / (double)limit * 100.0 : 0.0);

        /* System memory */
        size_t free_mem = platform->get_free_system_mem();
        size_t total_mem =
            platform->get_total_system_mem ? platform->get_total_system_mem() : 0;
        if (total_mem > 0) {
            size_t used_mem = total_mem > free_mem ? total_mem - free_mem : 0;
            dir_printf(out, "System heap: %lu / %lu bytes (%.1f%% used)\n",
                       (unsigned long)used_mem, (unsigned long)total_mem,
                       (double)used_mem / (double)total_mem * 100.0);
        } else if (free_mem > 0) {
            dir_printf(out, "System heap: %lu free\n", (unsigned long)free_mem);
        }

        /* Filesystem */
        size_t fs_total = 0, fs_used = 0;
        if (platform->get_fs_info("user", &fs_total, &fs_used)) {
            dir_printf(out, "Filesystem: %u / %u bytes (%.1f%% used)\n", (unsigned)fs_used,
                       (unsigned)fs_total,
                       fs_total > 0 ? (double)fs_used / (double)fs_total * 100.0 : 0.0);
        }

        return true;
    }

    if (strcmp(line, "/mem") == 0) {
        JSMemoryUsage mem;
        JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);
        size_t free_mem = platform->get_free_system_mem();
        size_t min_free = platform->get_min_free_system_mem();
        size_t total_mem = platform->get_total_system_mem();
        // JS allocations fail on whichever ceiling we hit first: QuickJS's
        // self-imposed malloc_limit (configured via mikro.config.ts
        // `memReserved`) or the actual system heap. Report the tighter of
        // the two so the number matches what you can actually spend.
        long qjs_free = mem.malloc_limit > 0
                            ? (long)mem.malloc_limit - (long)mem.malloc_size
                            : -1;
        long available = qjs_free;
        if (free_mem > 0 && (available < 0 || (long)free_mem < available)) {
            available = (long)free_mem;
        }
        if (available >= 0) {
            dir_printf(out, "Available: %.1f KB\n\n", available / 1024.0);
        }
        dir_printf(out, "Usage:\n");
        if (mem.malloc_limit > 0) {
            double pct = (double)mem.malloc_size / (double)mem.malloc_limit * 100.0;
            dir_printf(out, "  QuickJS: %5.1f / %5.1f KB used   (%.0f%%)\n",
                       mem.malloc_size / 1024.0, mem.malloc_limit / 1024.0, pct);
        } else {
            dir_printf(out, "  QuickJS: %.1f KB used (no limit)\n", mem.malloc_size / 1024.0);
        }
        if (free_mem > 0 && total_mem > 0) {
            size_t used_mem = total_mem - free_mem;
            size_t peak_used = total_mem - min_free;
            double pct = (double)used_mem / (double)total_mem * 100.0;
            double peak_pct = (double)peak_used / (double)total_mem * 100.0;
            dir_printf(out, "  System:  %5.1f / %5.1f KB used   (%.0f%%, peak %.0f%%)\n",
                       used_mem / 1024.0, total_mem / 1024.0, pct, peak_pct);
        } else if (free_mem > 0) {
            dir_printf(out, "  System:  %.1f KB free (min seen: %.1f KB)\n", free_mem / 1024.0,
                       min_free / 1024.0);
        }
        // Reserved is the chunk of system heap intentionally kept out of
        // QuickJS's reach via `memReserved` in mikro.config.ts, so native
        // subsystems (WiFi/lwIP/TLS/HTTP) have room to breathe. Showing it
        // makes the QuickJS limit explainable: limit ≈ free_heap_at_init −
        // reserved.
        MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
        if (mik_rt != NULL && mik_rt->config.mem_reserved > 0) {
            dir_printf(out, "  Reserved: %.1f KB (memReserved for native subsystems)\n",
                       mik_rt->config.mem_reserved / 1024.0);
        }
        return true;
    }

    if (strcmp(line, "/gc") == 0) {
        JSMemoryUsage before;
        JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &before);
        JS_RunGC(JS_GetRuntime(ctx));
        JSMemoryUsage after;
        JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &after);
        long freed = (long)before.malloc_size - (long)after.malloc_size;
        dir_printf(out, "GC collected %ld bytes (%ld -> %ld)\n", freed,
                   (long)before.malloc_size, (long)after.malloc_size);
        return true;
    }

    if (strcmp(line, "/time") == 0) {
        show_time = !show_time;
        dir_printf(out, "Timing %s\n", show_time ? "on" : "off");
        return true;
    }

    if (strncmp(line, "/depth", 6) == 0) {
        const char* arg = line + 6;
        while (*arg == ' ') arg++;
        if (*arg) {
            int d = atoi(arg);
            if (d >= 0) {
                show_depth = d;
                dir_printf(out, "Depth set to %d\n", show_depth);
            }
        } else {
            dir_printf(out, "Current depth: %d\n", show_depth);
        }
        return true;
    }

    if (strcmp(line, "/hidden") == 0) {
        show_hidden = !show_hidden;
        dir_printf(out, "Show hidden properties: %s\n", show_hidden ? "on" : "off");
        return true;
    }

    if (strcmp(line, "/pause") == 0) {
        if (repl_paused) {
            out.append("App is already paused\n");
        } else {
            repl_paused = true;
            out.append("App paused (timers, callbacks suspended). Use /resume to continue.\n");
        }
        return true;
    }

    if (strcmp(line, "/resume") == 0) {
        if (!repl_paused) {
            out.append("App is not paused\n");
        } else {
            repl_paused = false;
            out.append("App resumed\n");
        }
        return true;
    }

    if (strcmp(line, "/df") == 0) {
        size_t total = 0, used = 0;
        if (platform->get_fs_info("user", &total, &used)) {
            size_t free_bytes = total - used;
            dir_printf(out, "Filesystem: %u / %u bytes used (%.1f%%), %u bytes free\n",
                       (unsigned)used, (unsigned)total,
                       total > 0 ? (double)used / (double)total * 100.0 : 0.0,
                       (unsigned)free_bytes);
        } else {
            const char* root = repl_mik_rt->fs_root ? repl_mik_rt->fs_root
                                                     : repl_mik_rt->fs_base_path;
            if (root) {
                size_t fs_used = mik__fs_dir_usage(root);
                size_t fs_total = repl_mik_rt->fs_limit > 0 ? repl_mik_rt->fs_limit : fs_used;
                size_t fs_free = fs_total > fs_used ? fs_total - fs_used : 0;
                dir_printf(out, "Filesystem: %lu / %lu bytes used (%.1f%%), %lu bytes free\n",
                           (unsigned long)fs_used, (unsigned long)fs_total,
                           fs_total > 0 ? (double)fs_used / (double)fs_total * 100.0 : 0.0,
                           (unsigned long)fs_free);
            } else {
                dir_printf(out, "Cannot get filesystem info\n");
            }
        }
        return true;
    }

    if (strncmp(line, "/du", 3) == 0 && (line[3] == '\0' || line[3] == ' ')) {
        const char* arg = line + 3;
        while (*arg == ' ') arg++;

        /* Default to root "/" if no arg */
        char dirname[PATH_MAX];
        if (arg[0] == '\0') {
            snprintf(dirname, sizeof(dirname), "/");
        } else if (arg[0] != '/') {
            snprintf(dirname, sizeof(dirname), "/%s", arg);
        } else {
            snprintf(dirname, sizeof(dirname), "%s", arg);
        }

        char path[PATH_MAX];
        if (mik__resolve_fs_root(repl_ctx, dirname, path, sizeof(path)) < 0) {
            dir_printf(out, "Permission denied: '%s'\n", arg[0] ? arg : "/");
            return true;
        }

        /* Stat single file or recurse directory */
        struct stat st;
        if (stat(path, &st) != 0) {
            dir_printf(out, "Cannot stat '%s': %s\n", arg[0] ? arg : "/", strerror(errno));
            return true;
        }

        if (!S_ISDIR(st.st_mode)) {
            dir_printf(out, "  %ld\t%s\n", (long)st.st_size, dirname);
            return true;
        }

        /* Recursive directory walk */
        long dir_total = 0;
        DIR* dir = opendir(path);
        if (!dir) {
            dir_printf(out, "Cannot open '%s': %s\n", arg[0] ? arg : "/", strerror(errno));
            return true;
        }
        const char* trailing = (dirname[strlen(dirname) - 1] == '/') ? "" : "/";
        struct dirent* entry;
        while ((entry = readdir(dir)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
            char child_path[PATH_MAX];
            snprintf(child_path, sizeof(child_path), "%s/%s", path, entry->d_name);
            struct stat child_st;
            if (stat(child_path, &child_st) == 0 && S_ISREG(child_st.st_mode)) {
                dir_printf(out, "  %ld\t%s%s%s\n", (long)child_st.st_size, dirname, trailing,
                           entry->d_name);
                dir_total += child_st.st_size;
            }
        }
        closedir(dir);
        dir_printf(out, "  %ld\ttotal\n", dir_total);
        return true;
    }

    if (strncmp(line, "/cat ", 5) == 0) {
        const char* arg = line + 5;
        while (*arg == ' ') arg++;

        /* Ensure path starts with / for resolve */
        char filename[PATH_MAX];
        if (arg[0] != '/') {
            snprintf(filename, sizeof(filename), "/%s", arg);
        } else {
            snprintf(filename, sizeof(filename), "%s", arg);
        }

        char path[PATH_MAX];
        if (mik__resolve_fs_root(repl_ctx, filename, path, sizeof(path)) < 0) {
            dir_printf(out, "Permission denied: '%s'\n", arg);
            return true;
        }

        struct stat cat_st;
        if (stat(path, &cat_st) != 0) {
            dir_printf(out, "Cannot open '%s': %s\n", arg, strerror(errno));
            return true;
        }

        FILE* f = fopen(path, "r");
        if (!f) {
            dir_printf(out, "Cannot open '%s': %s\n", arg, strerror(errno));
            return true;
        }
        char buf[256];
        size_t text_len = 0;
        while (fgets(buf, sizeof(buf), f)) {
            out.append(buf);
            text_len += strlen(buf);
        }
        fclose(f);
        if (text_len == 0 && cat_st.st_size > 0) {
            dir_printf(out, "(binary, size: %ld)\n", (long)cat_st.st_size);
        } else {
            out.append("\n");
        }
        return true;
    }

    if (strncmp(line, "/rm ", 4) == 0) {
        const char* arg = line + 4;
        while (*arg == ' ') arg++;

        if (*arg == '\0') {
            out.append("Usage: /rm FILE\n");
            return true;
        }

        /* Ensure path starts with / for resolve */
        char filename[PATH_MAX];
        if (arg[0] != '/') {
            snprintf(filename, sizeof(filename), "/%s", arg);
        } else {
            snprintf(filename, sizeof(filename), "%s", arg);
        }

        char path[PATH_MAX];
        if (mik__resolve_fs_root(repl_ctx, filename, path, sizeof(path)) < 0) {
            dir_printf(out, "Permission denied: '%s'\n", arg);
            return true;
        }

        if (remove(path) != 0) {
            dir_printf(out, "Cannot remove '%s': %s\n", arg, strerror(errno));
            return true;
        }

        dir_printf(out, "Removed '%s'\n", arg);
        return true;
    }

    if (strncmp(line, "/ls", 3) == 0 && (line[3] == '\0' || line[3] == ' ')) {
        const char* arg = line + 3;
        while (*arg == ' ') arg++;

        /* Default to root "/" if no arg */
        char dirname[PATH_MAX];
        if (arg[0] == '\0') {
            snprintf(dirname, sizeof(dirname), "/");
        } else if (arg[0] != '/') {
            snprintf(dirname, sizeof(dirname), "/%s", arg);
        } else {
            snprintf(dirname, sizeof(dirname), "%s", arg);
        }

        char path[PATH_MAX];
        if (mik__resolve_fs_root(repl_ctx, dirname, path, sizeof(path)) < 0) {
            dir_printf(out, "Permission denied: '%s'\n", arg[0] ? arg : "/");
            return true;
        }

        DIR* dir = opendir(path);
        if (!dir) {
            dir_printf(out, "Cannot open '%s': %s\n", arg[0] ? arg : "/", strerror(errno));
            return true;
        }
        const char* trailing = (dirname[strlen(dirname) - 1] == '/') ? "" : "/";
        struct dirent* entry;
        while ((entry = readdir(dir)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
            char child_path[PATH_MAX];
            snprintf(child_path, sizeof(child_path), "%s/%s", path, entry->d_name);
            DIR* child = opendir(child_path);
            if (child) {
                closedir(child);
                dir_printf(out, "  %s%s%s/\n", dirname, trailing, entry->d_name);
            } else {
                dir_printf(out, "  %s%s%s\n", dirname, trailing, entry->d_name);
            }
        }
        closedir(dir);
        return true;
    }

    if (strcmp(line, "/exit") == 0) {
        repl_active = false;
        return true;
    }

    dir_printf(out, "Unknown command: %s (try /help)\n", line);
    return true;
}

/* ── Public API ──────────────────────────────────────────────────── */

bool MIK_IsReplActive(void) {
    return repl_active;
}

bool mik__repl_is_evaluating(void) {
    return repl_evaluating;
}

bool mik__repl_is_paused(void) {
    return repl_paused;
}

void mik__repl_set_paused(bool paused) {
    repl_paused = paused;
}

/* ── Protocol completions helper ─────────────────────────────────── */

/* Build CBOR completion response from a partial expression.
 * Uses the same property-walking logic as completion_callback. */
static std::vector<uint8_t> proto_complete(JSContext* ctx, const char* partial, size_t len) {
    CompletionBuf cb{};
    const char* argv[1] = {partial};
    completion_callback(cb, 1, argv);

    /* Two-pass CBOR encode: {"prefix": tstr, "items": [tstr, ...]} */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    nanocbor_fmt_map(&enc, 2);
    nanocbor_put_tstr(&enc, "prefix");
    nanocbor_put_tstrn(&enc, partial, len);
    nanocbor_put_tstr(&enc, "items");
    nanocbor_fmt_array(&enc, cb.count);
    for (int i = 0; i < cb.count; i++) {
        nanocbor_put_tstr(&enc, cb.bufs[i]);
    }
    size_t needed = nanocbor_encoded_len(&enc);

    std::vector<uint8_t> buf(needed);
    nanocbor_encoder_init(&enc, buf.data(), needed);
    nanocbor_fmt_map(&enc, 2);
    nanocbor_put_tstr(&enc, "prefix");
    nanocbor_put_tstrn(&enc, partial, len);
    nanocbor_put_tstr(&enc, "items");
    nanocbor_fmt_array(&enc, cb.count);
    for (int i = 0; i < cb.count; i++) {
        nanocbor_put_tstr(&enc, cb.bufs[i]);
    }
    return buf;
}

/* ── Protocol-mode REPL ──────────────────────────────────────────── */

void MIK_ProtocolOpen(MIKReplTransport* transport) {
    if (repl_active) return;

    repl_transport = transport;
    repl_protocol_mode = true;
    repl_paused = false;
    repl_active = true;
    show_depth = 2;
    show_hidden = false;
    show_time = false;

    /* Build MSG_READY with CBOR device info: {"chip": tstr, "id": tstr, "v": tstr}.
     * Cached here and only emitted in response to a client CMD_HELLO so a
     * passive serial viewer (e.g. idf.py monitor) doesn't see the device
     * spamming its identity unprompted. */
    {
        const char* chip = transport->chip_name ? transport->chip_name : "unknown";
        const char* id = MIK_GetPlatform()->get_device_id();
        if (!id) id = "";
        const char* version =
#ifdef MIK_FW_VERSION
            MIK_FW_VERSION;
#else
            "0.0.0-dev";
#endif

        nanocbor_encoder_t enc;
        nanocbor_encoder_init(&enc, nullptr, 0);
        nanocbor_fmt_map(&enc, 3);
        nanocbor_put_tstr(&enc, "chip");
        nanocbor_put_tstr(&enc, chip);
        nanocbor_put_tstr(&enc, "id");
        nanocbor_put_tstr(&enc, id);
        nanocbor_put_tstr(&enc, "v");
        nanocbor_put_tstr(&enc, version);
        ready_len = nanocbor_encoded_len(&enc);

        nanocbor_encoder_init(&enc, ready_buf, sizeof(ready_buf));
        nanocbor_fmt_map(&enc, 3);
        nanocbor_put_tstr(&enc, "chip");
        nanocbor_put_tstr(&enc, chip);
        nanocbor_put_tstr(&enc, "id");
        nanocbor_put_tstr(&enc, id);
        nanocbor_put_tstr(&enc, "v");
        nanocbor_put_tstr(&enc, version);
    }
}

void MIK_ProtocolAttach(MIKRuntime* mik_rt) {
    if (!mik_rt) return;
    repl_ctx = MIK_GetJSContext(mik_rt);
    repl_mik_rt = mik_rt;
}

void MIK_ProtocolDetach(void) {
    repl_ctx = nullptr;
    repl_mik_rt = nullptr;
}

void MIK_ProtocolExit(void) { s_exit_serve_loop = true; }

void MIK_ProtocolClose(void) {
    if (repl_transport && repl_transport->session_end) {
        repl_transport->session_end(repl_transport->session_end_ctx);
    }
    repl_active = false;
    repl_protocol_mode = false;
    repl_paused = false;
    repl_transport = nullptr;
    repl_ctx = nullptr;
    repl_mik_rt = nullptr;
    s_exit_serve_loop = false;
    MIK_GetPlatform()->log(MIK_LOG_INFO, TAG, "Protocol REPL exited");
}

void MIK_ProtocolServeLoop(void) {
    if (!repl_active || !repl_transport) return;

    MIKReplTransport* transport = repl_transport;
    const MIKPlatform* platform = MIK_GetPlatform();
    s_exit_serve_loop = false;

    while (repl_active && !s_exit_serve_loop) {
        uint8_t cmd_type;
        uint32_t payload_len;

        /* Read the next command header. mik__proto_read_exact pumps the
         * runtime event loop while waiting, and bails on MIK_ProtocolExit
         * so a supervisor ending the per-test serve loop (via
         * __testFileDone) returns promptly instead of waiting for a CLI
         * command the CLI isn't going to send. */
        if (!proto_read_header(transport, &cmd_type, &payload_len)) {
            break;
        }

        JSContext* ctx = repl_ctx;

        /* REPL commands: read full payload (small), handle internally */
        if (cmd_type >= MIK_CMD_EVAL && cmd_type <= MIK_CMD_HELLO) {
            std::string payload;
            if (!proto_read_payload(transport, payload_len, payload)) {
                break;
            }

            switch (cmd_type) {
            case MIK_CMD_EVAL: {
                /* Rewrite const/let -> var, wrap object literals */
                std::string code = repl_rewrite_const_let(payload.c_str());
                code = repl_maybe_wrap_object(code);

                int64_t t0 = 0;
                if (show_time) {
                    t0 = platform->get_boot_us();
                }

                repl_evaluating = true;
                repl_async_skipped = false;
                JSValue result = repl_eval_and_pump(ctx, code.c_str(), code.size());
                repl_evaluating = false;

                if (repl_async_skipped) {
                    static const char info[] = "Promise detached (app is paused)";
                    mik__proto_send(transport, MIK_MSG_INFO, info, sizeof(info) - 1);
                    repl_async_skipped = false;
                }

                if (JS_IsException(result)) {
                    JSValue exc = JS_GetException(ctx);

                    /* Format the error */
                    std::string msg = "Uncaught ";
                    if (JS_IsObject(exc)) {
                        JSValue name_val = JS_GetPropertyStr(ctx, exc, "name");
                        JSValue msg_val = JS_GetPropertyStr(ctx, exc, "message");
                        const char* name = JS_ToCString(ctx, name_val);
                        const char* emsg = JS_ToCString(ctx, msg_val);

                        if (name && name[0]) {
                            msg += name;
                            if (emsg && emsg[0]) {
                                msg += ": ";
                                msg += emsg;
                            }
                        } else if (emsg && emsg[0]) {
                            msg += emsg;
                        } else {
                            msg += mik_inspect(ctx, exc);
                        }

                        if (name) JS_FreeCString(ctx, name);
                        if (emsg) JS_FreeCString(ctx, emsg);
                        JS_FreeValue(ctx, name_val);
                        JS_FreeValue(ctx, msg_val);

                        JSValue stack_val = JS_GetPropertyStr(ctx, exc, "stack");
                        if (JS_IsString(stack_val)) {
                            const char* stack = JS_ToCString(ctx, stack_val);
                            if (stack && stack[0]) {
                                msg += "\n";
                                msg += stack;
                            }
                            if (stack) JS_FreeCString(ctx, stack);
                        }
                        JS_FreeValue(ctx, stack_val);
                    } else {
                        msg += mik_inspect(ctx, exc);
                    }

                    JS_FreeValue(ctx, exc);

                    /* Send timing before error so CLI can attach it to the input echo */
                    if (show_time) {
                        int64_t elapsed = platform->get_boot_us() - t0;
                        char timing[64];
                        int tlen =
                            snprintf(timing, sizeof(timing), "%.1fms", (double)elapsed / 1000.0);
                        mik__proto_send(transport, MIK_MSG_PROMPT, timing, tlen);
                    }

                    mik__proto_send(transport, MIK_MSG_EVAL_ERROR, msg.c_str(), msg.size());
                } else if (!JS_IsUndefined(result)) {
                    std::string inspected = mik_inspect(ctx, result, show_depth, false, show_hidden);

                    /* Set globalThis._ = result */
                    JSValue global = JS_GetGlobalObject(ctx);
                    JS_SetPropertyStr(ctx, global, "_", JS_DupValue(ctx, result));
                    JS_FreeValue(ctx, global);

                    /* Send timing before result so CLI can attach it to the input echo */
                    if (show_time) {
                        int64_t elapsed = platform->get_boot_us() - t0;
                        char timing[64];
                        int tlen =
                            snprintf(timing, sizeof(timing), "%.1fms", (double)elapsed / 1000.0);
                        mik__proto_send(transport, MIK_MSG_PROMPT, timing, tlen);
                    }

                    mik__proto_send(transport, MIK_MSG_RESULT, inspected.c_str(),
                                    inspected.size());
                } else {
                    /* Send timing before empty result */
                    if (show_time) {
                        int64_t elapsed = platform->get_boot_us() - t0;
                        char timing[64];
                        int tlen =
                            snprintf(timing, sizeof(timing), "%.1fms", (double)elapsed / 1000.0);
                        mik__proto_send(transport, MIK_MSG_PROMPT, timing, tlen);
                    }

                    /* undefined result — send empty result so CLI knows eval finished */
                    mik__proto_send(transport, MIK_MSG_RESULT, nullptr, 0);
                }

                JS_FreeValue(ctx, result);

                /* Run GC and report reclaimed bytes */
                JSMemoryUsage gc_before;
                JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &gc_before);
                JS_RunGC(JS_GetRuntime(ctx));
                JSMemoryUsage gc_after;
                JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &gc_after);
                long gc_freed = (long)gc_before.malloc_size - (long)gc_after.malloc_size;
                if (gc_freed > 0) {
                    size_t free_mem = platform->get_free_system_mem();
                    char gc_info[128];
                    int gc_len = snprintf(gc_info, sizeof(gc_info),
                                          "GC reclaimed %ld bytes (%lu bytes free)", gc_freed,
                                          (unsigned long)free_mem);
                    mik__proto_send(transport, MIK_MSG_INFO, gc_info, gc_len);
                }
                break;
            }

            case MIK_CMD_COMPLETE: {
                auto cbor = proto_complete(ctx, payload.c_str(), payload.size());
                mik__proto_send(transport, MIK_MSG_COMPLETIONS, cbor.data(), cbor.size());
                break;
            }

            case MIK_CMD_DIRECTIVE: {
                std::string out;
                handle_directive_impl(ctx, payload.c_str(), out);
                mik__proto_send(transport, MIK_MSG_INFO, out.c_str(), out.size());
                break;
            }

            case MIK_CMD_EXIT:
                repl_active = false;
                break;

            case MIK_CMD_HELLO:
                /* Client-initiated handshake: reply with cached MSG_READY. */
                mik__proto_send(transport, MIK_MSG_READY, ready_buf, ready_len);
                break;
            }
        } else {
            /* Non-REPL command: forward to platform handler with unread payload.
             * The handler reads payload bytes directly from the transport. */
            if (transport->command_handler) {
                transport->command_handler(transport, cmd_type, payload_len,
                                          transport->command_handler_ctx);
            } else {
                /* No handler: drain the payload to stay in sync */
                mik__proto_drain(transport, payload_len);
            }
        }

        /* Pump event loop between commands (skip timers/callbacks when paused,
         * but always run microtasks so promises can settle) */
        if (repl_mik_rt && !repl_paused) {
            MIK_Loop(repl_mik_rt);
        }
        if (ctx) {
            mik__execute_jobs(ctx);
        }
    }
}


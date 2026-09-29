/* mikro/test: the on-device test runner. Every hook and test settles through
 * Promise.resolve(v).then(ok, err), so the C stack stays flat across a file. */

#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <mikrojs/utils.h>
#include <quickjs.h>

namespace {

enum : int { F_SKIP = 1, F_ONLY = 2, F_TODO = 4, F_FIXME = 8 };

/* Steps a promise reaction (or the timeout timer) can advance the run to. */
enum Step : int {
    STEP_RUN,
    STEP_BEFORE_ALL_OK,
    STEP_BEFORE_ALL_ERR,
    STEP_BASELINE,
    STEP_HOOK_OK,
    STEP_TEST_OK,
    STEP_TEST_ERR,
    STEP_TIMEOUT,
    STEP_AFTER_EACH,
    STEP_AFTER_ALL,
};

enum Phase : int { PH_SUITE_BEGIN, PH_TESTS, PH_SUITE_FINISH, PH_DONE };

constexpr int64_t DEFAULT_TEST_TIMEOUT_MS = 10000;

struct TestCase {
    std::string name;
    JSValue fn;
    bool skip;
    bool only;
    bool todo;
    int64_t timeout_ms;
};

struct Suite {
    std::string name;
    std::vector<TestCase> tests;
    bool skip;
    bool only;
    bool todo;
    JSValue before_all;
    JSValue after_all;
    std::vector<JSValue> before_each;
    std::vector<JSValue> after_each;
};

struct Registry {
    std::vector<Suite> suites;
    int current = -1; /* suite index describe() is filling, -1 outside */
    JSValue promise_ctor = JS_UNDEFINED;

    /* Run state. Suites and tests are addressed by index: a JS call may
     * append to `suites`, so references are never held across one. */
    Phase phase = PH_SUITE_BEGIN;
    size_t si = 0;
    size_t ti = 0;
    size_t hook_i = 0;
    uint32_t seq = 0; /* bumped per started test; stale callbacks compare it */
    bool test_settled = false;
    /* True while the 0 ms start timer's callback is on the stack: that timer
     * is still registered then and must not count as the file's. */
    bool in_start = false;
    uint32_t timeout_timer = 0;
    int passed = 0;
    int failed = 0;
    int skipped = 0;
    int todo = 0;
    int64_t start_us = 0;
    int64_t test_start_us = 0;
    /* JS heap: the file's retention is summed over suites, each measured
     * against its own baseline (the previous suite's closing heap, or the
     * heap after its beforeAll so warmup is excluded). */
    int64_t start_heap = 0;
    int64_t suite_baseline = 0;
    int64_t heap_retained = 0;
    /* System heap (0 on hosts without one): the run's start and lowest
     * post-gc sample give the file's peak; never rebaselined, since memory a
     * beforeAll takes is memory the file needed at once. */
    int64_t sys_free_start = 0;
    int64_t sys_free_floor = 0;
    int64_t suite_free_start = 0;
    int64_t suite_free_floor = 0;
    int32_t timers_before = 0;
    int32_t pending_before = 0;
    bool has_only = false;
    bool only_in_suite = false;
};

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables)
JSClassID registry_class_id = 0;

Registry* reg_of(JSValueConst obj) {
    return static_cast<Registry*>(JS_GetOpaque(obj, registry_class_id));
}

void registry_finalizer(JSRuntime* rt, JSValue val) {
    auto* reg = reg_of(val);
    if (!reg) return;
    JS_FreeValueRT(rt, reg->promise_ctor);
    for (auto& s : reg->suites) {
        JS_FreeValueRT(rt, s.before_all);
        JS_FreeValueRT(rt, s.after_all);
        for (auto& h : s.before_each) JS_FreeValueRT(rt, h);
        for (auto& h : s.after_each) JS_FreeValueRT(rt, h);
        for (auto& t : s.tests) JS_FreeValueRT(rt, t.fn);
    }
    delete reg;
}

void registry_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* reg = reg_of(val);
    if (!reg) return;
    JS_MarkValue(rt, reg->promise_ctor, mark_func);
    for (auto& s : reg->suites) {
        JS_MarkValue(rt, s.before_all, mark_func);
        JS_MarkValue(rt, s.after_all, mark_func);
        for (auto& h : s.before_each) JS_MarkValue(rt, h, mark_func);
        for (auto& h : s.after_each) JS_MarkValue(rt, h, mark_func);
        for (auto& t : s.tests) JS_MarkValue(rt, t.fn, mark_func);
    }
}

JSClassDef registry_class_def = {
    "TestRegistry", registry_finalizer, registry_gc_mark, nullptr, nullptr,
};

/* ── Small helpers ──────────────────────────────────────────────── */

void drop_exception(JSContext* ctx) {
    JSValue e = JS_GetException(ctx);
    JS_FreeValue(ctx, e);
}

/* String(v). False (exception pending) when the conversion throws. */
bool to_string(JSContext* ctx, JSValueConst v, std::string& out) {
    size_t len;
    const char* s = JS_ToCStringLen(ctx, &len, v);
    if (!s) return false;
    out.assign(s, len);
    JS_FreeCString(ctx, s);
    return true;
}

/* JSON.stringify(v): "undefined" for an undefined result, String(v) when
 * stringify throws (a cyclic value). */
std::string json_or_string(JSContext* ctx, JSValueConst v) {
    JSValue json = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    std::string out;
    if (JS_IsException(json)) {
        drop_exception(ctx);
        if (!to_string(ctx, v, out)) {
            drop_exception(ctx);
            out = "undefined";
        }
        return out;
    }
    if (JS_IsUndefined(json)) return "undefined";
    if (!to_string(ctx, json, out)) drop_exception(ctx);
    JS_FreeValue(ctx, json);
    return out;
}

const char* js_typeof(JSContext* ctx, JSValueConst v) {
    if (JS_IsUndefined(v)) return "undefined";
    if (JS_IsNull(v)) return "object";
    if (JS_IsBool(v)) return "boolean";
    if (JS_IsNumber(v)) return "number";
    if (JS_IsBigInt(v)) return "bigint";
    if (JS_IsString(v)) return "string";
    if (JS_IsSymbol(v)) return "symbol";
    if (JS_IsFunction(ctx, v)) return "function";
    return "object";
}

/* The runner's failure text for a thrown value: Error.message, "name:
 * message" for Result-style error shapes, else String(e). */
std::string format_thrown(JSContext* ctx, JSValueConst e) {
    const MIKResultAtoms& atoms = MIK_GetRuntime(ctx)->result_atoms;
    std::string out;
    if (JS_IsError(e)) {
        JSValue msg = JS_GetProperty(ctx, e, atoms.message);
        if (!to_string(ctx, msg, out)) drop_exception(ctx);
        JS_FreeValue(ctx, msg);
        return out;
    }
    if (JS_IsObject(e)) {
        JSValue name_v = JS_GetProperty(ctx, e, atoms.name);
        if (JS_IsException(name_v)) drop_exception(ctx);
        JSValue msg_v = JS_GetProperty(ctx, e, atoms.message);
        if (JS_IsException(msg_v)) drop_exception(ctx);
        std::string name;
        std::string msg;
        bool has_name = JS_IsString(name_v) && to_string(ctx, name_v, name) && !name.empty();
        bool has_msg = JS_IsString(msg_v) && to_string(ctx, msg_v, msg) && !msg.empty();
        JS_FreeValue(ctx, name_v);
        JS_FreeValue(ctx, msg_v);
        if (has_name && has_msg) return name + ": " + msg;
        if (has_msg) return msg;
        if (has_name) return name;
    }
    if (!to_string(ctx, e, out)) drop_exception(ctx);
    return out;
}

/* Text for an assertion message: JSON for most values, Uint8Array[..] for
 * byte arrays (JSON would print them as an object). */
std::string fmt_value(JSContext* ctx, JSValueConst v) {
    if (JS_IsUndefined(v)) return "undefined";
    if (JS_IsNull(v)) return "null";
    if (JS_IsString(v)) return json_or_string(ctx, v);
    if (JS_GetTypedArrayType(v) == JS_TYPED_ARRAY_UINT8) {
        JSValue sep = JS_NewString(ctx, ", ");
        JSAtom join = JS_NewAtom(ctx, "join");
        JSValue joined = JS_Invoke(ctx, v, join, 1, &sep);
        JS_FreeAtom(ctx, join);
        JS_FreeValue(ctx, sep);
        std::string body;
        if (JS_IsException(joined) || !to_string(ctx, joined, body)) drop_exception(ctx);
        JS_FreeValue(ctx, joined);
        return "Uint8Array[" + body + "]";
    }
    return json_or_string(ctx, v);
}

/* ── JSON event lines ───────────────────────────────────────────── */

void json_append_string(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\b':
                out += "\\b";
                break;
            case '\f':
                out += "\\f";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    out += '"';
}

struct Event {
    std::string buf;

    explicit Event(int code) { buf = "{\"e\":" + std::to_string(code); }

    Event& num(const char* key, int64_t v) {
        buf += ",\"";
        buf += key;
        buf += "\":";
        buf += std::to_string(v);
        return *this;
    }

    Event& str(const char* key, const std::string& v) {
        buf += ",\"";
        buf += key;
        buf += "\":";
        json_append_string(buf, v);
        return *this;
    }

    const std::string& done() {
        buf += '}';
        return buf;
    }
};

void emit(JSContext* ctx, Event& ev) {
    const std::string& json = ev.done();
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__testEmit");
    JSValue r;
    if (JS_IsFunction(ctx, fn)) {
        JSValue s = JS_NewStringLen(ctx, json.data(), json.size());
        r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &s);
        JS_FreeValue(ctx, s);
    } else {
        JSValue console = JS_GetPropertyStr(ctx, g, "console");
        JSValue log = JS_GetPropertyStr(ctx, console, "log");
        std::string line = "__TEST__" + json;
        JSValue s = JS_NewStringLen(ctx, line.data(), line.size());
        r = JS_Call(ctx, log, console, 1, &s);
        JS_FreeValue(ctx, s);
        JS_FreeValue(ctx, log);
        JS_FreeValue(ctx, console);
    }
    if (JS_IsException(r)) drop_exception(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, g);
}

/* ── Registration ───────────────────────────────────────────────── */

const char* test_where(int flags) {
    if (flags & F_FIXME) return "test.fixme";
    if (flags & F_SKIP) return "test.skip";
    if (flags & F_ONLY) return "test.only";
    if (flags & F_TODO) return "test.todo";
    return "test";
}

/* Register a suite and run its body with it as the current suite. */
JSValue run_suite_fn(JSContext* ctx, Registry* reg, int flags, std::string name, JSValueConst fn,
                     int argc, JSValueConst* argv) {
    Suite s;
    s.name = std::move(name);
    s.skip = (flags & (F_SKIP | F_FIXME)) != 0;
    s.only = (flags & F_ONLY) != 0;
    s.todo = (flags & F_TODO) != 0;
    s.before_all = JS_UNDEFINED;
    s.after_all = JS_UNDEFINED;
    reg->suites.push_back(std::move(s));
    int prev = reg->current;
    reg->current = static_cast<int>(reg->suites.size()) - 1;
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    reg->current = prev;
    if (JS_IsException(r)) return r;
    JS_FreeValue(ctx, r);
    return JS_UNDEFINED;
}

JSValue push_test(JSContext* ctx, Registry* reg, int flags, std::string name, JSValueConst fn,
                  JSValueConst options) {
    if (reg->current < 0) {
        return JS_ThrowPlainError(ctx, "%s() must be inside describe()", test_where(flags));
    }
    TestCase t;
    t.name = std::move(name);
    t.fn = JS_DupValue(ctx, fn);
    t.skip = (flags & (F_SKIP | F_FIXME)) != 0;
    t.only = (flags & F_ONLY) != 0;
    t.todo = (flags & F_TODO) != 0;
    t.timeout_ms = DEFAULT_TEST_TIMEOUT_MS;
    if (JS_IsObject(options)) {
        JSValue timeout = JS_GetPropertyStr(ctx, options, "timeout");
        if (JS_IsException(timeout)) {
            JS_FreeValue(ctx, t.fn);
            return JS_EXCEPTION;
        }
        /* Any number counts, negative included: a bad value should fail the
         * test at once, not wait out the default. */
        if (JS_IsNumber(timeout)) JS_ToInt64(ctx, &t.timeout_ms, timeout);
        JS_FreeValue(ctx, timeout);
    }
    reg->suites[static_cast<size_t>(reg->current)].tests.push_back(std::move(t));
    return JS_UNDEFINED;
}

/* describe(name, fn) and its skip/only/todo/fixme variants (magic = flags). */
JSValue describe_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                    JSValue* func_data) {
    (void)this_val;
    std::string name;
    if (!to_string(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, name)) return JS_EXCEPTION;
    return run_suite_fn(ctx, reg_of(func_data[0]), magic, std::move(name),
                        argc > 1 ? argv[1] : JS_UNDEFINED, 0, nullptr);
}

/* test(name, fn, options?) and its variants; test.todo(name) takes no fn. */
JSValue test_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data) {
    (void)this_val;
    Registry* reg = reg_of(func_data[0]);
    if (reg->current < 0) {
        return JS_ThrowPlainError(ctx, "%s() must be inside describe()", test_where(magic));
    }
    std::string name;
    if (!to_string(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, name)) return JS_EXCEPTION;
    return push_test(ctx, reg, magic, std::move(name), argc > 1 ? argv[1] : JS_UNDEFINED,
                     argc > 2 ? argv[2] : JS_UNDEFINED);
}

/* Name template for .each: %# is the index, %s String(value), and %o
 * JSON.stringify(value) for object values. */
void replace_all(std::string& s, const char* from, const std::string& to) {
    size_t n = strlen(from);
    size_t at = 0;
    while ((at = s.find(from, at)) != std::string::npos) {
        s.replace(at, n, to);
        at += to.size();
    }
}

bool interpolate_name(JSContext* ctx, const std::string& tmpl, JSValueConst value, uint32_t index,
                      std::string& out) {
    out = tmpl;
    replace_all(out, "%#", std::to_string(index));
    std::string sv;
    if (!to_string(ctx, value, sv)) return false;
    replace_all(out, "%s", sv);
    if (JS_IsObject(value) && !JS_IsFunction(ctx, value)) {
        JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsException(json)) return false;
        std::string js = "undefined";
        if (!JS_IsUndefined(json) && !to_string(ctx, json, js)) {
            JS_FreeValue(ctx, json);
            return false;
        }
        JS_FreeValue(ctx, json);
        replace_all(out, "%o", js);
    }
    return true;
}

/* The wrapper a test.each case registers: () => fn(value, index). */
JSValue each_wrapper_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                        int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue args[2] = {func_data[1], func_data[2]};
    return JS_Call(ctx, func_data[0], JS_UNDEFINED, 2, args);
}

/* (describe|test).<variant>.each(cases)(name, fn). func_data: [registry, cases];
 * magic: flags, plus EACH_TEST when registering tests rather than suites. */
constexpr int EACH_TEST = 1 << 8;

JSValue each_bound_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    Registry* reg = reg_of(func_data[0]);
    JSValueConst cases = func_data[1];
    int flags = magic & 0xff;
    bool is_test = (magic & EACH_TEST) != 0;
    std::string tmpl;
    if (!to_string(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, tmpl)) return JS_EXCEPTION;
    JSValueConst fn = argc > 1 ? argv[1] : JS_UNDEFINED;
    JSValue len_v = JS_GetPropertyStr(ctx, cases, "length");
    uint32_t len = 0;
    if (JS_IsException(len_v) || JS_ToUint32(ctx, &len, len_v) < 0) {
        JS_FreeValue(ctx, len_v);
        return JS_EXCEPTION;
    }
    JS_FreeValue(ctx, len_v);
    for (uint32_t i = 0; i < len; i++) {
        JSValue value = JS_GetPropertyUint32(ctx, cases, i);
        if (JS_IsException(value)) return JS_EXCEPTION;
        std::string name;
        if (!interpolate_name(ctx, tmpl, value, i, name)) {
            JS_FreeValue(ctx, value);
            return JS_EXCEPTION;
        }
        JSValue r;
        if (is_test) {
            JSValue index = JS_NewUint32(ctx, i);
            JSValue data[3] = {fn, value, index};
            JSValue wrapper = JS_NewCFunctionData(ctx, each_wrapper_cb, 0, 0, 3, data);
            JS_FreeValue(ctx, index);
            r = push_test(ctx, reg, flags, std::move(name), wrapper, JS_UNDEFINED);
            JS_FreeValue(ctx, wrapper);
        } else {
            JSValue index = JS_NewUint32(ctx, i);
            JSValue args[2] = {value, index};
            r = run_suite_fn(ctx, reg, flags, name, fn, 2, args);
            JS_FreeValue(ctx, index);
        }
        JS_FreeValue(ctx, value);
        if (JS_IsException(r)) return r;
    }
    return JS_UNDEFINED;
}

JSValue each_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data) {
    (void)this_val;
    JSValue data[2] = {func_data[0], argc > 0 ? argv[0] : JS_UNDEFINED};
    return JS_NewCFunctionData(ctx, each_bound_cb, 2, magic, 2, data);
}

/* skipIf(cond) / runIf(cond): func_data = [plain, skip]; magic 1 = runIf. */
JSValue pick_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data) {
    (void)this_val;
    bool cond = argc > 0 && JS_ToBool(ctx, argv[0]) > 0;
    bool skip = magic ? !cond : cond;
    return JS_DupValue(ctx, func_data[skip ? 1 : 0]);
}

enum HookKind : int { HOOK_BEFORE_ALL, HOOK_AFTER_ALL, HOOK_BEFORE_EACH, HOOK_AFTER_EACH };
const char* const hook_names[] = {"beforeAll", "afterAll", "beforeEach", "afterEach"};

JSValue hook_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data) {
    (void)this_val;
    Registry* reg = reg_of(func_data[0]);
    if (reg->current < 0) {
        return JS_ThrowPlainError(ctx, "%s() must be inside describe()", hook_names[magic]);
    }
    Suite& s = reg->suites[static_cast<size_t>(reg->current)];
    JSValue fn = JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    switch (magic) {
        case HOOK_BEFORE_ALL:
            JS_FreeValue(ctx, s.before_all);
            s.before_all = fn;
            break;
        case HOOK_AFTER_ALL:
            JS_FreeValue(ctx, s.after_all);
            s.after_all = fn;
            break;
        case HOOK_BEFORE_EACH:
            s.before_each.push_back(fn);
            break;
        default:
            s.after_each.push_back(fn);
            break;
    }
    return JS_UNDEFINED;
}

/* ── Assertions ─────────────────────────────────────────────────── */

/* Throw an AssertError: `message: detail` when a message was given. */
JSValue fail(JSContext* ctx, JSValueConst message, const std::string& detail) {
    std::string text;
    if (JS_ToBool(ctx, message) > 0) {
        if (!to_string(ctx, message, text)) return JS_EXCEPTION;
        text += ": ";
    }
    text += detail;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue error_ctor = JS_GetPropertyStr(ctx, g, "Error");
    JS_FreeValue(ctx, g);
    JSValue msg = JS_NewStringLen(ctx, text.data(), text.size());
    JSValue err = JS_CallConstructor(ctx, error_ctor, 1, &msg);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, error_ctor);
    if (JS_IsException(err)) return err;
    JS_SetPropertyStr(ctx, err, "name", JS_NewString(ctx, "AssertError"));
    return JS_Throw(ctx, err);
}

JSValueConst arg(int argc, JSValueConst* argv, int i) {
    return i < argc ? argv[i] : JS_UNDEFINED;
}

/* e instanceof Error ? e : new Error(String(e)). Consumes e. */
JSValue as_error(JSContext* ctx, JSValue e) {
    if (JS_IsError(e)) return e;
    std::string text;
    if (!to_string(ctx, e, text)) drop_exception(ctx);
    JS_FreeValue(ctx, e);
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue error_ctor = JS_GetPropertyStr(ctx, g, "Error");
    JS_FreeValue(ctx, g);
    JSValue msg = JS_NewStringLen(ctx, text.data(), text.size());
    JSValue err = JS_CallConstructor(ctx, error_ctor, 1, &msg);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, error_ctor);
    return err;
}

JSValue assert_equal(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValueConst actual = arg(argc, argv, 0);
    JSValueConst expected = arg(argc, argv, 1);
    if (JS_IsSameValue(ctx, actual, expected)) return JS_UNDEFINED;
    return fail(ctx, arg(argc, argv, 2),
                "expected " + fmt_value(ctx, expected) + ", got " + fmt_value(ctx, actual));
}

JSValue assert_not_equal(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValueConst actual = arg(argc, argv, 0);
    JSValueConst unexpected = arg(argc, argv, 1);
    if (!JS_IsSameValue(ctx, actual, unexpected)) return JS_UNDEFINED;
    return fail(ctx, arg(argc, argv, 2),
                "expected value to differ from " + fmt_value(ctx, unexpected));
}

JSValue assert_truthy(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValueConst value = arg(argc, argv, 0);
    if (JS_ToBool(ctx, value) > 0) return JS_UNDEFINED;
    return fail(ctx, arg(argc, argv, 1), "expected truthy, got " + fmt_value(ctx, value));
}

/* Deep equality is JSON equality, as documented. */
JSValue assert_deep_equal(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValue a = JS_JSONStringify(ctx, arg(argc, argv, 0), JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(a)) return a;
    JSValue b = JS_JSONStringify(ctx, arg(argc, argv, 1), JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(b)) {
        JS_FreeValue(ctx, a);
        return b;
    }
    bool same = JS_IsUndefined(a) && JS_IsUndefined(b);
    std::string sa = "undefined";
    std::string sb = "undefined";
    if (!same) {
        if (!JS_IsUndefined(a) && !to_string(ctx, a, sa)) drop_exception(ctx);
        if (!JS_IsUndefined(b) && !to_string(ctx, b, sb)) drop_exception(ctx);
        same = !JS_IsUndefined(a) && !JS_IsUndefined(b) && sa == sb;
    }
    JS_FreeValue(ctx, a);
    JS_FreeValue(ctx, b);
    if (same) return JS_UNDEFINED;
    return fail(ctx, arg(argc, argv, 2), "expected " + sb + ", got " + sa);
}

JSValue assert_throws(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValue r = JS_Call(ctx, arg(argc, argv, 0), JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(r)) return as_error(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, r);
    return fail(ctx, arg(argc, argv, 1), "expected function to throw");
}

JSValue rejects_fulfilled(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                          int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    return fail(ctx, func_data[0], "expected promise to reject");
}

JSValue rejects_rejected(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    return as_error(ctx, JS_DupValue(ctx, arg(argc, argv, 0)));
}

JSValue promise_resolve(JSContext* ctx, JSValueConst promise_ctor, JSValue v);

/* rejects(fn, message?): resolves with the rejection as an Error, rejects
 * with an AssertError when the promise fulfils. */
JSValue assert_rejects(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue promise_ctor = JS_GetPropertyStr(ctx, g, "Promise");
    JS_FreeValue(ctx, g);
    JSValue r = JS_Call(ctx, arg(argc, argv, 0), JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(r)) {
        /* A synchronous throw is a rejection too. */
        JSValue err = as_error(ctx, JS_GetException(ctx));
        JSValue p = promise_resolve(ctx, promise_ctor, err);
        JS_FreeValue(ctx, promise_ctor);
        return p;
    }
    JSValue p = promise_resolve(ctx, promise_ctor, r);
    JS_FreeValue(ctx, promise_ctor);
    if (JS_IsException(p)) return p;
    JSValueConst message = arg(argc, argv, 1);
    JSValue on_ok = JS_NewCFunctionData(ctx, rejects_fulfilled, 1, 0, 1, &message);
    JSValue on_err = JS_NewCFunction(ctx, rejects_rejected, "rejected", 1);
    JSValue handlers[2] = {on_ok, on_err};
    JSAtom then = JS_NewAtom(ctx, "then");
    JSValue derived = JS_Invoke(ctx, p, then, 2, handlers);
    JS_FreeAtom(ctx, then);
    JS_FreeValue(ctx, on_ok);
    JS_FreeValue(ctx, on_err);
    JS_FreeValue(ctx, p);
    return derived;
}

JSValue assert_type(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    const char* actual = js_typeof(ctx, arg(argc, argv, 0));
    std::string expected;
    if (!to_string(ctx, arg(argc, argv, 1), expected)) return JS_EXCEPTION;
    if (expected == actual) return JS_UNDEFINED;
    return fail(ctx, arg(argc, argv, 2), "expected typeof " + expected + ", got " + actual);
}

JSValue assert_instance(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    JSValueConst value = arg(argc, argv, 0);
    JSValueConst ctor = arg(argc, argv, 1);
    int is = JS_IsInstanceOf(ctx, value, ctor);
    if (is < 0) return JS_EXCEPTION;
    if (is) return JS_UNDEFINED;
    JSValue name_v = JS_GetPropertyStr(ctx, ctor, "name");
    std::string name;
    if (JS_IsException(name_v) || !to_string(ctx, name_v, name)) drop_exception(ctx);
    JS_FreeValue(ctx, name_v);
    return fail(ctx, arg(argc, argv, 2),
                "expected instanceof " + name + ", got " + fmt_value(ctx, value));
}

/* ok(result) / err(result): magic 1 expects an error result. */
JSValue assert_result(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                      int magic) {
    (void)this_val;
    JSValueConst r = arg(argc, argv, 0);
    const MIKResultAtoms& atoms = MIK_GetRuntime(ctx)->result_atoms;
    JSValue ok_v = JS_GetProperty(ctx, r, atoms.ok);
    if (JS_IsException(ok_v)) return ok_v;
    bool ok = JS_ToBool(ctx, ok_v) > 0;
    JS_FreeValue(ctx, ok_v);
    if (ok != (magic == 1)) return JS_UNDEFINED;
    if (magic == 0) {
        JSValue error = JS_GetProperty(ctx, r, atoms.error);
        std::string detail = "expected ok result, got error: " + format_thrown(ctx, error);
        JS_FreeValue(ctx, error);
        return fail(ctx, arg(argc, argv, 1), detail);
    }
    JSValue value = JS_GetProperty(ctx, r, atoms.value);
    std::string detail = "expected error result, got ok: " + fmt_value(ctx, value);
    JS_FreeValue(ctx, value);
    return fail(ctx, arg(argc, argv, 1), detail);
}

JSValue make_assert(JSContext* ctx) {
    JSValue a = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, a, "equal", JS_NewCFunction(ctx, assert_equal, "equal", 3));
    JS_SetPropertyStr(ctx, a, "notEqual", JS_NewCFunction(ctx, assert_not_equal, "notEqual", 3));
    JS_SetPropertyStr(ctx, a, "truthy", JS_NewCFunction(ctx, assert_truthy, "truthy", 2));
    JS_SetPropertyStr(ctx, a, "deepEqual", JS_NewCFunction(ctx, assert_deep_equal, "deepEqual", 3));
    JS_SetPropertyStr(ctx, a, "throws", JS_NewCFunction(ctx, assert_throws, "throws", 2));
    JS_SetPropertyStr(ctx, a, "rejects", JS_NewCFunction(ctx, assert_rejects, "rejects", 2));
    JS_SetPropertyStr(ctx, a, "type", JS_NewCFunction(ctx, assert_type, "type", 3));
    JS_SetPropertyStr(ctx, a, "instance", JS_NewCFunction(ctx, assert_instance, "instance", 3));
    JS_SetPropertyStr(ctx, a, "ok",
                      JS_NewCFunctionMagic(ctx, assert_result, "ok", 2, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, a, "err",
                      JS_NewCFunctionMagic(ctx, assert_result, "err", 2, JS_CFUNC_generic_magic, 1));
    return a;
}

/* ── Runner ─────────────────────────────────────────────────────── */

/* Promise.resolve(v). Consumes v. */
JSValue promise_resolve(JSContext* ctx, JSValueConst promise_ctor, JSValue v) {
    JSAtom resolve = JS_NewAtom(ctx, "resolve");
    JSValue p = JS_Invoke(ctx, promise_ctor, resolve, 1, &v);
    JS_FreeAtom(ctx, resolve);
    JS_FreeValue(ctx, v);
    return p;
}

JSValue step_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data);

/* Continue the run once `v` settles: Promise.resolve(v).then(ok, err), the
 * handlers carrying the registry and the current test's sequence number.
 * Consumes v. */
void settle(JSContext* ctx, JSValueConst reg_obj, Registry* reg, JSValue v, Step ok, Step err) {
    JSValue p = promise_resolve(ctx, reg->promise_ctor, v);
    if (JS_IsException(p)) {
        mik_dump_error(ctx);
        return;
    }
    JSValue seq = JS_NewUint32(ctx, reg->seq);
    JSValue data[2] = {reg_obj, seq};
    JSValue on_ok = JS_NewCFunctionData(ctx, step_cb, 1, ok, 2, data);
    JSValue on_err = JS_NewCFunctionData(ctx, step_cb, 1, err, 2, data);
    JS_FreeValue(ctx, seq);
    JSValue handlers[2] = {on_ok, on_err};
    JSAtom then = JS_NewAtom(ctx, "then");
    JSValue derived = JS_Invoke(ctx, p, then, 2, handlers);
    JS_FreeAtom(ctx, then);
    if (JS_IsException(derived)) mik_dump_error(ctx);
    JS_FreeValue(ctx, derived);
    JS_FreeValue(ctx, on_ok);
    JS_FreeValue(ctx, on_err);
    JS_FreeValue(ctx, p);
}

/* Call fn() and settle on its result; a synchronous throw settles as a
 * rejection so every step, failing or not, returns through the job queue. */
void settle_call(JSContext* ctx, JSValueConst reg_obj, Registry* reg, JSValueConst fn, Step ok,
                 Step err) {
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(r)) {
        JSValue e = JS_GetException(ctx);
        JSValue funcs[2];
        r = JS_NewPromiseCapability(ctx, funcs);
        if (JS_IsException(r)) {
            JS_FreeValue(ctx, e);
            mik_dump_error(ctx);
            return;
        }
        JSValue rr = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, &e);
        JS_FreeValue(ctx, rr);
        JS_FreeValue(ctx, funcs[0]);
        JS_FreeValue(ctx, funcs[1]);
        JS_FreeValue(ctx, e);
    }
    settle(ctx, reg_obj, reg, r, ok, err);
}

int64_t now_us() {
    return MIK_GetPlatform()->get_rtc_us();
}

int64_t elapsed_ms(int64_t start) {
    return (now_us() - start + 500) / 1000;
}

struct Mem {
    int64_t heap_used;
    int64_t heap_total;
    int64_t sys_free;
    int64_t sys_min_free;
};

Mem gc_and_measure(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    JS_RunGC(rt);
    JSMemoryUsage mem;
    JS_ComputeMemoryUsage(rt, &mem);
    const MIKPlatform* platform = MIK_GetPlatform();
    return Mem{mem.malloc_size, mem.malloc_limit > 0 ? mem.malloc_limit : mem.malloc_size,
               static_cast<int64_t>(platform->get_free_system_mem()),
               static_cast<int64_t>(platform->get_min_free_system_mem())};
}

void emit_heap(JSContext* ctx, Registry* reg) {
    Mem m = gc_and_measure(ctx);
    Event ev(8);
    ev.num("u", m.heap_used).num("t", m.heap_total);
    if (m.sys_free > 0) {
        ev.num("f", m.sys_free);
        if (reg->sys_free_floor == 0 || m.sys_free < reg->sys_free_floor) {
            reg->sys_free_floor = m.sys_free;
        }
        if (reg->suite_free_floor == 0 || m.sys_free < reg->suite_free_floor) {
            reg->suite_free_floor = m.sys_free;
        }
    }
    if (m.sys_min_free > 0) ev.num("mf", m.sys_min_free);
    emit(ctx, ev);
}

int32_t active_timers(JSContext* ctx, Registry* reg) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto n = static_cast<int32_t>(mik_rt->timers->entries.size());
    return reg->in_start ? n - 1 : n;
}

/* pendingCount() from native:mikro/http. Only read when something already
 * loaded that module: nothing can be pending in a runtime without it, and
 * loading it here would charge every test file for the http stack. */
int32_t pending_http(JSContext* ctx) {
    JSAtom name = JS_NewAtom(ctx, "native:mikro/http");
    JSModuleDef* m = JS_FindLoadedModule(ctx, name);
    JS_FreeAtom(ctx, name);
    if (!m) return 0;
    JSValue ns = JS_GetModuleNamespace(ctx, m);
    if (JS_IsException(ns)) {
        drop_exception(ctx);
        return 0;
    }
    JSValue fn = JS_GetPropertyStr(ctx, ns, "pendingCount");
    JS_FreeValue(ctx, ns);
    int32_t n = 0;
    if (JS_IsFunction(ctx, fn)) {
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 0, nullptr);
        if (JS_IsException(r) || JS_ToInt32(ctx, &n, r) < 0) {
            drop_exception(ctx);
            n = 0;
        }
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, fn);
    return n;
}

/* The running suite / test. Re-fetch after every call that can re-enter JS:
 * describe() from inside a hook, a test, a getter or an emit transport
 * appends to `suites` and may reallocate it. */
Suite& cur_suite(Registry* reg) {
    return reg->suites[reg->si];
}

TestCase& cur_test(Registry* reg) {
    return reg->suites[reg->si].tests[reg->ti];
}

void clear_timeout(JSContext* ctx, Registry* reg) {
    if (!reg->timeout_timer) return;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    MIK_Timer_UnSchedule(mik_rt->timers, ctx, reg->timeout_timer);
    reg->timeout_timer = 0;
}

/* e:9 for a todo test, e:4 for a skipped one. */
void emit_test_skip(JSContext* ctx, Registry* reg, const std::string& suite,
                    const std::string& test, bool todo) {
    if (todo) {
        Event ev(9);
        ev.str("s", suite).str("t", test);
        emit(ctx, ev);
        reg->todo++;
    } else {
        Event ev(4);
        ev.str("s", suite).str("t", test);
        emit(ctx, ev);
        reg->skipped++;
    }
}

void emit_suite_end_bare(JSContext* ctx, const std::string& name);

/* Skip (or, for a .todo suite, todo) every test of the running suite, then
 * close it without a retention figure. Indexed: each emit may re-enter JS. */
void skip_suite(JSContext* ctx, Registry* reg, bool all_todo) {
    std::string suite = cur_suite(reg).name;
    for (size_t i = 0; i < cur_suite(reg).tests.size(); i++) {
        const TestCase& t = cur_suite(reg).tests[i];
        std::string name = t.name;
        bool todo = all_todo || t.todo;
        emit_test_skip(ctx, reg, suite, name, todo);
    }
    emit_suite_end_bare(ctx, suite);
    reg->si++;
}

void emit_suite_end_bare(JSContext* ctx, const std::string& name) {
    Event ev(5);
    ev.str("s", name);
    emit(ctx, ev);
}

/* Fold the finished suite's retention into the file total and start the
 * next suite from where this one ended. */
void close_suite(JSContext* ctx, Registry* reg) {
    Mem m = gc_and_measure(ctx);
    int64_t retained = m.heap_used - reg->suite_baseline;
    reg->heap_retained += retained;
    reg->suite_baseline = m.heap_used;
    if (m.sys_free > 0 && m.sys_free < reg->suite_free_floor) reg->suite_free_floor = m.sys_free;
    int64_t sys_used = reg->suite_free_start > reg->suite_free_floor
                           ? reg->suite_free_start - reg->suite_free_floor
                           : 0;
    Event ev(5);
    ev.str("s", reg->suites[reg->si].name).num("hr", retained);
    if (sys_used > 0) ev.num("su", sys_used);
    emit(ctx, ev);
    reg->si++;
}

void run_finish(JSContext* ctx, Registry* reg) {
    Mem m = gc_and_measure(ctx);
    if (m.sys_free > 0 && (reg->sys_free_floor == 0 || m.sys_free < reg->sys_free_floor)) {
        reg->sys_free_floor = m.sys_free;
    }
    /* Whatever ran outside a suite's own accounting: a file without
     * suites, and the skip/todo bookkeeping between them. */
    reg->heap_retained += m.heap_used - reg->suite_baseline;
    int32_t timers_after = active_timers(ctx, reg);
    int32_t pending_after = pending_http(ctx);
    int64_t sys_used =
        reg->sys_free_start > reg->sys_free_floor ? reg->sys_free_start - reg->sys_free_floor : 0;
    Event ev(6);
    ev.num("p", reg->passed)
        .num("f", reg->failed)
        .num("k", reg->skipped)
        .num("o", reg->todo)
        .num("d", elapsed_ms(reg->start_us))
        .num("hb", reg->start_heap)
        .num("ha", m.heap_used)
        .num("hr", reg->heap_retained)
        .num("tb", reg->timers_before)
        .num("ta", timers_after)
        .num("pb", reg->pending_before)
        .num("pa", pending_after);
    if (reg->sys_free_start > 0) ev.num("su", sys_used).num("sf", reg->sys_free_floor);
    emit(ctx, ev);

    /* Tell a supervisor this file is complete so it can swap in the next
     * runtime. Absent outside the test harness. */
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue done = JS_GetPropertyStr(ctx, g, "__testFileDone");
    JS_FreeValue(ctx, g);
    if (JS_IsFunction(ctx, done)) {
        JSValue r = JS_Call(ctx, done, JS_UNDEFINED, 0, nullptr);
        if (JS_IsException(r)) mik_dump_error(ctx);
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, done);
}

void test_step(JSContext* ctx, JSValueConst reg_obj, Registry* reg);
void after_each_step(JSContext* ctx, JSValueConst reg_obj, Registry* reg);

/* Drive the run until it has to wait on a promise (or is done). */
void advance(JSContext* ctx, JSValueConst reg_obj, Registry* reg) {
    for (;;) {
        switch (reg->phase) {
            case PH_SUITE_BEGIN: {
                if (reg->si >= reg->suites.size()) {
                    reg->phase = PH_DONE;
                    run_finish(ctx, reg);
                    return;
                }
                /* Open this suite's own peak window on the post-gc sample. */
                reg->suite_free_floor = 0;
                emit_heap(ctx, reg);
                reg->suite_free_start = reg->suite_free_floor;
                Event begin(1);
                begin.str("s", cur_suite(reg).name)
                    .num("n", static_cast<int64_t>(cur_suite(reg).tests.size()));
                emit(ctx, begin);

                bool suite_has_only = false;
                for (const auto& t : cur_suite(reg).tests) suite_has_only |= t.only;
                bool filtered = reg->has_only && !cur_suite(reg).only && !suite_has_only;
                if (cur_suite(reg).skip || cur_suite(reg).todo || filtered) {
                    skip_suite(ctx, reg, cur_suite(reg).todo);
                    continue;
                }
                /* Within a participating suite, .only tests exclude the rest. */
                reg->only_in_suite = reg->has_only && suite_has_only;
                reg->ti = 0;
                reg->phase = PH_TESTS;
                JSValueConst before_all = cur_suite(reg).before_all;
                if (JS_IsUndefined(before_all)) continue;
                settle_call(ctx, reg_obj, reg, before_all, STEP_BEFORE_ALL_OK,
                            STEP_BEFORE_ALL_ERR);
                return;
            }
            case PH_TESTS: {
                if (reg->ti >= cur_suite(reg).tests.size()) {
                    reg->phase = PH_SUITE_FINISH;
                    continue;
                }
                const TestCase& t = cur_test(reg);
                if (t.todo || t.skip || (reg->only_in_suite && !t.only)) {
                    std::string suite = cur_suite(reg).name;
                    std::string name = t.name;
                    bool todo = t.todo;
                    emit_test_skip(ctx, reg, suite, name, todo);
                    reg->ti++;
                    continue;
                }
                int64_t timeout_ms = t.timeout_ms;
                emit_heap(ctx, reg);
                reg->seq++;
                reg->test_settled = false;
                reg->hook_i = 0;
                reg->test_start_us = now_us();
                JSValue seq = JS_NewUint32(ctx, reg->seq);
                JSValue data[2] = {reg_obj, seq};
                JSValue on_timeout = JS_NewCFunctionData(ctx, step_cb, 0, STEP_TIMEOUT, 2, data);
                JS_FreeValue(ctx, seq);
                MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
                reg->timeout_timer =
                    MIK_Timer_Schedule(mik_rt->timers, ctx, on_timeout, 0, nullptr,
                                       timeout_ms * 1000, false, MIK_GetPlatform()->get_boot_us());
                JS_FreeValue(ctx, on_timeout);
                test_step(ctx, reg_obj, reg);
                return;
            }
            case PH_SUITE_FINISH: {
                JSValueConst after_all = cur_suite(reg).after_all;
                if (!JS_IsUndefined(after_all)) {
                    reg->phase = PH_SUITE_BEGIN;
                    settle_call(ctx, reg_obj, reg, after_all, STEP_AFTER_ALL, STEP_AFTER_ALL);
                    return;
                }
                close_suite(ctx, reg);
                reg->phase = PH_SUITE_BEGIN;
                continue;
            }
            case PH_DONE:
                return;
        }
    }
}

/* Run the next beforeEach hook, then the test itself. */
void test_step(JSContext* ctx, JSValueConst reg_obj, Registry* reg) {
    if (reg->hook_i < cur_suite(reg).before_each.size()) {
        JSValueConst hook = cur_suite(reg).before_each[reg->hook_i];
        settle_call(ctx, reg_obj, reg, hook, STEP_HOOK_OK, STEP_TEST_ERR);
        return;
    }
    JSValueConst fn = cur_test(reg).fn;
    settle_call(ctx, reg_obj, reg, fn, STEP_TEST_OK, STEP_TEST_ERR);
}

void test_done(JSContext* ctx, JSValueConst reg_obj, Registry* reg, bool passed,
               const std::string& message) {
    reg->test_settled = true;
    clear_timeout(ctx, reg);
    Event ev(passed ? 2 : 3);
    ev.str("s", cur_suite(reg).name).str("t", cur_test(reg).name);
    ev.num("d", elapsed_ms(reg->test_start_us));
    if (!passed) ev.str("m", message);
    emit(ctx, ev);
    if (passed) {
        reg->passed++;
    } else {
        reg->failed++;
    }
    reg->hook_i = 0;
    after_each_step(ctx, reg_obj, reg);
}

/* afterEach hooks run whatever the outcome; their errors are not fatal. */
void after_each_step(JSContext* ctx, JSValueConst reg_obj, Registry* reg) {
    if (reg->hook_i < cur_suite(reg).after_each.size()) {
        JSValueConst hook = cur_suite(reg).after_each[reg->hook_i];
        settle_call(ctx, reg_obj, reg, hook, STEP_AFTER_EACH, STEP_AFTER_EACH);
        return;
    }
    reg->ti++;
    advance(ctx, reg_obj, reg);
}

void run_start(JSContext* ctx, JSValueConst reg_obj, Registry* reg) {
    reg->start_us = now_us();
    reg->pending_before = pending_http(ctx);
    /* Leak-detection baseline: post-gc, with every suite registered, so the
     * runner's own allocations sit inside it rather than count as growth. */
    Mem m = gc_and_measure(ctx);
    reg->start_heap = m.heap_used;
    reg->heap_retained = 0;
    reg->suite_baseline = m.heap_used;
    if (m.sys_free > 0) {
        reg->sys_free_start = m.sys_free;
        reg->sys_free_floor = m.sys_free;
    }
    reg->timers_before = active_timers(ctx, reg);
    /* Any .only anywhere filters everything else. */
    for (const auto& s : reg->suites) {
        reg->has_only |= s.only;
        for (const auto& t : s.tests) reg->has_only |= t.only;
    }
    reg->phase = PH_SUITE_BEGIN;
    reg->si = 0;
    advance(ctx, reg_obj, reg);
}

JSValue step_cb(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic,
                JSValue* func_data) {
    (void)this_val;
    JSValueConst reg_obj = func_data[0];
    Registry* reg = reg_of(reg_obj);
    uint32_t seq = 0;
    JS_ToUint32(ctx, &seq, func_data[1]);
    JSValueConst value = argc > 0 ? argv[0] : JS_UNDEFINED;
    switch (static_cast<Step>(magic)) {
        case STEP_RUN:
            /* A file with nothing to run finishes inside this callback. */
            reg->in_start = true;
            run_start(ctx, reg_obj, reg);
            reg->in_start = false;
            break;
        case STEP_BEFORE_ALL_OK:
            /* One more microtask before the baseline so the beforeAll frame's
             * locals are collectible; otherwise the suite would close below
             * its baseline. */
            settle(ctx, reg_obj, reg, JS_UNDEFINED, STEP_BASELINE, STEP_BASELINE);
            break;
        case STEP_BASELINE: {
            Mem m = gc_and_measure(ctx);
            reg->suite_baseline = m.heap_used;
            advance(ctx, reg_obj, reg);
            break;
        }
        case STEP_BEFORE_ALL_ERR: {
            /* A broken beforeAll fails the suite's tests rather than skipping
             * them: a skip reads as a deliberate gate. */
            std::string message = format_thrown(ctx, value); /* runs getters */
            std::string suite = cur_suite(reg).name;
            Event ev(7);
            ev.str("s", suite).str("m", message);
            emit(ctx, ev);
            for (size_t i = 0; i < cur_suite(reg).tests.size(); i++) {
                const TestCase& t = cur_suite(reg).tests[i];
                std::string name = t.name;
                if (t.todo) {
                    Event todo(9);
                    todo.str("s", suite).str("t", name);
                    emit(ctx, todo);
                    reg->todo++;
                } else {
                    Event failed(3);
                    failed.str("s", suite).str("t", name).num("d", 0).str("m", "beforeAll failed");
                    emit(ctx, failed);
                    reg->failed++;
                }
            }
            emit_suite_end_bare(ctx, suite);
            reg->si++;
            reg->phase = PH_SUITE_BEGIN;
            advance(ctx, reg_obj, reg);
            break;
        }
        case STEP_HOOK_OK:
            if (seq != reg->seq || reg->test_settled) break;
            reg->hook_i++;
            test_step(ctx, reg_obj, reg);
            break;
        case STEP_TEST_OK:
            if (seq != reg->seq || reg->test_settled) break;
            test_done(ctx, reg_obj, reg, true, "");
            break;
        case STEP_TEST_ERR:
            if (seq != reg->seq || reg->test_settled) break;
            test_done(ctx, reg_obj, reg, false, format_thrown(ctx, value));
            break;
        case STEP_TIMEOUT: {
            /* test_done unschedules this timer while it runs, so a file that
             * ends here does not count it as still active. */
            if (seq != reg->seq || reg->test_settled) break;
            int64_t ms = cur_test(reg).timeout_ms;
            test_done(ctx, reg_obj, reg, false, "timeout (" + std::to_string(ms) + "ms)");
            break;
        }
        case STEP_AFTER_EACH:
            if (seq != reg->seq) break;
            reg->hook_i++;
            after_each_step(ctx, reg_obj, reg);
            break;
        case STEP_AFTER_ALL:
            close_suite(ctx, reg);
            advance(ctx, reg_obj, reg);
            break;
    }
    return JS_UNDEFINED;
}

/* ── Module ─────────────────────────────────────────────────────── */

JSValue make_registrar(JSContext* ctx, JSCFunctionData* fn, int length, int flags,
                       JSValueConst reg_obj, bool with_each, int each_flags) {
    JSValue f = JS_NewCFunctionData(ctx, fn, length, flags, 1, &reg_obj);
    if (with_each) {
        JS_SetPropertyStr(ctx, f, "each", JS_NewCFunctionData(ctx, each_cb, 1, each_flags, 1, &reg_obj));
    }
    return f;
}

/* describe / test with their variant trees. `each_base` is EACH_TEST for test. */
JSValue make_family(JSContext* ctx, JSCFunctionData* fn, int length, JSValueConst reg_obj,
                    int each_base, bool is_test) {
    JSValue plain = make_registrar(ctx, fn, length, 0, reg_obj, true, each_base);
    JSValue skip = make_registrar(ctx, fn, length, F_SKIP, reg_obj, true, each_base | F_SKIP);
    JSValue pair[2] = {plain, skip};
    JS_SetPropertyStr(ctx, plain, "skipIf", JS_NewCFunctionData(ctx, pick_cb, 1, 0, 2, pair));
    JS_SetPropertyStr(ctx, plain, "runIf", JS_NewCFunctionData(ctx, pick_cb, 1, 1, 2, pair));
    JS_SetPropertyStr(ctx, plain, "skip", skip);
    JS_SetPropertyStr(ctx, plain, "only",
                      make_registrar(ctx, fn, length, F_ONLY, reg_obj, true, each_base | F_ONLY));
    JS_SetPropertyStr(ctx, plain, "fixme",
                      make_registrar(ctx, fn, length, F_FIXME, reg_obj, true, each_base | F_FIXME));
    if (is_test) {
        /* test.todo(name): no function, no .each */
        JS_SetPropertyStr(ctx, plain, "todo", make_registrar(ctx, fn, 1, F_TODO, reg_obj, false, 0));
    } else {
        JS_SetPropertyStr(ctx, plain, "todo",
                          make_registrar(ctx, fn, length, F_TODO, reg_obj, true, F_TODO));
    }
    return plain;
}

int test_module_init(JSContext* ctx, JSModuleDef* m) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    JSRuntime* rt = JS_GetRuntime(ctx);
    MIK_NewClassID(rt, &registry_class_id);
    JS_NewClass(rt, registry_class_id, &registry_class_def);
    JSValue reg_obj = JS_NewObjectClass(ctx, registry_class_id);
    if (JS_IsException(reg_obj)) return -1;
    auto* reg = new Registry();
    JS_SetOpaque(reg_obj, reg);
    JSValue g = JS_GetGlobalObject(ctx);
    reg->promise_ctor = JS_GetPropertyStr(ctx, g, "Promise");
    JS_FreeValue(ctx, g);

    JS_SetModuleExport(ctx, m, "describe", make_family(ctx, describe_cb, 2, reg_obj, 0, false));
    JS_SetModuleExport(ctx, m, "test", make_family(ctx, test_cb, 2, reg_obj, EACH_TEST, true));
    for (int k = HOOK_BEFORE_ALL; k <= HOOK_AFTER_EACH; k++) {
        JS_SetModuleExport(ctx, m, hook_names[k],
                           JS_NewCFunctionData(ctx, hook_cb, 1, k, 1, &reg_obj));
    }
    JS_SetModuleExport(ctx, m, "assert", make_assert(ctx));

    /* Auto-run once the importing file's evaluation has completed. */
    JSValue seq = JS_NewUint32(ctx, 0);
    JSValue data[2] = {reg_obj, seq};
    JSValue run_fn = JS_NewCFunctionData(ctx, step_cb, 0, STEP_RUN, 2, data);
    JS_FreeValue(ctx, seq);
    MIK_Timer_Schedule(mik_rt->timers, ctx, run_fn, 0, nullptr, 0, false,
                       MIK_GetPlatform()->get_boot_us());
    JS_FreeValue(ctx, run_fn);
    JS_FreeValue(ctx, reg_obj);
    return 0;
}

const char* const exports[] = {"describe", "test", "beforeAll", "afterAll",
                               "beforeEach", "afterEach", "assert"};

}  // namespace

/* mikro/test, resolved through the C-module table in modules.cpp on first
 * import. */
JSModuleDef* mik__test_load(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/test", test_module_init);
    if (!m) return nullptr;
    for (const char* name : exports) JS_AddModuleExport(ctx, m, name);
    return m;
}

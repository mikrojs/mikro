#include <cstdarg>
#include <cstdio>

#include <quickjs.h>

#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/* ── Result module ──────────────────────────────────────────────────
 *
 * Native implementation of the Result<T, E> abstraction.  The public JS
 * shape is unchanged: {ok: true, value} or {ok: false, error}.  What's new
 * is that every such object is allocated against a runtime-shared prototype
 * holding the chaining methods (.map, .mapErr, .andThen, .match, .orDefault,
 * .orPanic) + Symbol.for('mikrojs.inspect').
 *
 * Motivation: the previous TS implementation (runtime/result/result.ts)
 * compiled to ~7 KB of per-runtime JS heap because every public runtime
 * module (mikrojs/pin, mikrojs/wifi, …) top-level-imported it, so both
 * OkImpl/ErrImpl class bodies and their ~16 method closures were paid once
 * per runtime whether the app used them or not.  Moving the prototype to C
 * keeps the fluent API while collapsing that to a single shared proto +
 * seven JSCFunction entries, most of which live in flash.
 *
 * All six methods branch on `this.ok` rather than living on two prototypes.
 * The single-proto shape is what lets mik__result_ok/mik__result_err (used
 * by every native module return value) stay a one-liner.
 */

static inline JSValue get_result_proto(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    if (!rt) return JS_NULL;
    return rt->result_proto;
}

static inline JSValue new_result_obj(JSContext* ctx) {
    JSValue proto = get_result_proto(ctx);
    if (JS_IsNull(proto) || JS_IsUndefined(proto)) {
        /* Fallback for the brief window before mik__result_init has run.
         * Shouldn't happen in practice because the module is inited eagerly
         * at the top of MIK_NewRuntimeInternal. */
        return JS_NewObject(ctx);
    }
    return JS_NewObjectProto(ctx, proto);
}

JSValue mik__result_ok(JSContext* ctx, JSValue value) {
    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_TRUE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "value", value, JS_PROP_C_W_E);
    return obj;
}

JSValue mik__result_ok_void(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    if (rt && !JS_IsUndefined(rt->result_ok_void_singleton)) {
        return JS_DupValue(ctx, rt->result_ok_void_singleton);
    }
    /* Fallback for the brief window before mik__result_init has run. */
    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_TRUE, JS_PROP_C_W_E);
    return obj;
}

JSValue mik__result_err(JSContext* ctx, int code, int platform_errno, const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char msg[256];
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "code", JS_NewInt32(ctx, code), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "message", JS_NewString(ctx, msg), JS_PROP_C_W_E);
    if (platform_errno) {
        JS_DefinePropertyValueStr(ctx, error, "errno", JS_NewInt32(ctx, platform_errno),
                                  JS_PROP_C_W_E);
    }

    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", error, JS_PROP_C_W_E);
    return obj;
}

JSValue mik__result_err_named(JSContext* ctx, const char* name, const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char msg[256];
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, name), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "message", JS_NewString(ctx, msg), JS_PROP_C_W_E);

    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", error, JS_PROP_C_W_E);
    return obj;
}

JSValue mik__result_err_tag(JSContext* ctx, const char* name) {
    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, name), JS_PROP_C_W_E);

    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", error, JS_PROP_C_W_E);
    return obj;
}

JSValue mik__result_err_obj(JSContext* ctx, JSValue error_obj) {
    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", error_obj, JS_PROP_C_W_E);
    return obj;
}

/* ── Factory functions exported as `ok` / `err` ─────────────────── */

static JSValue js_result_ok(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc == 0) {
        return mik__result_ok_void(ctx);
    }
    return mik__result_ok(ctx, JS_DupValue(ctx, argv[0]));
}

static JSValue js_result_err(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error",
                              argc > 0 ? JS_DupValue(ctx, argv[0]) : JS_UNDEFINED,
                              JS_PROP_C_W_E);
    return obj;
}

/* ── Prototype method helpers ───────────────────────────────────── */

static inline bool result_is_ok(JSContext* ctx, JSValue this_val) {
    JSValue ok_val = JS_GetPropertyStr(ctx, this_val, "ok");
    bool is_ok = JS_ToBool(ctx, ok_val) != 0;
    JS_FreeValue(ctx, ok_val);
    return is_ok;
}

static JSValue result_get_value(JSContext* ctx, JSValue this_val) {
    return JS_GetPropertyStr(ctx, this_val, "value");
}

static JSValue result_get_error(JSContext* ctx, JSValue this_val) {
    return JS_GetPropertyStr(ctx, this_val, "error");
}

/* ── Prototype methods ──────────────────────────────────────────── */

/* .map(fn) — apply fn to value if ok, else pass through */
static JSValue js_result_map(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!result_is_ok(ctx, this_val)) {
        return JS_DupValue(ctx, this_val);
    }
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "Result.map: expected a function");
    }
    JSValue value = result_get_value(ctx, this_val);
    JSValue mapped = JS_Call(ctx, argv[0], JS_UNDEFINED, 1, &value);
    JS_FreeValue(ctx, value);
    if (JS_IsException(mapped)) return JS_EXCEPTION;
    return mik__result_ok(ctx, mapped);
}

/* .mapErr(fn) — apply fn to error if err, else pass through */
static JSValue js_result_map_err(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (result_is_ok(ctx, this_val)) {
        return JS_DupValue(ctx, this_val);
    }
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "Result.mapErr: expected a function");
    }
    JSValue error = result_get_error(ctx, this_val);
    JSValue mapped = JS_Call(ctx, argv[0], JS_UNDEFINED, 1, &error);
    JS_FreeValue(ctx, error);
    if (JS_IsException(mapped)) return JS_EXCEPTION;
    JSValue obj = new_result_obj(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", mapped, JS_PROP_C_W_E);
    return obj;
}

/* .andThen(fn) — if ok, call fn(value) and return its result; else pass through */
static JSValue js_result_and_then(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!result_is_ok(ctx, this_val)) {
        return JS_DupValue(ctx, this_val);
    }
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "Result.andThen: expected a function");
    }
    JSValue value = result_get_value(ctx, this_val);
    JSValue next = JS_Call(ctx, argv[0], JS_UNDEFINED, 1, &value);
    JS_FreeValue(ctx, value);
    return next;
}

/* .match({ok, err}) — dispatch to the appropriate handler */
static JSValue js_result_match(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "Result.match: expected {ok, err} handlers");
    }
    const char* key = result_is_ok(ctx, this_val) ? "ok" : "err";
    JSValue handler = JS_GetPropertyStr(ctx, argv[0], key);
    if (!JS_IsFunction(ctx, handler)) {
        JS_FreeValue(ctx, handler);
        return JS_ThrowTypeError(ctx, "Result.match: missing '%s' handler", key);
    }
    JSValue payload =
        result_is_ok(ctx, this_val) ? result_get_value(ctx, this_val) : result_get_error(ctx, this_val);
    JSValue ret = JS_Call(ctx, handler, JS_UNDEFINED, 1, &payload);
    JS_FreeValue(ctx, payload);
    JS_FreeValue(ctx, handler);
    return ret;
}

/* .orDefault(d) — value if ok, else d */
static JSValue js_result_or_default(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (result_is_ok(ctx, this_val)) {
        return result_get_value(ctx, this_val);
    }
    return argc > 0 ? JS_DupValue(ctx, argv[0]) : JS_UNDEFINED;
}

/* .orPanic(msg) — value if ok, else throw an Error(name=PanicError, cause=error) */
static JSValue js_result_or_panic(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (result_is_ok(ctx, this_val)) {
        return result_get_value(ctx, this_val);
    }
    JSValue panic = JS_NewError(ctx);
    const char* msg = NULL;
    if (argc > 0) {
        msg = JS_ToCString(ctx, argv[0]);
    }
    JS_DefinePropertyValueStr(ctx, panic, "message",
                              JS_NewString(ctx, msg ? msg : "panic"),
                              JS_PROP_C_W_E);
    if (msg) JS_FreeCString(ctx, msg);
    JS_DefinePropertyValueStr(ctx, panic, "name", JS_NewString(ctx, "PanicError"),
                              JS_PROP_C_W_E);
    JSValue cause = result_get_error(ctx, this_val);
    JS_DefinePropertyValueStr(ctx, panic, "cause", cause, JS_PROP_C_W_E);
    return JS_Throw(ctx, panic);
}

/* Symbol.for('mikrojs.inspect')(depth, inspect) — matches the TS output
 * ("Ok<value>" / "Err<error>") so console.log stays unchanged. */
static JSValue js_result_inspect(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc < 2 || !JS_IsFunction(ctx, argv[1])) {
        return JS_NewString(ctx, result_is_ok(ctx, this_val) ? "Ok<?>" : "Err<?>");
    }

    bool is_ok = result_is_ok(ctx, this_val);
    JSValue inner =
        is_ok ? result_get_value(ctx, this_val) : result_get_error(ctx, this_val);
    JSValue inner_str = JS_Call(ctx, argv[1], JS_UNDEFINED, 1, &inner);
    JS_FreeValue(ctx, inner);
    if (JS_IsException(inner_str)) return JS_EXCEPTION;

    const char* s = JS_ToCString(ctx, inner_str);
    JS_FreeValue(ctx, inner_str);
    if (!s) return JS_EXCEPTION;

    char buf[256];
    snprintf(buf, sizeof(buf), "%s<%s>", is_ok ? "Ok" : "Err", s);
    JS_FreeCString(ctx, s);
    return JS_NewString(ctx, buf);
}

/* ── Prototype assembly ─────────────────────────────────────────── */

static void mik__result_install_methods(JSContext* ctx, JSValue proto) {
    struct {
        const char* name;
        JSCFunction* fn;
        int length;
    } methods[] = {
        {"map", js_result_map, 1},          {"mapErr", js_result_map_err, 1},
        {"andThen", js_result_and_then, 1}, {"match", js_result_match, 1},
        {"orDefault", js_result_or_default, 1}, {"orPanic", js_result_or_panic, 1},
    };
    for (const auto& m : methods) {
        JS_DefinePropertyValueStr(ctx, proto, m.name,
                                  JS_NewCFunction(ctx, m.fn, m.name, m.length),
                                  JS_PROP_C_W_E);
    }

    /* Symbol.for('mikrojs.inspect') */
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue symbol_ctor = JS_GetPropertyStr(ctx, global, "Symbol");
    JS_FreeValue(ctx, global);
    JSValue symbol_for = JS_GetPropertyStr(ctx, symbol_ctor, "for");
    JS_FreeValue(ctx, symbol_ctor);
    JSValue key_str = JS_NewString(ctx, "mikrojs.inspect");
    JSValue inspect_sym = JS_Call(ctx, symbol_for, JS_UNDEFINED, 1, &key_str);
    JS_FreeValue(ctx, key_str);
    JS_FreeValue(ctx, symbol_for);
    if (!JS_IsException(inspect_sym)) {
        JSAtom atom = JS_ValueToAtom(ctx, inspect_sym);
        JS_FreeValue(ctx, inspect_sym);
        JS_DefinePropertyValue(
            ctx, proto, atom,
            JS_NewCFunction(ctx, js_result_inspect, "[mikrojs.inspect]", 2),
            JS_PROP_C_W_E);
        JS_FreeAtom(ctx, atom);
    }
}

/* ── Module init ────────────────────────────────────────────────── */

static int mik__result_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "ok", JS_NewCFunction(ctx, js_result_ok, "ok", 1));
    JS_SetModuleExport(ctx, m, "err", JS_NewCFunction(ctx, js_result_err, "err", 1));
    return 0;
}

JSModuleDef* mik__result_init(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    if (rt && JS_IsUndefined(rt->result_proto)) {
        JSValue proto = JS_NewObject(ctx);
        mik__result_install_methods(ctx, proto);
        rt->result_proto = proto;

        /* Build the frozen {ok: true} singleton used by every mik__result_ok_void
         * call. Freezing makes mutation throw in strict mode and blocks added
         * properties, so a single shared instance is safe. */
        JSValue singleton = JS_NewObjectProto(ctx, proto);
        JS_DefinePropertyValueStr(ctx, singleton, "ok", JS_TRUE, JS_PROP_C_W_E);
        JS_FreezeObject(ctx, singleton);
        rt->result_ok_void_singleton = singleton;
    }

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/result", mik__result_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "ok");
    JS_AddModuleExport(ctx, m, "err");
    return m;
}

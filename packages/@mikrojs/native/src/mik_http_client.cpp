/*
 * Native implementation of the `mikro/http/helpers` and `mikro/http/request`
 * builtins (formerly TypeScript bundled to bytecode; ~17 KB heap per import).
 * The transport stays behind `native:mikro/http` and is resolved through the
 * module loader, so virtual-module overrides (simulator stubs, host test
 * fakes) keep working. Behavior is pinned by test/http_client_test.cpp; the
 * TS sources in runtime/http/ remain as the type surface and Node-side double.
 */

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <mikrojs/utils.h>

#include <string.h>

#include <string>

#include "quickjs.h"

namespace {

/* obj.method(args) with atom lifecycle handled. Borrows obj and args. */
JSValue hc_invoke(JSContext* ctx, JSValue obj, const char* method, int argc, JSValue* argv) {
    JSAtom atom = JS_NewAtom(ctx, method);
    JSValue r = JS_Invoke(ctx, obj, atom, argc, argv);
    JS_FreeAtom(ctx, atom);
    return r;
}

/* Call settle function `fn` (borrowed) with `arg` (consumed). */
void hc_settle(JSContext* ctx, JSValue fn, JSValue arg) {
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, arg);
}

/* Convert the pending exception into a rejected promise. The TS originals
 * were async methods, so failures must reject, never throw synchronously. */
JSValue hc_reject_pending_exception(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    return MIK_NewRejectedPromise(ctx, 1, &exc);
}

/* {done, value} iterator-result object. Consumes `value`. */
JSValue hc_iter_result(JSContext* ctx, bool done, JSValue value) {
    JSValue o = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, o, "done", JS_NewBool(ctx, done), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "value", value, JS_PROP_C_W_E);
    return o;
}

JSAtom hc_async_iterator_atom(JSContext* ctx) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue sym_ctor = JS_GetPropertyStr(ctx, g, "Symbol");
    JSValue sym = JS_GetPropertyStr(ctx, sym_ctor, "asyncIterator");
    JSAtom atom = JS_ValueToAtom(ctx, sym);
    JS_FreeValue(ctx, sym);
    JS_FreeValue(ctx, sym_ctor);
    JS_FreeValue(ctx, g);
    return atom;
}

/* source[Symbol.asyncIterator]() — returns the iterator (owned) or exception. */
JSValue hc_get_async_iterator(JSContext* ctx, JSValue source) {
    JSAtom atom = hc_async_iterator_atom(ctx);
    JSValue fn = JS_GetProperty(ctx, source, atom);
    JS_FreeAtom(ctx, atom);
    if (JS_IsException(fn)) return fn;
    JSValue it = JS_Call(ctx, fn, source, 0, nullptr);
    JS_FreeValue(ctx, fn);
    return it;
}

/* Promise.resolve(v) — normalizes thenables and plain values. Consumes `v`. */
JSValue hc_promise_resolve(JSContext* ctx, JSValue v) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue promise_ctor = JS_GetPropertyStr(ctx, g, "Promise");
    JS_FreeValue(ctx, g);
    JSValue p = hc_invoke(ctx, promise_ctor, "resolve", 1, &v);
    JS_FreeValue(ctx, promise_ctor);
    JS_FreeValue(ctx, v);
    return p;
}

/* p.then(on_fulfilled, on_rejected). Consumes both handlers; borrows `p`. */
void hc_then2(JSContext* ctx, JSValue p, JSValue on_fulfilled, JSValue on_rejected) {
    JSValue args[2] = {on_fulfilled, on_rejected};
    JSValue derived = hc_invoke(ctx, p, "then", 2, args);
    JS_FreeValue(ctx, derived);
    JS_FreeValue(ctx, on_fulfilled);
    JS_FreeValue(ctx, on_rejected);
}

bool hc_get_flag(JSContext* ctx, JSValue st, const char* name) {
    JSValue v = JS_GetPropertyStr(ctx, st, name);
    bool b = JS_ToBool(ctx, v) > 0;
    JS_FreeValue(ctx, v);
    return b;
}

void hc_set_flag(JSContext* ctx, JSValue st, const char* name, bool v) {
    JS_SetPropertyStr(ctx, st, name, JS_NewBool(ctx, v));
}

/* `e instanceof Error ? e.message : String(e)` */
std::string hc_error_message(JSContext* ctx, JSValue e) {
    JSValue mv = JS_UNDEFINED;
    if (JS_IsError(e)) {
        mv = JS_GetPropertyStr(ctx, e, "message");
    }
    const char* s = JS_ToCString(ctx, JS_IsUndefined(mv) ? e : mv);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, mv);
    return out;
}

/* `msg.message || fallback` with JS falsy semantics for the string case. */
std::string hc_message_or(JSContext* ctx, JSValue msg_obj, const std::string& fallback) {
    JSValue mv = JS_GetPropertyStr(ctx, msg_obj, "message");
    if (JS_IsUndefined(mv) || JS_IsNull(mv)) {
        JS_FreeValue(ctx, mv);
        return fallback;
    }
    const char* s = JS_ToCString(ctx, mv);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, mv);
    if (out.empty()) return fallback;
    return out;
}

/* `String(signal.reason ?? 'aborted')`; "aborted" when signal is undefined. */
std::string hc_abort_reason(JSContext* ctx, JSValue signal) {
    if (!JS_IsObject(signal)) return "aborted";
    JSValue reason = JS_GetPropertyStr(ctx, signal, "reason");
    if (JS_IsUndefined(reason) || JS_IsNull(reason)) {
        JS_FreeValue(ctx, reason);
        return "aborted";
    }
    const char* s = JS_ToCString(ctx, reason);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, reason);
    return out;
}

/* ── BodyConsumedError ──────────────────────────────────────────────────── */

/* new.target is deliberately ignored: subclassing BodyConsumedError is out
 * of scope (minus-100) — instances always get BodyConsumedError.prototype. */
JSValue hc_body_consumed_ctor_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message",
                              JS_NewString(ctx, "response body already consumed"),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, e, "name", JS_NewString(ctx, "BodyConsumed"), JS_PROP_C_W_E);
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!JS_IsUndefined(mik_rt->http_body_consumed_ctor)) {
        JSValue proto = JS_GetPropertyStr(ctx, mik_rt->http_body_consumed_ctor, "prototype");
        JS_SetPrototype(ctx, e, proto);
        JS_FreeValue(ctx, proto);
    }
    return e;
}

/* Lazily create the shared BodyConsumedError constructor; returns a dup. */
JSValue hc_body_consumed_ctor(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!JS_IsUndefined(mik_rt->http_body_consumed_ctor)) {
        return JS_DupValue(ctx, mik_rt->http_body_consumed_ctor);
    }
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue error_ctor = JS_GetPropertyStr(ctx, g, "Error");
    JSValue error_proto = JS_GetPropertyStr(ctx, error_ctor, "prototype");
    JS_FreeValue(ctx, error_ctor);
    JS_FreeValue(ctx, g);

    JSValue proto = JS_NewObjectProto(ctx, error_proto);
    JS_FreeValue(ctx, error_proto);
    JSValue ctor = JS_NewCFunction2(ctx, hc_body_consumed_ctor_cf, "BodyConsumedError", 0,
                                    JS_CFUNC_constructor, 0);
    JS_DefinePropertyValueStr(ctx, proto, "constructor", JS_DupValue(ctx, ctor),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_DefinePropertyValueStr(ctx, ctor, "prototype", proto, 0);

    mik_rt->http_body_consumed_ctor = JS_DupValue(ctx, ctor);
    return ctor;
}

/* Throw a fresh BodyConsumedError instance. Always returns JS_EXCEPTION. */
JSValue hc_throw_body_consumed(JSContext* ctx) {
    JSValue ctor = hc_body_consumed_ctor(ctx);
    JSValue e = JS_CallConstructor(ctx, ctor, 0, nullptr);
    JS_FreeValue(ctx, ctor);
    if (JS_IsException(e)) return e;
    return JS_Throw(ctx, e);
}

/* ── RequestError factories ─────────────────────────────────────────────── */

enum {
    RE_HARDWARE,
    RE_NETWORK,
    RE_TIMEOUT,
    RE_BODY_TOO_LARGE,
    RE_INVALID_RESPONSE,
    RE_ABORTED,
    RE_TOO_MANY_PENDING,
    RE_INVALID_JSON,
};

const char* const kRequestErrorNames[] = {
    "Hardware", "Network", "Timeout", "BodyTooLarge",
    "InvalidResponse", "Aborted", "TooManyPending", "InvalidJson",
};

JSValue hc_request_error_factory(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                                 int magic) {
    (void)this_val;
    JSValue o = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, o, "name", JS_NewString(ctx, kRequestErrorNames[magic]),
                              JS_PROP_C_W_E);
    if (magic == RE_TOO_MANY_PENDING) return o;
    if (magic == RE_BODY_TOO_LARGE) {
        JS_DefinePropertyValueStr(ctx, o, "size",
                                  JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED),
                                  JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, o, "cap",
                                  JS_DupValue(ctx, argc > 1 ? argv[1] : JS_UNDEFINED),
                                  JS_PROP_C_W_E);
        return o;
    }
    JS_DefinePropertyValueStr(ctx, o, "message",
                              JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED), JS_PROP_C_W_E);
    return o;
}

JSValue hc_make_request_error_obj(JSContext* ctx) {
    JSValue re = JS_NewObject(ctx);
    static const struct {
        const char* prop;
        int magic;
        int length;
    } kFactories[] = {
        {"Hardware", RE_HARDWARE, 1},
        {"Network", RE_NETWORK, 1},
        {"Timeout", RE_TIMEOUT, 1},
        {"BodyTooLarge", RE_BODY_TOO_LARGE, 2},
        {"InvalidResponse", RE_INVALID_RESPONSE, 1},
        {"Aborted", RE_ABORTED, 1},
        {"TooManyPending", RE_TOO_MANY_PENDING, 0},
        {"InvalidJson", RE_INVALID_JSON, 1},
    };
    for (const auto& f : kFactories) {
        JS_DefinePropertyValueStr(
            ctx, re, f.prop,
            JS_NewCFunctionMagic(ctx, hc_request_error_factory, f.prop, f.length,
                                 JS_CFUNC_generic_magic, f.magic),
            JS_PROP_C_W_E);
    }
    return re;
}

/* ── prepareBody ────────────────────────────────────────────────────────── */

/* Normalize headers into a fresh [k, v][] array. Borrows `input`. */
JSValue hc_normalize_headers(JSContext* ctx, JSValue input) {
    JSValue out = JS_NewArray(ctx);
    if (!JS_IsObject(input)) return out;
    uint32_t out_idx = 0;
    if (JS_IsArray(input)) {
        JSValue len_v = JS_GetPropertyStr(ctx, input, "length");
        uint32_t len = 0;
        JS_ToUint32(ctx, &len, len_v);
        JS_FreeValue(ctx, len_v);
        for (uint32_t i = 0; i < len; i++) {
            JSValue pair = JS_GetPropertyUint32(ctx, input, i);
            JSValue k = JS_IsException(pair) ? JS_EXCEPTION : JS_GetPropertyUint32(ctx, pair, 0);
            JSValue v = JS_IsException(k) ? JS_EXCEPTION : JS_GetPropertyUint32(ctx, pair, 1);
            JS_FreeValue(ctx, pair);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, k);
                JS_FreeValue(ctx, out);
                return JS_EXCEPTION;
            }
            JSValue tuple = JS_NewArray(ctx);
            JS_DefinePropertyValueUint32(ctx, tuple, 0, k, JS_PROP_C_W_E);
            JS_DefinePropertyValueUint32(ctx, tuple, 1, v, JS_PROP_C_W_E);
            JS_DefinePropertyValueUint32(ctx, out, out_idx++, tuple, JS_PROP_C_W_E);
        }
        return out;
    }
    JSPropertyEnum* tab = nullptr;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &tab, &count, input,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    for (uint32_t i = 0; i < count; i++) {
        JSValue val = JS_GetProperty(ctx, input, tab[i].atom);
        if (JS_IsException(val)) {
            JS_FreePropertyEnum(ctx, tab, count);
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JSValue key = JS_AtomToString(ctx, tab[i].atom);
        JSValue tuple = JS_NewArray(ctx);
        JS_DefinePropertyValueUint32(ctx, tuple, 0, key, JS_PROP_C_W_E);
        JS_DefinePropertyValueUint32(ctx, tuple, 1, val, JS_PROP_C_W_E);
        JS_DefinePropertyValueUint32(ctx, out, out_idx++, tuple, JS_PROP_C_W_E);
    }
    JS_FreePropertyEnum(ctx, tab, count);
    return out;
}

/* Core of prepareBody: {body: Uint8Array|null, headers: [k,v][]}. Borrows opts. */
JSValue hc_prepare_body(JSContext* ctx, JSValue opts) {
    JSValue headers_in =
        JS_IsObject(opts) ? JS_GetPropertyStr(ctx, opts, "headers") : JS_UNDEFINED;
    JSValue headers = JS_IsException(headers_in) ? JS_EXCEPTION
                                                 : hc_normalize_headers(ctx, headers_in);
    JS_FreeValue(ctx, headers_in);
    if (JS_IsException(headers)) return JS_EXCEPTION;

    JSValue body = JS_IsObject(opts) ? JS_GetPropertyStr(ctx, opts, "body") : JS_UNDEFINED;
    if (JS_IsException(body)) {
        JS_FreeValue(ctx, headers);
        return JS_EXCEPTION;
    }
    JSValue out = JS_NewObject(ctx);
    if (JS_IsUndefined(body)) {
        JS_DefinePropertyValueStr(ctx, out, "body", JS_NULL, JS_PROP_C_W_E);
    } else if (JS_IsString(body)) {
        size_t len = 0;
        const char* s = JS_ToCStringLen(ctx, &len, body);
        JSValue arr = JS_NewUint8ArrayCopy(ctx, reinterpret_cast<const uint8_t*>(s), len);
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, body);
        JS_DefinePropertyValueStr(ctx, out, "body", arr, JS_PROP_C_W_E);
    } else {
        JS_DefinePropertyValueStr(ctx, out, "body", body, JS_PROP_C_W_E);
    }
    JS_DefinePropertyValueStr(ctx, out, "headers", headers, JS_PROP_C_W_E);
    return out;
}

JSValue hc_prepare_body_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    return hc_prepare_body(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
}

/* ── Body drain machinery (bytes / text / json) ─────────────────────────── */

enum { DRAIN_BYTES, DRAIN_TEXT, DRAIN_JSON };

/* Drain state object props: it (iterator), arr (chunk array), res/rej
 * (capability settle functions), mode (int). */
void hc_drain_step(JSContext* ctx, JSValue st);

void hc_drain_reject_exception(JSContext* ctx, JSValue st) {
    JSValue exc = JS_GetException(ctx);
    JSValue reject = JS_GetPropertyStr(ctx, st, "rej");
    hc_settle(ctx, reject, exc);
    JS_FreeValue(ctx, reject);
}

/* Best-effort AsyncIteratorClose: call it.return() when present, discard the
 * outcome (marked handled if a promise). Releases foreign-transport resources
 * on early exit; deliberately no await/error propagation. */
void hc_iterator_close(JSContext* ctx, JSValue it) {
    JSValue ret_fn = JS_GetPropertyStr(ctx, it, "return");
    if (!JS_IsFunction(ctx, ret_fn)) {
        if (JS_IsException(ret_fn)) JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, ret_fn);
        return;
    }
    JSValue r = JS_Call(ctx, ret_fn, it, 0, nullptr);
    JS_FreeValue(ctx, ret_fn);
    if (JS_IsException(r)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    if (JS_IsPromise(r)) JS_PromiseMarkAsHandled(ctx, r);
    JS_FreeValue(ctx, r);
}

void hc_drain_finalize(JSContext* ctx, JSValue st) {
    JSValue resolve = JS_GetPropertyStr(ctx, st, "res");
    JSValue arr = JS_GetPropertyStr(ctx, st, "arr");
    JSValue mode_v = JS_GetPropertyStr(ctx, st, "mode");
    int32_t mode = 0;
    JS_ToInt32(ctx, &mode, mode_v);
    JS_FreeValue(ctx, mode_v);

    JSValue len_v = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t nchunks = 0;
    JS_ToUint32(ctx, &nchunks, len_v);
    JS_FreeValue(ctx, len_v);

    if (mode == DRAIN_BYTES && nchunks == 1) {
        /* Single-chunk fast path returns the original array (TS parity). */
        JSValue chunk = JS_GetPropertyUint32(ctx, arr, 0);
        JS_FreeValue(ctx, arr);
        hc_settle(ctx, resolve, mik__result_ok(ctx, chunk));
        JS_FreeValue(ctx, resolve);
        return;
    }

    /* Merge chunks into one contiguous buffer. */
    size_t total = 0;
    for (uint32_t i = 0; i < nchunks; i++) {
        JSValue chunk = JS_GetPropertyUint32(ctx, arr, i);
        size_t sz = 0;
        if (JS_GetUint8Array(ctx, &sz, chunk)) {
            total += sz;
        } else {
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, chunk);
    }
    uint8_t* buf = static_cast<uint8_t*>(js_malloc(ctx, total ? total : 1));
    if (!buf) {
        JS_FreeValue(ctx, arr);
        JS_FreeValue(ctx, resolve);
        hc_drain_reject_exception(ctx, st);
        return;
    }
    size_t off = 0;
    for (uint32_t i = 0; i < nchunks; i++) {
        JSValue chunk = JS_GetPropertyUint32(ctx, arr, i);
        size_t sz = 0;
        uint8_t* p = JS_GetUint8Array(ctx, &sz, chunk);
        if (p && sz) {
            memcpy(buf + off, p, sz);
            off += sz;
        } else if (!p) {
            JSValue exc = JS_GetException(ctx);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, chunk);
    }
    JS_FreeValue(ctx, arr);

    JSValue settled = JS_UNDEFINED;
    if (mode == DRAIN_BYTES) {
        settled = mik__result_ok(ctx, JS_NewUint8ArrayCopy(ctx, buf, total));
    } else {
        /* Decode through the runtime's TextDecoder for exact TS parity
         * (invalid-sequence replacement included). */
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue td_ctor = JS_GetPropertyStr(ctx, g, "TextDecoder");
        JS_FreeValue(ctx, g);
        JSValue td = JS_CallConstructor(ctx, td_ctor, 0, nullptr);
        JS_FreeValue(ctx, td_ctor);
        JSValue u8 = JS_NewUint8ArrayCopy(ctx, buf, total);
        JSValue text = hc_invoke(ctx, td, "decode", 1, &u8);
        JS_FreeValue(ctx, u8);
        JS_FreeValue(ctx, td);
        if (JS_IsException(text)) {
            js_free(ctx, buf);
            JS_FreeValue(ctx, resolve);
            hc_drain_reject_exception(ctx, st);
            return;
        }
        if (mode == DRAIN_TEXT) {
            settled = mik__result_ok(ctx, text);
        } else {
            size_t tlen = 0;
            const char* ts = JS_ToCStringLen(ctx, &tlen, text);
            JSValue parsed = JS_ParseJSON(ctx, ts ? ts : "", tlen, "<json>");
            JS_FreeCString(ctx, ts);
            JS_FreeValue(ctx, text);
            if (JS_IsException(parsed)) {
                JSValue exc = JS_GetException(ctx);
                std::string msg = hc_error_message(ctx, exc);
                JS_FreeValue(ctx, exc);
                settled = mik__result_err_named(ctx, "InvalidJson", "%s", msg.c_str());
            } else {
                settled = mik__result_ok(ctx, parsed);
            }
        }
    }
    js_free(ctx, buf);
    hc_settle(ctx, resolve, settled);
    JS_FreeValue(ctx, resolve);
}

JSValue hc_drain_on_item(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue item = argc > 0 ? argv[0] : JS_UNDEFINED;

    JSValue done_v = JS_GetPropertyStr(ctx, item, "done");
    if (JS_IsException(done_v)) {
        hc_drain_reject_exception(ctx, st);
        return JS_UNDEFINED;
    }
    bool done = JS_ToBool(ctx, done_v) > 0;
    JS_FreeValue(ctx, done_v);
    if (done) {
        hc_drain_finalize(ctx, st);
        return JS_UNDEFINED;
    }

    JSValue r = JS_GetPropertyStr(ctx, item, "value");
    JSValue ok_v = JS_IsException(r) ? JS_EXCEPTION : JS_GetPropertyStr(ctx, r, "ok");
    if (JS_IsException(ok_v)) {
        if (!JS_IsException(r)) JS_FreeValue(ctx, r);
        hc_drain_reject_exception(ctx, st);
        return JS_UNDEFINED;
    }
    bool ok = JS_ToBool(ctx, ok_v) > 0;
    JS_FreeValue(ctx, ok_v);
    if (!ok) {
        /* Early exit on an err item: close the iterator (AsyncIteratorClose
         * parity — a foreign transport may release its slot in return()),
         * then propagate the error Result verbatim. */
        JSValue it = JS_GetPropertyStr(ctx, st, "it");
        hc_iterator_close(ctx, it);
        JS_FreeValue(ctx, it);
        JSValue resolve = JS_GetPropertyStr(ctx, st, "res");
        hc_settle(ctx, resolve, r);
        JS_FreeValue(ctx, resolve);
        return JS_UNDEFINED;
    }
    JSValue chunk = JS_GetPropertyStr(ctx, r, "value");
    JS_FreeValue(ctx, r);
    if (JS_IsException(chunk)) {
        hc_drain_reject_exception(ctx, st);
        return JS_UNDEFINED;
    }
    JSValue arr = JS_GetPropertyStr(ctx, st, "arr");
    JSValue len_v = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, len_v);
    JS_FreeValue(ctx, len_v);
    JS_DefinePropertyValueUint32(ctx, arr, len, chunk, JS_PROP_C_W_E);
    JS_FreeValue(ctx, arr);

    hc_drain_step(ctx, st);
    return JS_UNDEFINED;
}

JSValue hc_drain_on_error(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                          JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue reject = JS_GetPropertyStr(ctx, st, "rej");
    hc_settle(ctx, reject, JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    JS_FreeValue(ctx, reject);
    return JS_UNDEFINED;
}

void hc_drain_step(JSContext* ctx, JSValue st) {
    JSValue it = JS_GetPropertyStr(ctx, st, "it");
    JSValue item_p = hc_invoke(ctx, it, "next", 0, nullptr);
    JS_FreeValue(ctx, it);
    if (JS_IsException(item_p)) {
        hc_drain_reject_exception(ctx, st);
        return;
    }
    JSValue wrapped = hc_promise_resolve(ctx, item_p);
    JSValue on_item = JS_NewCFunctionData(ctx, hc_drain_on_item, 1, 0, 1, &st);
    JSValue on_err = JS_NewCFunctionData(ctx, hc_drain_on_error, 1, 0, 1, &st);
    hc_then2(ctx, wrapped, on_item, on_err);
    JS_FreeValue(ctx, wrapped);
}

/* Start draining `source` (borrowed); returns a promise for the Result. */
JSValue hc_drain(JSContext* ctx, JSValue source, int mode) {
    JSValue it = hc_get_async_iterator(ctx, source);
    if (JS_IsException(it)) return it;

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, it);
        return promise;
    }
    JSValue st = JS_NewObjectProto(ctx, JS_NULL);
    JS_SetPropertyStr(ctx, st, "it", it);
    JS_SetPropertyStr(ctx, st, "arr", JS_NewArray(ctx));
    JS_SetPropertyStr(ctx, st, "res", rfuncs[0]);
    JS_SetPropertyStr(ctx, st, "rej", rfuncs[1]);
    JS_SetPropertyStr(ctx, st, "mode", JS_NewInt32(ctx, mode));
    hc_drain_step(ctx, st);
    JS_FreeValue(ctx, st);
    return promise;
}

/* ── makeResponse ───────────────────────────────────────────────────────── */

/* func_data layout for response methods: [0] = claim state, [1] = raw. */

bool hc_claim(JSContext* ctx, JSValue claim_st) {
    if (hc_get_flag(ctx, claim_st, "consumed")) {
        hc_throw_body_consumed(ctx);
        return false;
    }
    hc_set_flag(ctx, claim_st, "consumed", true);
    return true;
}

JSValue hc_resp_body_iterator_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                                 int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    if (!hc_claim(ctx, func_data[0])) return JS_EXCEPTION;
    JSValue raw_body = JS_GetPropertyStr(ctx, func_data[1], "body");
    JSValue it = hc_get_async_iterator(ctx, raw_body);
    JS_FreeValue(ctx, raw_body);
    return it;
}

JSValue hc_resp_header_get_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                              int magic, JSValue* func_data) {
    (void)this_val;
    bool want_all = magic == 1;
    const char* name = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!name) return JS_EXCEPTION;
    std::string lower(name);
    JS_FreeCString(ctx, name);
    for (auto& c : lower) {
        if (c >= 'A' && c <= 'Z') c += 32;
    }

    JSValue headers = JS_GetPropertyStr(ctx, func_data[1], "headers");
    JSValue len_v = JS_GetPropertyStr(ctx, headers, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, len_v);
    JS_FreeValue(ctx, len_v);

    JSValue out = want_all ? JS_NewArray(ctx) : JS_UNDEFINED;
    uint32_t out_idx = 0;
    for (uint32_t i = 0; i < len; i++) {
        JSValue pair = JS_GetPropertyUint32(ctx, headers, i);
        JSValue k = JS_GetPropertyUint32(ctx, pair, 0);
        const char* ks = JS_ToCString(ctx, k);
        JS_FreeValue(ctx, k);
        if (!ks) {
            JS_FreeValue(ctx, pair);
            JS_FreeValue(ctx, headers);
            if (want_all) JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        std::string klower(ks);
        JS_FreeCString(ctx, ks);
        for (auto& c : klower) {
            if (c >= 'A' && c <= 'Z') c += 32;
        }
        if (klower == lower) {
            JSValue v = JS_GetPropertyUint32(ctx, pair, 1);
            if (want_all) {
                JS_DefinePropertyValueUint32(ctx, out, out_idx++, v, JS_PROP_C_W_E);
            } else {
                JS_FreeValue(ctx, pair);
                JS_FreeValue(ctx, headers);
                return v;
            }
        }
        JS_FreeValue(ctx, pair);
    }
    JS_FreeValue(ctx, headers);
    return out;
}

JSValue hc_resp_drain_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    if (!hc_claim(ctx, func_data[0])) return hc_reject_pending_exception(ctx);
    JSValue raw_body = JS_GetPropertyStr(ctx, func_data[1], "body");
    JSValue p = hc_drain(ctx, raw_body, magic);
    JS_FreeValue(ctx, raw_body);
    if (JS_IsException(p)) return hc_reject_pending_exception(ctx);
    return p;
}

JSValue hc_resp_close_on_done(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                              int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    hc_settle(ctx, func_data[0], JS_UNDEFINED);
    return JS_UNDEFINED;
}

JSValue hc_resp_close_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    hc_set_flag(ctx, func_data[0], "consumed", true);
    JSValue raw_body = JS_GetPropertyStr(ctx, func_data[1], "body");
    JSValue it = hc_get_async_iterator(ctx, raw_body);
    JS_FreeValue(ctx, raw_body);
    if (JS_IsException(it)) return hc_reject_pending_exception(ctx);
    JSValue ret_fn = JS_GetPropertyStr(ctx, it, "return");
    if (!JS_IsFunction(ctx, ret_fn)) {
        JS_FreeValue(ctx, ret_fn);
        JS_FreeValue(ctx, it);
        JSValue undef = JS_UNDEFINED;
        return MIK_NewResolvedPromise(ctx, 1, &undef);
    }
    JSValue r = JS_Call(ctx, ret_fn, it, 0, nullptr);
    JS_FreeValue(ctx, ret_fn);
    JS_FreeValue(ctx, it);
    if (JS_IsException(r)) return hc_reject_pending_exception(ctx);

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, r);
        return promise;
    }
    JSValue wrapped = hc_promise_resolve(ctx, r);
    JSValue on_done = JS_NewCFunctionData(ctx, hc_resp_close_on_done, 1, 0, 1, &rfuncs[0]);
    hc_then2(ctx, wrapped, on_done, JS_DupValue(ctx, rfuncs[1]));
    JS_FreeValue(ctx, wrapped);
    JS_FreeValue(ctx, rfuncs[0]);
    JS_FreeValue(ctx, rfuncs[1]);
    return promise;
}

/* Build the public Response object over `raw`. Borrows `raw`. */
JSValue hc_make_response(JSContext* ctx, JSValue raw) {
    JSValue claim_st = JS_NewObjectProto(ctx, JS_NULL);
    hc_set_flag(ctx, claim_st, "consumed", false);
    JSValue data[2] = {claim_st, raw};

    JSValue resp = JS_NewObject(ctx);
    static const char* const kCopied[] = {"status", "statusText", "url", "redirected", "headers"};
    for (const char* prop : kCopied) {
        JS_DefinePropertyValueStr(ctx, resp, prop, JS_GetPropertyStr(ctx, raw, prop),
                                  JS_PROP_C_W_E);
    }
    JSValue status_v = JS_GetPropertyStr(ctx, raw, "status");
    int32_t status = 0;
    JS_ToInt32(ctx, &status, status_v);
    JS_FreeValue(ctx, status_v);
    JS_DefinePropertyValueStr(ctx, resp, "ok", JS_NewBool(ctx, status >= 200 && status < 300),
                              JS_PROP_C_W_E);

    JSValue body = JS_NewObject(ctx);
    JSAtom iter_atom = hc_async_iterator_atom(ctx);
    JS_DefinePropertyValue(ctx, body, iter_atom,
                           JS_NewCFunctionData(ctx, hc_resp_body_iterator_cf, 0, 0, 2, data),
                           JS_PROP_C_W_E);
    JS_FreeAtom(ctx, iter_atom);
    JS_DefinePropertyValueStr(ctx, resp, "body", body, JS_PROP_C_W_E);

    JS_DefinePropertyValueStr(ctx, resp, "get",
                              JS_NewCFunctionData(ctx, hc_resp_header_get_cf, 1, 0, 2, data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, resp, "getAll",
                              JS_NewCFunctionData(ctx, hc_resp_header_get_cf, 1, 1, 2, data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, resp, "text",
                              JS_NewCFunctionData(ctx, hc_resp_drain_cf, 0, DRAIN_TEXT, 2, data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, resp, "json",
                              JS_NewCFunctionData(ctx, hc_resp_drain_cf, 0, DRAIN_JSON, 2, data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, resp, "bytes",
                              JS_NewCFunctionData(ctx, hc_resp_drain_cf, 0, DRAIN_BYTES, 2, data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, resp, "close",
                              JS_NewCFunctionData(ctx, hc_resp_close_cf, 0, 0, 2, data),
                              JS_PROP_C_W_E);
    JS_FreeValue(ctx, claim_st);
    return resp;
}

JSValue hc_make_response_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    MIK_CHECK_ARG_RET(ctx, argc > 0 && JS_IsObject(argv[0]), 0, "a raw response object");
    return hc_make_response(ctx, argv[0]);
}

/* ── Transport-backed request() ─────────────────────────────────────────── */

/* Request state object props:
 *   ns (transport namespace), id, url, sig (AbortSignal | absent),
 *   hnd (cancel callback | absent), tmr (timer id | absent),
 *   done, clean (booleans). */

void hc_req_cleanup(JSContext* ctx, JSValue st) {
    if (hc_get_flag(ctx, st, "clean")) return;
    hc_set_flag(ctx, st, "clean", true);
    JSValue sig = JS_GetPropertyStr(ctx, st, "sig");
    JSValue hnd = JS_GetPropertyStr(ctx, st, "hnd");
    if (JS_IsObject(sig) && JS_IsFunction(ctx, hnd)) {
        JSValue args[2] = {JS_NewString(ctx, "abort"), hnd};
        JSValue r = hc_invoke(ctx, sig, "removeEventListener", 2, args);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, args[0]);
    }
    JS_FreeValue(ctx, sig);
    JS_FreeValue(ctx, hnd);
    JSValue tmr = JS_GetPropertyStr(ctx, st, "tmr");
    if (!JS_IsUndefined(tmr)) {
        int64_t timer_id = 0;
        JS_ToInt64(ctx, &timer_id, tmr);
        MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
        if (mik_rt->timers) {
            MIK_Timer_UnSchedule(mik_rt->timers, ctx, static_cast<uint32_t>(timer_id));
        }
    }
    JS_FreeValue(ctx, tmr);
    /* Break the st <-> cancel-handler reference cycle so refcounting alone
     * reclaims the request state (the handler's func_data holds st). */
    JS_SetPropertyStr(ctx, st, "hnd", JS_UNDEFINED);
}

/* ns.cancel(id) — used as both the abort listener and the timeout callback. */
JSValue hc_req_cancel_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue st = func_data[0];
    JSValue ns = JS_GetPropertyStr(ctx, st, "ns");
    JSValue id = JS_GetPropertyStr(ctx, st, "id");
    JSValue r = hc_invoke(ctx, ns, "cancel", 1, &id);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, id);
    JS_FreeValue(ctx, ns);
    return JS_UNDEFINED;
}

/* ns.nextMessage(id); returns the message promise (or sync exception). */
JSValue hc_call_next_message(JSContext* ctx, JSValue st) {
    JSValue ns = JS_GetPropertyStr(ctx, st, "ns");
    JSValue id = JS_GetPropertyStr(ctx, st, "id");
    JSValue p = hc_invoke(ctx, ns, "nextMessage", 1, &id);
    JS_FreeValue(ctx, id);
    JS_FreeValue(ctx, ns);
    return p;
}

/* .then handlers for one body next() call. func_data: [0]=state, [1]=resolve. */
JSValue hc_body_on_msg(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                       JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue resolve = func_data[1];
    JSValue msg = argc > 0 ? argv[0] : JS_UNDEFINED;

    JSValue kind_v = JS_GetPropertyStr(ctx, msg, "kind");
    const char* kind = JS_ToCString(ctx, kind_v);
    std::string k(kind ? kind : "");
    JS_FreeCString(ctx, kind);
    JS_FreeValue(ctx, kind_v);

    if (k == "chunk") {
        JSValue data = JS_GetPropertyStr(ctx, msg, "data");
        hc_settle(ctx, resolve, hc_iter_result(ctx, false, mik__result_ok(ctx, data)));
        return JS_UNDEFINED;
    }
    hc_set_flag(ctx, st, "done", true);
    hc_req_cleanup(ctx, st);
    if (k == "end") {
        hc_settle(ctx, resolve, hc_iter_result(ctx, true, JS_UNDEFINED));
        return JS_UNDEFINED;
    }
    JSValue cancelled_v = JS_GetPropertyStr(ctx, msg, "cancelled");
    bool cancelled = JS_ToBool(ctx, cancelled_v) > 0;
    JS_FreeValue(ctx, cancelled_v);
    JSValue err;
    if (cancelled) {
        JSValue sig = JS_GetPropertyStr(ctx, st, "sig");
        std::string fallback = hc_abort_reason(ctx, sig);
        JS_FreeValue(ctx, sig);
        std::string m = hc_message_or(ctx, msg, fallback);
        err = mik__result_err_named(ctx, "Aborted", "%s", m.c_str());
    } else {
        std::string m = hc_message_or(ctx, msg, "HTTP request failed");
        err = mik__result_err_named(ctx, "Network", "%s", m.c_str());
    }
    hc_settle(ctx, resolve, hc_iter_result(ctx, false, err));
    return JS_UNDEFINED;
}

JSValue hc_body_on_msg_err(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                           JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue resolve = func_data[1];
    hc_set_flag(ctx, st, "done", true);
    hc_req_cleanup(ctx, st);
    std::string m = hc_error_message(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    JSValue err = mik__result_err_named(ctx, "Network", "%s", m.c_str());
    hc_settle(ctx, resolve, hc_iter_result(ctx, false, err));
    return JS_UNDEFINED;
}

JSValue hc_body_next_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                        JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue st = func_data[0];
    if (hc_get_flag(ctx, st, "done")) {
        JSValue done = hc_iter_result(ctx, true, JS_UNDEFINED);
        return MIK_NewResolvedPromise(ctx, 1, &done);
    }
    JSValue msg_p = hc_call_next_message(ctx, st);
    if (JS_IsException(msg_p)) {
        /* Sync throw from the transport maps to a Network err item. */
        hc_set_flag(ctx, st, "done", true);
        hc_req_cleanup(ctx, st);
        JSValue exc = JS_GetException(ctx);
        std::string m = hc_error_message(ctx, exc);
        JS_FreeValue(ctx, exc);
        JSValue item =
            hc_iter_result(ctx, false, mik__result_err_named(ctx, "Network", "%s", m.c_str()));
        return MIK_NewResolvedPromise(ctx, 1, &item);
    }
    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, msg_p);
        return promise;
    }
    JSValue data[2] = {st, rfuncs[0]};
    JSValue on_msg = JS_NewCFunctionData(ctx, hc_body_on_msg, 1, 0, 2, data);
    JSValue on_err = JS_NewCFunctionData(ctx, hc_body_on_msg_err, 1, 0, 2, data);
    JS_FreeValue(ctx, rfuncs[0]);
    JS_FreeValue(ctx, rfuncs[1]);
    JSValue wrapped = hc_promise_resolve(ctx, msg_p);
    hc_then2(ctx, wrapped, on_msg, on_err);
    JS_FreeValue(ctx, wrapped);
    return promise;
}

/* return(): cancel, then drain messages until a non-chunk arrives.
 * hc_return_drain_step consumes `resolve`. */
void hc_return_drain_step(JSContext* ctx, JSValue st, JSValue resolve);

JSValue hc_return_on_msg(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue resolve = func_data[1];
    JSValue kind_v = JS_GetPropertyStr(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, "kind");
    const char* kind = JS_ToCString(ctx, kind_v);
    bool is_chunk = kind && strcmp(kind, "chunk") == 0;
    JS_FreeCString(ctx, kind);
    JS_FreeValue(ctx, kind_v);
    if (is_chunk) {
        hc_return_drain_step(ctx, st, JS_DupValue(ctx, resolve));
    } else {
        hc_settle(ctx, resolve, hc_iter_result(ctx, true, JS_UNDEFINED));
    }
    return JS_UNDEFINED;
}

JSValue hc_return_on_err(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    hc_settle(ctx, func_data[1], hc_iter_result(ctx, true, JS_UNDEFINED));
    return JS_UNDEFINED;
}

void hc_return_drain_step(JSContext* ctx, JSValue st, JSValue resolve) {
    JSValue msg_p = hc_call_next_message(ctx, st);
    if (JS_IsException(msg_p)) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        hc_settle(ctx, resolve, hc_iter_result(ctx, true, JS_UNDEFINED));
        JS_FreeValue(ctx, resolve);
        return;
    }
    JSValue data[2] = {st, resolve};
    JSValue on_msg = JS_NewCFunctionData(ctx, hc_return_on_msg, 1, 0, 2, data);
    JSValue on_err = JS_NewCFunctionData(ctx, hc_return_on_err, 1, 0, 2, data);
    JS_FreeValue(ctx, resolve);
    JSValue wrapped = hc_promise_resolve(ctx, msg_p);
    hc_then2(ctx, wrapped, on_msg, on_err);
    JS_FreeValue(ctx, wrapped);
}

JSValue hc_body_return_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                          JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue st = func_data[0];
    if (hc_get_flag(ctx, st, "done")) {
        JSValue done = hc_iter_result(ctx, true, JS_UNDEFINED);
        return MIK_NewResolvedPromise(ctx, 1, &done);
    }
    hc_set_flag(ctx, st, "done", true);
    hc_req_cleanup(ctx, st);
    JSValue ns = JS_GetPropertyStr(ctx, st, "ns");
    JSValue id = JS_GetPropertyStr(ctx, st, "id");
    JSValue r = hc_invoke(ctx, ns, "cancel", 1, &id);
    JS_FreeValue(ctx, id);
    JS_FreeValue(ctx, ns);
    if (JS_IsException(r)) return r;
    JS_FreeValue(ctx, r);

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) return promise;
    JS_FreeValue(ctx, rfuncs[1]);
    hc_return_drain_step(ctx, st, rfuncs[0]);
    return promise;
}

/* Iterable body object for the transport: fresh iterators share the request
 * state, matching the TS closure semantics. */
JSValue hc_transport_iterator_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                                 int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue it = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, it, "next",
                              JS_NewCFunctionData(ctx, hc_body_next_cf, 0, 0, 1, func_data),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, it, "return",
                              JS_NewCFunctionData(ctx, hc_body_return_cf, 0, 0, 1, func_data),
                              JS_PROP_C_W_E);
    return it;
}

/* start.headers settle handlers. func_data: [0]=state, [1]=resolve, [2]=reject. */
JSValue hc_on_headers(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue resolve = func_data[1];
    JSValue hr = argc > 0 ? argv[0] : JS_UNDEFINED;

    JSValue ok_v = JS_GetPropertyStr(ctx, hr, "ok");
    if (JS_IsException(ok_v)) {
        /* A throwing getter on a broken transport rejects instead of leaving
         * the exception armed past this callback. */
        hc_req_cleanup(ctx, st);
        hc_settle(ctx, func_data[2], JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    bool ok = JS_ToBool(ctx, ok_v) > 0;
    JS_FreeValue(ctx, ok_v);
    if (!ok) {
        hc_req_cleanup(ctx, st);
        hc_settle(ctx, resolve, JS_DupValue(ctx, hr));
        return JS_UNDEFINED;
    }

    JSValue hv = JS_GetPropertyStr(ctx, hr, "value");
    if (JS_IsException(hv)) {
        hc_req_cleanup(ctx, st);
        hc_settle(ctx, func_data[2], JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    JSValue status = JS_GetPropertyStr(ctx, hv, "status");
    JSValue resp_headers = JS_GetPropertyStr(ctx, hv, "headers");
    JS_FreeValue(ctx, hv);
    if (JS_IsException(status) || JS_IsException(resp_headers)) {
        JS_FreeValue(ctx, status);
        JS_FreeValue(ctx, resp_headers);
        hc_req_cleanup(ctx, st);
        hc_settle(ctx, func_data[2], JS_GetException(ctx));
        return JS_UNDEFINED;
    }

    JSValue raw_body = JS_NewObject(ctx);
    JSAtom iter_atom = hc_async_iterator_atom(ctx);
    JS_DefinePropertyValue(ctx, raw_body, iter_atom,
                           JS_NewCFunctionData(ctx, hc_transport_iterator_cf, 0, 0, 1, &st),
                           JS_PROP_C_W_E);
    JS_FreeAtom(ctx, iter_atom);

    JSValue raw = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, raw, "status", status, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, raw, "statusText", JS_NewString(ctx, ""), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, raw, "url", JS_GetPropertyStr(ctx, st, "url"), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, raw, "redirected", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, raw, "headers", resp_headers, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, raw, "body", raw_body, JS_PROP_C_W_E);

    JSValue resp = hc_make_response(ctx, raw);
    JS_FreeValue(ctx, raw);
    hc_settle(ctx, resolve, mik__result_ok(ctx, resp));
    return JS_UNDEFINED;
}

JSValue hc_on_headers_rejected(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                               int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    hc_req_cleanup(ctx, func_data[0]);
    hc_settle(ctx, func_data[2], JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    return JS_UNDEFINED;
}

/* request(url, options?) — func_data: [0]=transport namespace. */
JSValue hc_request_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue ns = func_data[0];
    JSValue url = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValue options = argc > 1 && JS_IsObject(argv[1]) ? argv[1] : JS_UNDEFINED;

    /* Pre-aborted signal short-circuits without touching the transport. */
    JSValue signal =
        JS_IsObject(options) ? JS_GetPropertyStr(ctx, options, "signal") : JS_UNDEFINED;
    if (JS_IsException(signal)) {
        return hc_reject_pending_exception(ctx);
    }
    if (JS_IsObject(signal)) {
        JSValue aborted = JS_GetPropertyStr(ctx, signal, "aborted");
        bool is_aborted = JS_ToBool(ctx, aborted) > 0;
        JS_FreeValue(ctx, aborted);
        if (is_aborted) {
            std::string reason = hc_abort_reason(ctx, signal);
            JS_FreeValue(ctx, signal);
            JSValue err = mik__result_err_named(ctx, "Aborted", "%s", reason.c_str());
            return MIK_NewResolvedPromise(ctx, 1, &err);
        }
    }

    JSValue prepared = hc_prepare_body(ctx, options);
    if (JS_IsException(prepared)) {
        /* Getter/iterator throws from caller options reject (async parity). */
        JS_FreeValue(ctx, signal);
        return hc_reject_pending_exception(ctx);
    }
    JSValue body = JS_GetPropertyStr(ctx, prepared, "body");
    JSValue headers = JS_GetPropertyStr(ctx, prepared, "headers");
    JS_FreeValue(ctx, prepared);

    JSValue method_in =
        JS_IsObject(options) ? JS_GetPropertyStr(ctx, options, "method") : JS_UNDEFINED;
    JSValue method;
    if (JS_IsUndefined(method_in) || JS_IsNull(method_in)) {
        JS_FreeValue(ctx, method_in);
        method = JS_NewString(ctx, "GET");
    } else {
        method = hc_invoke(ctx, method_in, "toUpperCase", 0, nullptr);
        JS_FreeValue(ctx, method_in);
        if (JS_IsException(method)) {
            JS_FreeValue(ctx, body);
            JS_FreeValue(ctx, headers);
            JS_FreeValue(ctx, signal);
            JSValue exc = JS_GetException(ctx);
            return MIK_NewRejectedPromise(ctx, 1, &exc);
        }
    }

    JSValue transport_opts = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, transport_opts, "method", method, JS_PROP_C_W_E);
    if (!JS_IsNull(body)) {
        JS_DefinePropertyValueStr(ctx, transport_opts, "body", body, JS_PROP_C_W_E);
    } else {
        JS_FreeValue(ctx, body);
    }
    JS_DefinePropertyValueStr(ctx, transport_opts, "headers", headers, JS_PROP_C_W_E);

    JSValue req_args[2] = {url, transport_opts};
    JSValue start = hc_invoke(ctx, ns, "request", 2, req_args);
    JS_FreeValue(ctx, transport_opts);
    if (JS_IsException(start)) {
        JS_FreeValue(ctx, signal);
        JSValue exc = JS_GetException(ctx);
        return MIK_NewRejectedPromise(ctx, 1, &exc);
    }

    JSValue start_ok = JS_GetPropertyStr(ctx, start, "ok");
    bool ok = JS_ToBool(ctx, start_ok) > 0;
    JS_FreeValue(ctx, start_ok);
    if (!ok) {
        JS_FreeValue(ctx, signal);
        return MIK_NewResolvedPromise(ctx, 1, &start);
    }

    JSValue st = JS_NewObjectProto(ctx, JS_NULL);
    JS_SetPropertyStr(ctx, st, "ns", JS_DupValue(ctx, ns));
    JS_SetPropertyStr(ctx, st, "id", JS_GetPropertyStr(ctx, start, "id"));
    JS_SetPropertyStr(ctx, st, "url", JS_DupValue(ctx, url));
    hc_set_flag(ctx, st, "done", false);
    hc_set_flag(ctx, st, "clean", false);

    JSValue timeout_v =
        JS_IsObject(options) ? JS_GetPropertyStr(ctx, options, "timeoutMs") : JS_UNDEFINED;
    if (JS_IsException(timeout_v)) {
        /* TS parity: a throwing timeoutMs getter rejects the request; the
         * already-started transport request is not cancelled, as in TS. */
        JS_FreeValue(ctx, signal);
        JS_FreeValue(ctx, start);
        JS_FreeValue(ctx, st);
        return hc_reject_pending_exception(ctx);
    }
    /* The plain request(url) fast path never allocates the cancel closure. */
    if (!JS_IsUndefined(timeout_v) || JS_IsObject(signal)) {
        JSValue cancel_fn = JS_NewCFunctionData(ctx, hc_req_cancel_cf, 0, 0, 1, &st);
        if (!JS_IsUndefined(timeout_v)) {
            int64_t timeout_ms = 0;
            if (JS_ToInt64(ctx, &timeout_ms, timeout_v) < 0) {
                JS_FreeValue(ctx, cancel_fn);
                JS_FreeValue(ctx, timeout_v);
                JS_FreeValue(ctx, signal);
                JS_FreeValue(ctx, start);
                JS_FreeValue(ctx, st);
                return hc_reject_pending_exception(ctx);
            }
            MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
            /* Null during teardown only; unreachable from the loop, guarded
             * for consistency with wc_connect_on_result. */
            if (mik_rt->timers) {
                uint32_t timer_id = MIK_Timer_Schedule(mik_rt->timers, ctx, cancel_fn, 0, nullptr,
                                                       timeout_ms * 1000, false,
                                                       MIK_GetPlatform()->get_boot_us());
                JS_SetPropertyStr(ctx, st, "tmr", JS_NewInt64(ctx, timer_id));
            }
        }
        if (JS_IsObject(signal)) {
            JS_SetPropertyStr(ctx, st, "sig", JS_DupValue(ctx, signal));
            JS_SetPropertyStr(ctx, st, "hnd", JS_DupValue(ctx, cancel_fn));
            JSValue add_args[2] = {JS_NewString(ctx, "abort"), cancel_fn};
            JSValue r = hc_invoke(ctx, signal, "addEventListener", 2, add_args);
            JS_FreeValue(ctx, add_args[0]);
            if (JS_IsException(r)) {
                /* TS parity: an addEventListener throw rejects the request.
                 * An already-armed timeout timer stays armed, as in TS. */
                JS_FreeValue(ctx, cancel_fn);
                JS_FreeValue(ctx, timeout_v);
                JS_FreeValue(ctx, signal);
                JS_FreeValue(ctx, start);
                JS_FreeValue(ctx, st);
                return hc_reject_pending_exception(ctx);
            }
            JS_FreeValue(ctx, r);
        }
        JS_FreeValue(ctx, cancel_fn);
    }
    JS_FreeValue(ctx, timeout_v);
    JS_FreeValue(ctx, signal);

    JSValue headers_p = JS_GetPropertyStr(ctx, start, "headers");
    JS_FreeValue(ctx, start);

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, st);
        JS_FreeValue(ctx, headers_p);
        return promise;
    }
    JSValue data[3] = {st, rfuncs[0], rfuncs[1]};
    JSValue on_h = JS_NewCFunctionData(ctx, hc_on_headers, 1, 0, 3, data);
    JSValue on_h_err = JS_NewCFunctionData(ctx, hc_on_headers_rejected, 1, 0, 3, data);
    JS_FreeValue(ctx, st);
    JS_FreeValue(ctx, rfuncs[0]);
    JS_FreeValue(ctx, rfuncs[1]);
    JSValue wrapped = hc_promise_resolve(ctx, headers_p);
    hc_then2(ctx, wrapped, on_h, on_h_err);
    JS_FreeValue(ctx, wrapped);
    return promise;
}

JSValue hc_pending_count_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                            JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    return hc_invoke(ctx, func_data[0], "pendingCount", 0, nullptr);
}

/* ── Transport module resolution ────────────────────────────────────────── */

/* Load `native:mikro/http` through the module loader so virtual-module
 * overrides (sim stubs, host fakes) win. The basename identifies the
 * importer to the loader's native: gate — only mikro-prefixed builtins may
 * import native: modules. Returns the namespace or throws. */
JSValue hc_load_transport_ns(JSContext* ctx) {
    /* The transport namespace is only stored; its exports are read per call,
     * after evaluation has finished — hoisting suffices (require_evaluated=false). */
    return mik__load_module_ns(ctx, "mikro/http/request", "native:mikro/http", false);
}

/* ── Module registration ────────────────────────────────────────────────── */

int hc_helpers_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue bce = hc_body_consumed_ctor(ctx);
    if (JS_IsException(bce)) return -1;
    JS_SetModuleExport(ctx, m, "BodyConsumedError", bce);
    JS_SetModuleExport(ctx, m, "RequestError", hc_make_request_error_obj(ctx));
    JS_SetModuleExport(ctx, m, "prepareBody",
                       JS_NewCFunction(ctx, hc_prepare_body_cf, "prepareBody", 1));
    JS_SetModuleExport(ctx, m, "makeResponse",
                       JS_NewCFunction(ctx, hc_make_response_cf, "makeResponse", 1));
    return 0;
}

int hc_request_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ns = hc_load_transport_ns(ctx);
    if (JS_IsException(ns)) return -1;
    JS_SetModuleExport(ctx, m, "request", JS_NewCFunctionData(ctx, hc_request_cf, 2, 0, 1, &ns));
    JS_SetModuleExport(ctx, m, "pendingCount",
                       JS_NewCFunctionData(ctx, hc_pending_count_cf, 0, 0, 1, &ns));
    JS_FreeValue(ctx, ns);
    return 0;
}

}  // namespace

/* Loader hooks (see the C-module table in modules.cpp). Created lazily on
 * first import so MIK_RegisterVirtualModule keeps precedence for these names
 * and runtimes that never import http pay nothing. */
JSModuleDef* mik__http_helpers_load(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/http/helpers", hc_helpers_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "RequestError");
    JS_AddModuleExport(ctx, m, "BodyConsumedError");
    JS_AddModuleExport(ctx, m, "prepareBody");
    JS_AddModuleExport(ctx, m, "makeResponse");
    return m;
}

JSModuleDef* mik__http_request_load(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/http/request", hc_request_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "request");
    JS_AddModuleExport(ctx, m, "pendingCount");
    return m;
}

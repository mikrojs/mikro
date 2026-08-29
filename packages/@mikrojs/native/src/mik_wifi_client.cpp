/*
 * Native implementation of the `mikro/wifi` builtin (formerly TypeScript
 * bundled to bytecode; ~22 KB heap per import). The transport stays behind
 * `native:mikro/wifi` and is resolved through the module loader, so
 * virtual-module overrides (simulator stubs, host test fakes) keep working.
 * Behavior is pinned by test/wifi_client_test.cpp; runtime/wifi/types.ts
 * remains as the type surface.
 */

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <mikrojs/utils.h>

#include <stdio.h>
#include <string.h>

#include <string>

#include "quickjs.h"

namespace {

constexpr int kMaxConnectRetries = 5;
constexpr int64_t kRetryDelayMs = 2000;

/* obj.method(args) with atom lifecycle handled. Borrows obj and args. */
JSValue wc_invoke(JSContext* ctx, JSValue obj, const char* method, int argc, JSValue* argv) {
    JSAtom atom = JS_NewAtom(ctx, method);
    JSValue r = JS_Invoke(ctx, obj, atom, argc, argv);
    JS_FreeAtom(ctx, atom);
    return r;
}

/* Call settle function `fn` (borrowed) with `arg` (consumed). */
void wc_settle(JSContext* ctx, JSValue fn, JSValue arg) {
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, arg);
}

/* Settle the function stored at st[key] with `arg` (consumed). */
void wc_settle_prop(JSContext* ctx, JSValue st, const char* key, JSValue arg) {
    JSValue fn = JS_GetPropertyStr(ctx, st, key);
    wc_settle(ctx, fn, arg);
    JS_FreeValue(ctx, fn);
}

/* Convert the pending exception into a rejected promise (async parity). */
JSValue wc_reject_pending_exception(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    return MIK_NewRejectedPromise(ctx, 1, &exc);
}

/* Promise.resolve(v) — normalizes thenables and plain values. Consumes `v`. */
JSValue wc_promise_resolve(JSContext* ctx, JSValue v) {
    if (JS_IsException(v)) return v;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue promise_ctor = JS_GetPropertyStr(ctx, g, "Promise");
    JS_FreeValue(ctx, g);
    JSValue p = wc_invoke(ctx, promise_ctor, "resolve", 1, &v);
    JS_FreeValue(ctx, promise_ctor);
    JS_FreeValue(ctx, v);
    return p;
}

/* console.warn(msg) — the retry notice stays on the console stream (captured
 * by sim/test output hooks), not the platform log. Failures are swallowed. */
void wc_console_warn(JSContext* ctx, const char* msg) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue console = JS_GetPropertyStr(ctx, g, "console");
    JS_FreeValue(ctx, g);
    if (JS_IsException(console)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    if (JS_IsObject(console)) {
        JSValue arg = JS_NewString(ctx, msg);
        JSValue r = wc_invoke(ctx, console, "warn", 1, &arg);
        JS_FreeValue(ctx, arg);
        if (JS_IsException(r)) JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, console);
}

/* p.then(on_fulfilled, on_rejected). Consumes both handlers; borrows `p`. */
void wc_then2(JSContext* ctx, JSValue p, JSValue on_fulfilled, JSValue on_rejected) {
    JSValue args[2] = {on_fulfilled, on_rejected};
    JSValue derived = wc_invoke(ctx, p, "then", 2, args);
    JS_FreeValue(ctx, derived);
    JS_FreeValue(ctx, on_fulfilled);
    JS_FreeValue(ctx, on_rejected);
}

/* Read obj[name] as a boolean. Caller data can be a Proxy or a throwing
 * getter; *threw reports that with the exception left pending (JS_ToBool
 * maps JS_EXCEPTION to -1 without arming anything new). */
bool wc_get_flag(JSContext* ctx, JSValue obj, const char* name, bool* threw) {
    JSValue v = JS_GetPropertyStr(ctx, obj, name);
    if (JS_IsException(v)) {
        *threw = true;
        return false;
    }
    int b = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    *threw = b < 0;
    return b > 0;
}

/* Strict-number status code, or -1 when the value is not a number
 * (TS used Map.get / === on numbers, so a string code never matches). */
int wc_status_code(JSContext* ctx, JSValue v) {
    if (!JS_IsNumber(v)) return -1;
    double d = 0;
    JS_ToFloat64(ctx, &d, v);
    int code = static_cast<int>(d);
    return static_cast<double>(code) == d ? code : -1;
}

/* ── Passthrough / swallow / setter method tables ───────────────────────── */

/* Methods and getters that forward straight to the native instance,
 * returning the native result verbatim. Second field: forward argv[0]. */
struct WcForward {
    const char* method;
    bool takes_arg;
};

constexpr WcForward kForward[] = {
    {"rssi", false},                // 0: wifi.rssi()
    {"getHostname", false},         // 1: wifi.hostname
    {"getCountry", false},          // 2: wifi.country
    {"getRssiThreshold", false},    // 3: wifi.rssiThreshold
    {"getPowerSave", false},        // 4: wifi.powerSave
    {"apStart", true},              // 5: wifi.ap.start(options)
    {"apStop", false},              // 6: wifi.ap.stop()
    {"apDeauthStation", true},      // 7: wifi.ap.deauthStation(mac)
    {"apIsActive", false},          // 8: wifi.ap.isActive
    {"apIp", false},                // 9: wifi.ap.ip
    {"apStations", false},          // 10: wifi.ap.stations
};

JSValue wc_forward_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    const WcForward& f = kForward[magic];
    JSValue arg = f.takes_arg ? (argc > 0 ? argv[0] : JS_UNDEFINED) : JS_UNDEFINED;
    return wc_invoke(ctx, func_data[0], f.method, f.takes_arg ? 1 : 0, &arg);
}

/* Setters: forward argv[0], discard the native Result. */
constexpr const char* kSetter[] = {
    "setRssiThreshold",       // 0: wifi.rssiThreshold =
    "setPowerSave",           // 1: wifi.powerSave =
    "apSetInactiveTimeout",   // 2: wifi.ap.inactiveTimeout =
};

JSValue wc_setter_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                     JSValue* func_data) {
    (void)this_val;
    JSValue arg = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValue r = wc_invoke(ctx, func_data[0], kSetter[magic], 1, &arg);
    if (JS_IsException(r)) return r;
    JS_FreeValue(ctx, r);
    return JS_UNDEFINED;
}

/* Getters that unwrap an ok Result and fall back to a default on err. */
enum { SWALLOW_MAC, SWALLOW_TX_POWER, SWALLOW_AP_INACTIVE_TIMEOUT };

constexpr const char* kSwallowMethod[] = {"mac", "getTxPower", "apGetInactiveTimeout"};

JSValue wc_swallow_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    JSValue r = wc_invoke(ctx, func_data[0], kSwallowMethod[magic], 0, nullptr);
    if (JS_IsException(r)) return r;
    bool threw = false;
    bool is_ok = wc_get_flag(ctx, r, "ok", &threw);
    if (threw) {
        JS_FreeValue(ctx, r);
        return JS_EXCEPTION;
    }
    if (is_ok) {
        JSValue v = JS_GetPropertyStr(ctx, r, "value");
        JS_FreeValue(ctx, r);
        return v;
    }
    JS_FreeValue(ctx, r);
    return magic == SWALLOW_MAC ? JS_NewString(ctx, "") : JS_NewInt32(ctx, 0);
}

/* ── status / isConnected / ip / disconnect / ipConfig ──────────────────── */

const char* wc_status_name(int code) {
    switch (code) {
        case 254:
            return "STOPPED";
        case 0:
            return "IDLE";
        case 1:
            return "NO_SSID_AVAIL";
        case 2:
            return "SCAN_COMPLETED";
        case 3:
            return "CONNECTED";
        case 4:
            return "CONNECT_FAILED";
        case 5:
            return "CONNECTION_LOST";
        default:
            return "DISCONNECTED";
    }
}

JSValue wc_status_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                     JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue v = wc_invoke(ctx, func_data[0], "status", 0, nullptr);
    if (JS_IsException(v)) return v;
    int code = wc_status_code(ctx, v);
    JS_FreeValue(ctx, v);
    return JS_NewString(ctx, wc_status_name(code));
}

JSValue wc_is_connected_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                           JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue v = wc_invoke(ctx, func_data[0], "status", 0, nullptr);
    if (JS_IsException(v)) return v;
    bool connected = wc_status_code(ctx, v) == 3;
    JS_FreeValue(ctx, v);
    return JS_NewBool(ctx, connected);
}

JSValue wc_ip_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                 JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValue v = wc_invoke(ctx, func_data[0], "ip", 0, nullptr);
    if (JS_IsException(v) || !JS_IsString(v)) return v;
    const char* s = JS_ToCString(ctx, v);
    bool unset = s && strcmp(s, "0.0.0.0") == 0;
    JS_FreeCString(ctx, s);
    if (!unset) return v;
    JS_FreeValue(ctx, v);
    return JS_UNDEFINED;
}

JSValue wc_disconnect_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                         JSValue* func_data) {
    (void)this_val;
    (void)magic;
    /* options?.shutdown — nullish options collapse to undefined. */
    JSValue shutdown = JS_UNDEFINED;
    if (argc > 0 && JS_IsObject(argv[0])) {
        shutdown = JS_GetPropertyStr(ctx, argv[0], "shutdown");
        if (JS_IsException(shutdown)) return shutdown;
    }
    JSValue r = wc_invoke(ctx, func_data[0], "disconnect", 1, &shutdown);
    JS_FreeValue(ctx, shutdown);
    return r;
}

JSValue wc_ip_config_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                        JSValue* func_data) {
    (void)this_val;
    (void)magic;
    /* Bare-undefined results from getIpConfig pass through untouched (pinned
     * quirk: the native side returns no Result when the netif is missing). */
    if (argc == 0 || JS_IsUndefined(argv[0])) {
        return wc_invoke(ctx, func_data[0], "getIpConfig", 0, nullptr);
    }
    return wc_invoke(ctx, func_data[0], "setIpConfig", 1, &argv[0]);
}

/* ── scan ───────────────────────────────────────────────────────────────── */

/* func_data: [0]=resolve, [1]=reject. */
JSValue wc_scan_on_result(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                          JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue ar = argc > 0 ? argv[0] : JS_UNDEFINED;
    bool threw = false;
    bool is_ok = wc_get_flag(ctx, ar, "ok", &threw);
    if (threw) {
        wc_settle(ctx, func_data[1], JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    if (!is_ok) {
        wc_settle(ctx, func_data[0], JS_DupValue(ctx, ar));
        return JS_UNDEFINED;
    }
    JSValue v = JS_GetPropertyStr(ctx, ar, "value");
    if (JS_IsException(v)) {
        wc_settle(ctx, func_data[1], JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    wc_settle(ctx, func_data[0], mik__result_ok(ctx, v));
    return JS_UNDEFINED;
}

JSValue wc_on_rejected(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                       JSValue* func_data) {
    (void)this_val;
    (void)magic;
    wc_settle(ctx, func_data[1], JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    return JS_UNDEFINED;
}

JSValue wc_scan_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                   JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue opts = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValue start = wc_invoke(ctx, func_data[0], "scan", 1, &opts);
    if (JS_IsException(start)) return wc_reject_pending_exception(ctx);
    bool threw = false;
    bool is_ok = wc_get_flag(ctx, start, "ok", &threw);
    if (threw) {
        JS_FreeValue(ctx, start);
        return wc_reject_pending_exception(ctx);
    }
    if (!is_ok) {
        return MIK_NewResolvedPromise(ctx, 1, &start);
    }
    JSValue inner = JS_GetPropertyStr(ctx, start, "value");
    JS_FreeValue(ctx, start);
    JSValue wrapped = wc_promise_resolve(ctx, inner);
    if (JS_IsException(wrapped)) return wc_reject_pending_exception(ctx);

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, wrapped);
        return promise;
    }
    JSValue on_ok = JS_NewCFunctionData(ctx, wc_scan_on_result, 1, 0, 2, rfuncs);
    JSValue on_err = JS_NewCFunctionData(ctx, wc_on_rejected, 1, 0, 2, rfuncs);
    JS_FreeValue(ctx, rfuncs[0]);
    JS_FreeValue(ctx, rfuncs[1]);
    wc_then2(ctx, wrapped, on_ok, on_err);
    JS_FreeValue(ctx, wrapped);
    return promise;
}

/* ── connect (C-driven retry loop) ──────────────────────────────────────── */

/* Connect state object props: nat (native instance), ssid, pass, att (int),
 * res/rej (capability settle functions). */

void wc_connect_attempt(JSContext* ctx, JSValue st);

JSValue wc_connect_retry_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                            JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    wc_connect_attempt(ctx, func_data[0]);
    return JS_UNDEFINED;
}

void wc_connect_reject_pending(JSContext* ctx, JSValue st) {
    JSValue exc = JS_GetException(ctx);
    wc_settle_prop(ctx, st, "rej", exc);
}

/* Settled value of one native connect attempt. func_data: [0]=state. */
JSValue wc_connect_on_result(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                             JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue st = func_data[0];
    JSValue ar = argc > 0 ? argv[0] : JS_UNDEFINED;

    bool threw = false;
    bool is_ok = wc_get_flag(ctx, ar, "ok", &threw);
    if (threw) {
        wc_connect_reject_pending(ctx, st);
        return JS_UNDEFINED;
    }
    if (is_ok) {
        JSValue v = JS_GetPropertyStr(ctx, ar, "value");
        if (JS_IsException(v)) {
            wc_connect_reject_pending(ctx, st);
            return JS_UNDEFINED;
        }
        wc_settle_prop(ctx, st, "res", mik__result_ok(ctx, v));
        return JS_UNDEFINED;
    }
    JSValue att_v = JS_GetPropertyStr(ctx, st, "att");
    if (JS_IsException(att_v)) {
        wc_connect_reject_pending(ctx, st);
        return JS_UNDEFINED;
    }
    int32_t attempt = 0;
    JS_ToInt32(ctx, &attempt, att_v);
    JS_FreeValue(ctx, att_v);
    if (attempt >= kMaxConnectRetries) {
        /* Exhaustion returns the last native error verbatim (pinned). */
        wc_settle_prop(ctx, st, "res", JS_DupValue(ctx, ar));
        return JS_UNDEFINED;
    }
    JS_SetPropertyStr(ctx, st, "att", JS_NewInt32(ctx, attempt + 1));
    char warn_msg[64];
    snprintf(warn_msg, sizeof(warn_msg), "WiFi connect failed, retrying in %dms…",
             static_cast<int>(kRetryDelayMs));
    wc_console_warn(ctx, warn_msg);

    /* Keep the radio up between retries so the next attempt reconnects fast. */
    JSValue nat = JS_GetPropertyStr(ctx, st, "nat");
    JSValue keep_up = JS_FALSE;
    JSValue r = wc_invoke(ctx, nat, "disconnect", 1, &keep_up);
    JS_FreeValue(ctx, nat);
    if (JS_IsException(r)) {
        wc_connect_reject_pending(ctx, st);
        return JS_UNDEFINED;
    }
    JS_FreeValue(ctx, r);

    JSValue retry_fn = JS_NewCFunctionData(ctx, wc_connect_retry_cf, 0, 0, 1, &st);
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    /* MIK_FreeRuntime nulls timers before JS_FreeContext; skip scheduling in
     * that window (the connect promise stays pending, matching http). */
    if (mik_rt->timers) {
        MIK_Timer_Schedule(mik_rt->timers, ctx, retry_fn, 0, nullptr, kRetryDelayMs * 1000, false,
                           MIK_GetPlatform()->get_boot_us());
    }
    JS_FreeValue(ctx, retry_fn);
    return JS_UNDEFINED;
}

JSValue wc_connect_on_reject(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                             JSValue* func_data) {
    (void)this_val;
    (void)magic;
    wc_settle_prop(ctx, func_data[0], "rej",
                   JS_DupValue(ctx, argc > 0 ? argv[0] : JS_UNDEFINED));
    return JS_UNDEFINED;
}

void wc_connect_attempt(JSContext* ctx, JSValue st) {
    JSValue nat = JS_GetPropertyStr(ctx, st, "nat");
    JSValue args[2] = {JS_GetPropertyStr(ctx, st, "ssid"), JS_GetPropertyStr(ctx, st, "pass")};
    JSValue start = wc_invoke(ctx, nat, "connect", 2, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, nat);
    if (JS_IsException(start)) {
        wc_connect_reject_pending(ctx, st);
        return;
    }
    bool threw = false;
    bool is_ok = wc_get_flag(ctx, start, "ok", &threw);
    if (threw) {
        JS_FreeValue(ctx, start);
        wc_connect_reject_pending(ctx, st);
        return;
    }
    if (!is_ok) {
        /* Start error is returned verbatim without retrying (pinned). */
        wc_settle_prop(ctx, st, "res", start);
        return;
    }
    JSValue inner = JS_GetPropertyStr(ctx, start, "value");
    JS_FreeValue(ctx, start);
    JSValue wrapped = wc_promise_resolve(ctx, inner);
    if (JS_IsException(wrapped)) {
        wc_connect_reject_pending(ctx, st);
        return;
    }

    JSValue on_ok = JS_NewCFunctionData(ctx, wc_connect_on_result, 1, 0, 1, &st);
    JSValue on_err = JS_NewCFunctionData(ctx, wc_connect_on_reject, 1, 0, 1, &st);
    wc_then2(ctx, wrapped, on_ok, on_err);
    JS_FreeValue(ctx, wrapped);
}

JSValue wc_connect_cf(JSContext* ctx, JSValue this_val, int argc, JSValue* argv, int magic,
                      JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue options = argc > 0 ? argv[0] : JS_UNDEFINED;

    /* TS destructured `options` up front; a nullish argument throws there
     * and rejects (async parity). */
    JSValue ssid = JS_GetPropertyStr(ctx, options, "ssid");
    if (JS_IsException(ssid)) return wc_reject_pending_exception(ctx);
    JSValue pass = JS_GetPropertyStr(ctx, options, "passphrase");
    if (JS_IsException(pass)) {
        JS_FreeValue(ctx, ssid);
        return wc_reject_pending_exception(ctx);
    }
    JSValue tx_power = JS_GetPropertyStr(ctx, options, "txPower");
    if (JS_IsException(tx_power)) {
        JS_FreeValue(ctx, ssid);
        JS_FreeValue(ctx, pass);
        return wc_reject_pending_exception(ctx);
    }

    if (!JS_IsUndefined(tx_power)) {
        JSValue r = wc_invoke(ctx, func_data[0], "setTxPower", 1, &tx_power);
        JS_FreeValue(ctx, tx_power);
        if (JS_IsException(r)) {
            JS_FreeValue(ctx, ssid);
            JS_FreeValue(ctx, pass);
            return wc_reject_pending_exception(ctx);
        }
        bool threw = false;
        bool tx_ok = wc_get_flag(ctx, r, "ok", &threw);
        if (threw) {
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, ssid);
            JS_FreeValue(ctx, pass);
            return wc_reject_pending_exception(ctx);
        }
        if (!tx_ok) {
            /* setTxPower error short-circuits before any connect (pinned). */
            JS_FreeValue(ctx, ssid);
            JS_FreeValue(ctx, pass);
            return MIK_NewResolvedPromise(ctx, 1, &r);
        }
        JS_FreeValue(ctx, r);
    } else {
        JS_FreeValue(ctx, tx_power);
    }

    JSValue rfuncs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, rfuncs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, ssid);
        JS_FreeValue(ctx, pass);
        return promise;
    }
    JSValue st = JS_NewObjectProto(ctx, JS_NULL);
    JS_SetPropertyStr(ctx, st, "nat", JS_DupValue(ctx, func_data[0]));
    JS_SetPropertyStr(ctx, st, "ssid", ssid);
    JS_SetPropertyStr(ctx, st, "pass", pass);
    JS_SetPropertyStr(ctx, st, "att", JS_NewInt32(ctx, 0));
    JS_SetPropertyStr(ctx, st, "res", rfuncs[0]);
    JS_SetPropertyStr(ctx, st, "rej", rfuncs[1]);
    wc_connect_attempt(ctx, st);
    JS_FreeValue(ctx, st);
    return promise;
}

/* ── Module wiring ──────────────────────────────────────────────────────── */

/* lazyEvent(native, event) via mikro/observable/lazy. Returns the Observable
 * (owned) or an exception. Borrows all arguments. */
JSValue wc_lazy_event(JSContext* ctx, JSValue lazy_fn, JSValue nat, const char* event) {
    JSValue args[2] = {nat, JS_NewString(ctx, event)};
    JSValue obs = JS_Call(ctx, lazy_fn, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, args[1]);
    return obs;
}

/* Define an accessor property on obj. Consumes getter and setter. */
int wc_define_accessor(JSContext* ctx, JSValue obj, const char* name, JSValue getter,
                       JSValue setter) {
    JSAtom atom = JS_NewAtom(ctx, name);
    int r = JS_DefinePropertyGetSet(ctx, obj, atom, getter, setter,
                                    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, atom);
    return r;
}

/* JS_NewCFunctionData leaves functions anonymous; name the public methods so
 * stacks and inspect output stay readable. Returns fn. */
JSValue wc_named(JSContext* ctx, JSValue fn, const char* name) {
    JS_DefinePropertyValueStr(ctx, fn, "name", JS_NewString(ctx, name), JS_PROP_CONFIGURABLE);
    return fn;
}

JSValue wc_forward_fn(JSContext* ctx, JSValue nat, int magic, int length) {
    return JS_NewCFunctionData(ctx, wc_forward_cf, length, magic, 1, &nat);
}

/* Build the `ap` namespace object. Borrows nat and lazy_fn. */
JSValue wc_make_ap(JSContext* ctx, JSValue nat, JSValue lazy_fn) {
    JSValue ap = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, ap, "start", wc_named(ctx, wc_forward_fn(ctx, nat, 5, 1), "start"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, ap, "stop", wc_named(ctx, wc_forward_fn(ctx, nat, 6, 0), "stop"),
                              JS_PROP_C_W_E);
    wc_define_accessor(ctx, ap, "isActive", wc_forward_fn(ctx, nat, 8, 0), JS_UNDEFINED);
    wc_define_accessor(ctx, ap, "ip", wc_forward_fn(ctx, nat, 9, 0), JS_UNDEFINED);
    wc_define_accessor(ctx, ap, "stations", wc_forward_fn(ctx, nat, 10, 0), JS_UNDEFINED);
    JS_DefinePropertyValueStr(ctx, ap, "deauthStation",
                              wc_named(ctx, wc_forward_fn(ctx, nat, 7, 1), "deauthStation"),
                              JS_PROP_C_W_E);
    wc_define_accessor(
        ctx, ap, "inactiveTimeout",
        JS_NewCFunctionData(ctx, wc_swallow_cf, 0, SWALLOW_AP_INACTIVE_TIMEOUT, 1, &nat),
        JS_NewCFunctionData(ctx, wc_setter_cf, 1, 2, 1, &nat));

    static const struct {
        const char* prop;
        const char* event;
    } kApEvents[] = {
        {"onStationConnect", "station-connect"},
        {"onStationDisconnect", "station-disconnect"},
    };
    for (const auto& e : kApEvents) {
        JSValue obs = wc_lazy_event(ctx, lazy_fn, nat, e.event);
        if (JS_IsException(obs)) {
            JS_FreeValue(ctx, ap);
            return obs;
        }
        JS_DefinePropertyValueStr(ctx, ap, e.prop, obs, JS_PROP_C_W_E);
    }
    return ap;
}

int wc_module_init(JSContext* ctx, JSModuleDef* m) {
    /* Wifi (a class export) is constructed right here, and lazyEvent is
     * invoked below — both need the target module fully evaluated. */
    JSValue ns = mik__load_module_ns(ctx, "mikro/wifi", "native:mikro/wifi", true);
    if (JS_IsException(ns)) return -1;
    JSValue wifi_ctor = JS_GetPropertyStr(ctx, ns, "Wifi");
    JS_FreeValue(ctx, ns);
    if (JS_IsException(wifi_ctor)) return -1;

    /* One native instance per runtime, constructed at import (TS parity:
     * `new NativeWifi()` ran at module scope and its throw failed the import). */
    JSValue nat = JS_CallConstructor(ctx, wifi_ctor, 0, nullptr);
    JS_FreeValue(ctx, wifi_ctor);
    if (JS_IsException(nat)) return -1;

    JSValue lazy_ns = mik__load_module_ns(ctx, "mikro/wifi", "mikro/observable/lazy", true);
    if (JS_IsException(lazy_ns)) {
        JS_FreeValue(ctx, nat);
        return -1;
    }
    JSValue lazy_fn = JS_GetPropertyStr(ctx, lazy_ns, "lazyEvent");
    JS_FreeValue(ctx, lazy_ns);
    if (JS_IsException(lazy_fn)) {
        JS_FreeValue(ctx, nat);
        return -1;
    }

    /* Property definition order mirrors the TS object literal so
     * Object.keys(wifi) snapshots stay identical across the port. */
    JSValue wifi = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(
        ctx, wifi, "connect",
        wc_named(ctx, JS_NewCFunctionData(ctx, wc_connect_cf, 1, 0, 1, &nat), "connect"),
        JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(
        ctx, wifi, "disconnect",
        wc_named(ctx, JS_NewCFunctionData(ctx, wc_disconnect_cf, 0, 0, 1, &nat), "disconnect"),
        JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, wifi, "rssi", wc_named(ctx, wc_forward_fn(ctx, nat, 0, 0), "rssi"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, wifi, "ip",
                              wc_named(ctx, JS_NewCFunctionData(ctx, wc_ip_cf, 0, 0, 1, &nat), "ip"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(
        ctx, wifi, "status",
        wc_named(ctx, JS_NewCFunctionData(ctx, wc_status_cf, 0, 0, 1, &nat), "status"),
        JS_PROP_C_W_E);
    wc_define_accessor(ctx, wifi, "isConnected",
                       JS_NewCFunctionData(ctx, wc_is_connected_cf, 0, 0, 1, &nat), JS_UNDEFINED);
    JS_DefinePropertyValueStr(
        ctx, wifi, "scan",
        wc_named(ctx, JS_NewCFunctionData(ctx, wc_scan_cf, 0, 0, 1, &nat), "scan"), JS_PROP_C_W_E);

    static const struct {
        const char* prop;
        const char* event;
    } kEvents[] = {
        {"onConnect", "connect"},
        {"onDisconnect", "disconnect"},
        {"onRssiLow", "rssi-low"},
    };
    for (const auto& e : kEvents) {
        JSValue obs = wc_lazy_event(ctx, lazy_fn, nat, e.event);
        if (JS_IsException(obs)) {
            JS_FreeValue(ctx, wifi);
            JS_FreeValue(ctx, lazy_fn);
            JS_FreeValue(ctx, nat);
            return -1;
        }
        JS_DefinePropertyValueStr(ctx, wifi, e.prop, obs, JS_PROP_C_W_E);
    }

    wc_define_accessor(ctx, wifi, "mac",
                       JS_NewCFunctionData(ctx, wc_swallow_cf, 0, SWALLOW_MAC, 1, &nat),
                       JS_UNDEFINED);
    wc_define_accessor(ctx, wifi, "hostname", wc_forward_fn(ctx, nat, 1, 0), JS_UNDEFINED);
    JS_DefinePropertyValueStr(
        ctx, wifi, "ipConfig",
        wc_named(ctx, JS_NewCFunctionData(ctx, wc_ip_config_cf, 0, 0, 1, &nat), "ipConfig"),
        JS_PROP_C_W_E);

    JSValue ap = wc_make_ap(ctx, nat, lazy_fn);
    JS_FreeValue(ctx, lazy_fn);
    if (JS_IsException(ap)) {
        JS_FreeValue(ctx, wifi);
        JS_FreeValue(ctx, nat);
        return -1;
    }
    JS_DefinePropertyValueStr(ctx, wifi, "ap", ap, JS_PROP_C_W_E);

    wc_define_accessor(ctx, wifi, "txPower",
                       JS_NewCFunctionData(ctx, wc_swallow_cf, 0, SWALLOW_TX_POWER, 1, &nat),
                       JS_UNDEFINED);
    wc_define_accessor(ctx, wifi, "rssiThreshold", wc_forward_fn(ctx, nat, 3, 0),
                       JS_NewCFunctionData(ctx, wc_setter_cf, 1, 0, 1, &nat));
    wc_define_accessor(ctx, wifi, "powerSave", wc_forward_fn(ctx, nat, 4, 0),
                       JS_NewCFunctionData(ctx, wc_setter_cf, 1, 1, 1, &nat));
    wc_define_accessor(ctx, wifi, "country", wc_forward_fn(ctx, nat, 2, 0), JS_UNDEFINED);
    JS_FreeValue(ctx, nat);

    JS_SetModuleExport(ctx, m, "wifi", wifi);
    return 0;
}

}  // namespace

/* Loader hook (see the C-module table in modules.cpp). Created lazily on
 * first import so MIK_RegisterVirtualModule keeps precedence for this name
 * and runtimes that never import wifi pay nothing. */
JSModuleDef* mik__wifi_client_load(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/wifi", wc_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "wifi");
    return m;
}

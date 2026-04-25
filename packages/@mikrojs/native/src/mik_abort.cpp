#include <quickjs.h>

#include "mikrojs/utils.h"

/* Minimal AbortController / AbortSignal implementation.
 *
 * This is a lightweight subset of the WHATWG DOM spec — just enough
 * for fetch timeouts and cooperative cancellation.  No EventTarget
 * dependency: listeners are stored in a simple array.
 *
 * Implements:
 *   AbortSignal: aborted, reason, throwIfAborted(), onabort,
 *                addEventListener("abort", fn), removeEventListener("abort", fn)
 *   AbortSignal.abort(reason)   — pre-aborted signal
 *   AbortSignal.timeout(ms)     — auto-aborts after delay
 *   AbortSignal.any(signals)    — aborts when any input signal aborts
 *   AbortController: signal, abort(reason)
 *
 * Lazy-initialized: the JS class hierarchy is compiled and installed
 * on first access to any of the four globals (AbortController,
 * AbortSignal, AbortError, TimeoutError).
 */

static const char abort_js[] = R"JS(
(function(g) {
  "use strict";

  class AbortError extends Error {
    constructor(message) { super(message || "The operation was aborted"); }
    get name() { return "AbortError"; }
  }
  class TimeoutError extends Error {
    constructor(message) { super(message || "The operation timed out"); }
    get name() { return "TimeoutError"; }
  }

  const _a = Symbol(), _r = Symbol(), _l = Symbol(), _s = Symbol();
  const ABORT_REASON = () => new AbortError();

  function doAbort(signal, reason) {
    if (signal[_a]) return;
    signal[_a] = true;
    signal[_r] = reason;
    if (typeof signal.onabort === "function") signal.onabort();
    for (const fn of signal[_l]) fn();
  }

  class AbortSignal {
    constructor() {
      this[_a] = false;
      this[_r] = undefined;
      this[_l] = [];
      this.onabort = null;
    }
    get aborted() { return this[_a]; }
    get reason() { return this[_r]; }
    throwIfAborted() { if (this[_a]) throw this[_r]; }
    addEventListener(type, fn) {
      if (type === "abort" && typeof fn === "function") this[_l].push(fn);
    }
    removeEventListener(type, fn) {
      if (type === "abort") this[_l] = this[_l].filter(f => f !== fn);
    }
    static abort(reason) {
      const s = new AbortSignal();
      doAbort(s, reason !== undefined ? reason : ABORT_REASON());
      return s;
    }
    static timeout(ms) {
      const s = new AbortSignal();
      setTimeout(() => doAbort(s, new TimeoutError()), ms);
      return s;
    }
    static any(signals) {
      const s = new AbortSignal();
      for (const i of signals) {
        if (i.aborted) { doAbort(s, i.reason); return s; }
      }
      for (const i of signals) {
        i.addEventListener("abort", () => doAbort(s, i.reason));
      }
      return s;
    }
  }

  class AbortController {
    constructor() { this[_s] = new AbortSignal(); }
    get signal() { return this[_s]; }
    abort(reason) { doAbort(this[_s], reason !== undefined ? reason : ABORT_REASON()); }
  }

  g.AbortError = AbortError;
  g.TimeoutError = TimeoutError;
  g.AbortSignal = AbortSignal;
  g.AbortController = AbortController;
})
)JS";

/* Names of the globals this module installs */
static const char* const abort_global_names[] = {"AbortController", "AbortSignal", "AbortError",
                                                  "TimeoutError"};
static constexpr int ABORT_GLOBAL_COUNT = 4;

/**
 * Lazy getter: on first access to any of the four globals, delete all
 * lazy getters, evaluate the JS to install real values, then return
 * the requested one.  The magic parameter identifies which global.
 *
 * Signature must match JS_CFUNC_getter_magic: (ctx, this_val, magic).
 */
static JSValue mik__abort_lazy_get(JSContext* ctx, JSValue this_val, int magic) {

    JSValue global_obj = JS_GetGlobalObject(ctx);

    /* Remove all four lazy getters so the JS assignment (g.X = Y) works */
    for (int i = 0; i < ABORT_GLOBAL_COUNT; i++) {
        JSAtom prop = JS_NewAtom(ctx, abort_global_names[i]);
        JS_DeleteProperty(ctx, global_obj, prop, 0);
        JS_FreeAtom(ctx, prop);
    }

    /* Evaluate and install the real globals */
    JSValue wrapper =
        JS_Eval(ctx, abort_js, sizeof(abort_js) - 1, "<abort>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(wrapper)) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, global_obj);
        return JS_UNDEFINED;
    }
    JSValue ret = JS_Call(ctx, wrapper, JS_UNDEFINED, 1, &global_obj);
    JS_FreeValue(ctx, wrapper);
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, global_obj);
        return JS_UNDEFINED;
    }
    JS_FreeValue(ctx, ret);

    /* Return the requested global */
    JSValue val = JS_GetPropertyStr(ctx, global_obj, abort_global_names[magic]);
    JS_FreeValue(ctx, global_obj);
    return val;
}

void mik__abort_init(JSContext* ctx, JSValue global_obj) {
    /* Install lazy getters instead of eagerly evaluating the JS.
     * Each getter shares the same C function, distinguished by magic. */
    for (int i = 0; i < ABORT_GLOBAL_COUNT; i++) {
        JSAtom prop = JS_NewAtom(ctx, abort_global_names[i]);
        JSCFunctionType ft;
        ft.getter_magic = mik__abort_lazy_get;
        JSValue getter = JS_NewCFunction2(ctx, ft.generic, abort_global_names[i], 0,
                                          JS_CFUNC_getter_magic, i);
        JS_DefinePropertyGetSet(ctx, global_obj, prop, getter, JS_UNDEFINED,
                                JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
        JS_FreeAtom(ctx, prop);
    }
}

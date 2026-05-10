/* mik_observable.cpp — push-shaped composable event stream primitive.
 *
 * See .claude/plans/observable.md (worktree branch) for the locked design.
 *
 * Classes registered:
 *   - Observable: constructor(cb), subscribe(observer), pipe(...ops),
 *                 static from(src), static withEmitters()
 *   - Subscriber (internal handle passed to subscribe callback): next, complete,
 *                 addTeardown, closed
 *   - Subscription: unsubscribe
 *
 * Error semantics: throws inside observer or operator callbacks (and inside
 * teardown callbacks) are caught at the dispatch boundary, isolated to the
 * offending subscriber, and re-thrown asynchronously via setTimeout(0). The
 * synchronous producer keeps running (sibling subscribers receive the value,
 * remaining teardowns run); the bug eventually surfaces as an uncaught
 * exception, which the runtime treats as fatal via the existing
 * unhandled-rejection halt mechanism. Stream errors are panics.
 *
 * Producer-setup throws inside the subscribe callback bubble synchronously
 * to the .subscribe() caller — that's a bug in the producer factory itself,
 * not a runtime dispatch event.
 */

#include <cstddef>
#include <cstdint>
#include <vector>

#include "mikrojs/private.h"
#include "mikrojs/utils.h"

extern "C" {
#include "quickjs.h"
}

namespace {

JSClassID observable_class_id;
JSClassID subscriber_class_id;
JSClassID subscription_class_id;

struct ObservableData {
    JSValue subscribe_cb;
};

struct SubscriberData {
    JSContext* ctx;
    bool closed;
    /* observer object retained so its props can't be reclaimed mid-dispatch. */
    JSValue observer;
    JSValue next_fn;
    JSValue complete_fn;
    std::vector<JSValue> teardowns;
};

struct SubscriptionData {
    /* Owns the subscriber JSValue so unsubscribe() can reach the SubscriberData
     * even after the producer's reference drops. */
    JSValue subscriber_value;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

/* Re-throws the captured exception from func_data[0]. Used as the
 * `setTimeout(callback, 0)` payload in panic_async. */
static JSValue throw_captured(JSContext* ctx, JSValueConst this_val, int argc,
                              JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    return JS_Throw(ctx, JS_DupValue(ctx, func_data[0]));
}

/* Catch a thrown error and re-throw it on the next event-loop tick via the
 * runtime's setTimeout. The synchronous caller keeps going (sibling
 * subscribers receive the value, remaining teardowns run); the eventual
 * uncaught throw halts the runtime via the existing unhandled-rejection
 * path. Stream errors are panics.
 *
 * Takes ownership of `exception` — caller must not free after this call. */
static void panic_async(JSContext* ctx, JSValue exception) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue setTimeout = JS_GetPropertyStr(ctx, global, "setTimeout");
    JS_FreeValue(ctx, global);
    if (!JS_IsFunction(ctx, setTimeout)) {
        /* setTimeout missing or not a function — should not happen in the
         * mikrojs runtime since it's globally defined. Drop on the floor
         * rather than disrupting the dispatch path. */
        JS_FreeValue(ctx, setTimeout);
        JS_FreeValue(ctx, exception);
        return;
    }
    JSValueConst data[1] = {exception};
    JSValue thrower = JS_NewCFunctionData(ctx, throw_captured, 0, 0, 1, data);
    JS_FreeValue(ctx, exception);
    if (JS_IsException(thrower)) {
        JS_FreeValue(ctx, setTimeout);
        return;
    }
    JSValue zero = JS_NewInt32(ctx, 0);
    JSValueConst call_args[2] = {thrower, zero};
    JSValue ret = JS_Call(ctx, setTimeout, JS_UNDEFINED, 2, call_args);
    JS_FreeValue(ctx, setTimeout);
    JS_FreeValue(ctx, thrower);
    JS_FreeValue(ctx, zero);
    if (JS_IsException(ret)) {
        /* setTimeout itself threw — best effort, drop the secondary error. */
        JSValue suppressed = JS_GetException(ctx);
        JS_FreeValue(ctx, suppressed);
    } else {
        JS_FreeValue(ctx, ret);
    }
}

/* Call `fn(argv...)` synchronously; if it throws, schedule the exception
 * to re-throw on the next tick. Caller is not informed of the throw. */
static void run_safely(JSContext* ctx, JSValue fn, int argc, JSValue* argv) {
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        panic_async(ctx, exc);
    } else {
        JS_FreeValue(ctx, ret);
    }
}

/* Same panic-on-throw semantics as run_safely, for invoke-by-method calls
 * (used when we don't have direct access to the C-level subscriber struct
 * — multicast dispatch, from-iterable, from-promise). */
static void invoke_safely(JSContext* ctx, JSValueConst this_val, JSAtom method, int argc,
                          JSValueConst* argv) {
    JSValue ret = JS_Invoke(ctx, this_val, method, argc, argv);
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        panic_async(ctx, exc);
    } else {
        JS_FreeValue(ctx, ret);
    }
}

/* Run all registered teardowns in reverse insertion order. Throws are
 * scheduled to re-throw async via panic_async, so subsequent teardowns
 * still run synchronously. */
static void run_teardowns(JSContext* ctx, SubscriberData* d) {
    /* Swap into a local list. If a teardown calls addTeardown synchronously,
     * the SubscriberData.closed flag is already true so addTeardown fires the
     * new callback immediately (handled in subscriber_add_teardown). */
    std::vector<JSValue> list;
    list.swap(d->teardowns);
    for (auto it = list.rbegin(); it != list.rend(); ++it) {
        run_safely(ctx, *it, 0, nullptr);
        JS_FreeValue(ctx, *it);
    }
}

/* ── Subscriber ─────────────────────────────────────────────────── */

static void subscriber_finalizer(JSRuntime* rt, JSValue val) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(val, subscriber_class_id));
    if (!d) return;
    JS_FreeValueRT(rt, d->observer);
    JS_FreeValueRT(rt, d->next_fn);
    JS_FreeValueRT(rt, d->complete_fn);
    for (auto& td : d->teardowns) JS_FreeValueRT(rt, td);
    delete d;
}

static void subscriber_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(val, subscriber_class_id));
    if (!d) return;
    JS_MarkValue(rt, d->observer, mark_func);
    JS_MarkValue(rt, d->next_fn, mark_func);
    JS_MarkValue(rt, d->complete_fn, mark_func);
    for (auto& td : d->teardowns) JS_MarkValue(rt, td, mark_func);
}

static JSClassDef subscriber_class_def = {
    "Subscriber",
    subscriber_finalizer,
    subscriber_gc_mark,
    nullptr,
    nullptr,
};

static JSValue subscriber_next(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    if (d->closed) return JS_UNDEFINED;
    if (!JS_IsUndefined(d->next_fn)) {
        JSValue arg = argc > 0 ? argv[0] : JS_UNDEFINED;
        run_safely(ctx, d->next_fn, 1, &arg);
    }
    return JS_UNDEFINED;
}

static JSValue subscriber_complete(JSContext* ctx, JSValueConst this_val, int argc,
                                   JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    if (d->closed) return JS_UNDEFINED;
    d->closed = true;
    if (!JS_IsUndefined(d->complete_fn)) {
        run_safely(ctx, d->complete_fn, 0, nullptr);
    }
    run_teardowns(ctx, d);
    return JS_UNDEFINED;
}

static JSValue subscriber_add_teardown(JSContext* ctx, JSValueConst this_val, int argc,
                                       JSValueConst* argv) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "addTeardown: argument must be a function");
    }
    if (d->closed) {
        /* Late teardown registration — fire immediately to avoid leaks. */
        run_safely(ctx, argv[0], 0, nullptr);
    } else {
        d->teardowns.push_back(JS_DupValue(ctx, argv[0]));
    }
    return JS_UNDEFINED;
}

static JSValue subscriber_get_closed(JSContext* ctx, JSValueConst this_val) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    return JS_NewBool(ctx, d->closed);
}

static const JSCFunctionListEntry subscriber_proto_funcs[] = {
    JS_CFUNC_DEF("next", 1, subscriber_next),
    JS_CFUNC_DEF("complete", 0, subscriber_complete),
    JS_CFUNC_DEF("addTeardown", 1, subscriber_add_teardown),
    JS_CGETSET_DEF("closed", subscriber_get_closed, nullptr),
};

/* ── Subscription ─────────────────────────────────────────────────── */

static void subscription_finalizer(JSRuntime* rt, JSValue val) {
    auto* d = static_cast<SubscriptionData*>(JS_GetOpaque(val, subscription_class_id));
    if (!d) return;
    JS_FreeValueRT(rt, d->subscriber_value);
    delete d;
}

static void subscription_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* d = static_cast<SubscriptionData*>(JS_GetOpaque(val, subscription_class_id));
    if (!d) return;
    JS_MarkValue(rt, d->subscriber_value, mark_func);
}

static JSClassDef subscription_class_def = {
    "Subscription",
    subscription_finalizer,
    subscription_gc_mark,
    nullptr,
    nullptr,
};

static JSValue subscription_unsubscribe(JSContext* ctx, JSValueConst this_val, int argc,
                                        JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* sd =
        static_cast<SubscriptionData*>(JS_GetOpaque2(ctx, this_val, subscription_class_id));
    if (!sd) return JS_EXCEPTION;
    auto* sub = static_cast<SubscriberData*>(JS_GetOpaque(sd->subscriber_value,
                                                          subscriber_class_id));
    if (!sub || sub->closed) return JS_UNDEFINED;
    sub->closed = true;
    /* unsubscribe() is silent — does NOT call observer.complete().
     * Only natural producer-driven completion fires observer.complete(). */
    run_teardowns(ctx, sub);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry subscription_proto_funcs[] = {
    JS_CFUNC_DEF("unsubscribe", 0, subscription_unsubscribe),
};

/* Build a Subscription wrapping the given subscriber value. Takes ownership of
 * subscriber_val (caller must not free after this point). */
static JSValue make_subscription(JSContext* ctx, JSValue subscriber_val) {
    JSValue obj = JS_NewObjectClass(ctx, subscription_class_id);
    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, subscriber_val);
        return obj;
    }
    auto* d = new SubscriptionData{subscriber_val};
    JS_SetOpaque(obj, d);
    return obj;
}

/* ── Observable ───────────────────────────────────────────────────── */

static void observable_finalizer(JSRuntime* rt, JSValue val) {
    auto* d = static_cast<ObservableData*>(JS_GetOpaque(val, observable_class_id));
    if (!d) return;
    JS_FreeValueRT(rt, d->subscribe_cb);
    delete d;
}

static void observable_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* d = static_cast<ObservableData*>(JS_GetOpaque(val, observable_class_id));
    if (!d) return;
    JS_MarkValue(rt, d->subscribe_cb, mark_func);
}

static JSClassDef observable_class_def = {
    "Observable",
    observable_finalizer,
    observable_gc_mark,
    nullptr,
    nullptr,
};

/* Run a subscribe callback against an observer, return a Subscription.
 * subscribe_cb is borrowed (not freed). Observer is borrowed.
 * Used by both Observable.prototype.subscribe and the static factories. */
static JSValue subscribe_with_callback(JSContext* ctx, JSValueConst subscribe_cb,
                                       JSValueConst observer) {
    JSValue next_fn = JS_UNDEFINED;
    JSValue complete_fn = JS_UNDEFINED;
    JSValue observer_dup = JS_UNDEFINED;

    if (!JS_IsUndefined(observer) && !JS_IsNull(observer)) {
        if (JS_IsFunction(ctx, observer)) {
            next_fn = JS_DupValue(ctx, observer);
        } else if (JS_IsObject(observer)) {
            observer_dup = JS_DupValue(ctx, observer);
            JSValue n = JS_GetPropertyStr(ctx, observer, "next");
            JSValue c = JS_GetPropertyStr(ctx, observer, "complete");
            if (JS_IsFunction(ctx, n)) {
                next_fn = n;
            } else {
                JS_FreeValue(ctx, n);
            }
            if (JS_IsFunction(ctx, c)) {
                complete_fn = c;
            } else {
                JS_FreeValue(ctx, c);
            }
        } else {
            return JS_ThrowTypeError(
                ctx, "subscribe: observer must be a function, object, undefined, or null");
        }
    }

    JSValue subscriber_val = JS_NewObjectClass(ctx, subscriber_class_id);
    if (JS_IsException(subscriber_val)) {
        JS_FreeValue(ctx, observer_dup);
        JS_FreeValue(ctx, next_fn);
        JS_FreeValue(ctx, complete_fn);
        return subscriber_val;
    }
    auto* d = new SubscriberData{
        ctx,
        false,
        observer_dup,
        next_fn,
        complete_fn,
        {},
    };
    JS_SetOpaque(subscriber_val, d);

    /* Sync emission is allowed: producer may call next/complete inside the
     * subscribe callback. The Subscription returned to the caller may already
     * be in a closed state by the time we return it — that's fine, idempotent
     * unsubscribe handles it. */
    JSValue cb_result = JS_Call(ctx, subscribe_cb, JS_UNDEFINED, 1, &subscriber_val);
    if (JS_IsException(cb_result)) {
        /* Producer setup threw — bubble up. Mark closed so any deferred
         * dispatch back to this subscriber is silently dropped. */
        d->closed = true;
        JS_FreeValue(ctx, subscriber_val);
        return cb_result;
    }
    JS_FreeValue(ctx, cb_result);

    return make_subscription(ctx, subscriber_val);
}

static JSValue observable_subscribe(JSContext* ctx, JSValueConst this_val, int argc,
                                    JSValueConst* argv) {
    auto* d = static_cast<ObservableData*>(JS_GetOpaque2(ctx, this_val, observable_class_id));
    if (!d) return JS_EXCEPTION;
    JSValue observer = argc > 0 ? argv[0] : JS_UNDEFINED;
    return subscribe_with_callback(ctx, d->subscribe_cb, observer);
}

static JSValue observable_pipe(JSContext* ctx, JSValueConst this_val, int argc,
                               JSValueConst* argv) {
    JSValue current = JS_DupValue(ctx, this_val);
    for (int i = 0; i < argc; i++) {
        if (!JS_IsFunction(ctx, argv[i])) {
            JS_FreeValue(ctx, current);
            return JS_ThrowTypeError(ctx, "pipe: arguments must be operator functions");
        }
        JSValue next = JS_Call(ctx, argv[i], JS_UNDEFINED, 1, &current);
        JS_FreeValue(ctx, current);
        if (JS_IsException(next)) return next;
        current = next;
    }
    return current;
}

static JSValue observable_constructor(JSContext* ctx, JSValueConst new_target, int argc,
                                      JSValueConst* argv) {
    (void)new_target;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "Observable: constructor requires a function argument");
    }
    JSValue obj = JS_NewObjectClass(ctx, observable_class_id);
    if (JS_IsException(obj)) return obj;
    auto* d = new ObservableData{JS_DupValue(ctx, argv[0])};
    JS_SetOpaque(obj, d);
    return obj;
}

/* ── Observable.from ─────────────────────────────────────────────── */

/* Build an Observable from an arbitrary subscribe callback (C function). */
static JSValue make_observable_with_cb(JSContext* ctx, JSValue subscribe_cb_taking_ownership) {
    JSValue obj = JS_NewObjectClass(ctx, observable_class_id);
    if (JS_IsException(obj)) {
        JS_FreeValue(ctx, subscribe_cb_taking_ownership);
        return obj;
    }
    auto* d = new ObservableData{subscribe_cb_taking_ownership};
    JS_SetOpaque(obj, d);
    return obj;
}

/* QuickJS-NG doesn't export JS_GetIterator/JS_IteratorNext. Implement
 * iteration manually via Symbol.iterator + .next() / .done / .value.
 * Returns the iterator object on success, JS_EXCEPTION on error.
 * Caller frees the returned value. */
static JSValue get_iterator(JSContext* ctx, JSValueConst src) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue symbol_obj = JS_GetPropertyStr(ctx, global, "Symbol");
    JS_FreeValue(ctx, global);
    JSValue iter_sym = JS_GetPropertyStr(ctx, symbol_obj, "iterator");
    JS_FreeValue(ctx, symbol_obj);
    if (JS_IsException(iter_sym)) return iter_sym;

    JSAtom iter_atom = JS_ValueToAtom(ctx, iter_sym);
    JS_FreeValue(ctx, iter_sym);
    if (iter_atom == JS_ATOM_NULL) return JS_EXCEPTION;

    JSValue iter_method = JS_GetProperty(ctx, src, iter_atom);
    JS_FreeAtom(ctx, iter_atom);
    if (JS_IsException(iter_method)) return iter_method;
    if (!JS_IsFunction(ctx, iter_method)) {
        JS_FreeValue(ctx, iter_method);
        return JS_ThrowTypeError(ctx, "value is not iterable");
    }

    JSValue iterator = JS_Call(ctx, iter_method, src, 0, nullptr);
    JS_FreeValue(ctx, iter_method);
    return iterator;
}

/* Pull the next value from a manually-driven iterator.
 * Sets *done = true if iteration is complete (and returns JS_UNDEFINED).
 * Returns JS_EXCEPTION on protocol error. Caller frees the returned value. */
static JSValue iterator_next(JSContext* ctx, JSValueConst iterator, bool* done) {
    JSAtom next_atom = JS_NewAtom(ctx, "next");
    JSValue result = JS_Invoke(ctx, iterator, next_atom, 0, nullptr);
    JS_FreeAtom(ctx, next_atom);
    if (JS_IsException(result)) return result;

    JSValue done_val = JS_GetPropertyStr(ctx, result, "done");
    int done_int = JS_ToBool(ctx, done_val);
    JS_FreeValue(ctx, done_val);
    if (done_int < 0) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    *done = done_int == 1;

    if (*done) {
        JS_FreeValue(ctx, result);
        return JS_UNDEFINED;
    }
    JSValue value = JS_GetPropertyStr(ctx, result, "value");
    JS_FreeValue(ctx, result);
    return value;
}

/* Helper: Observable.from(iterable) — sync drain. The iterable is captured
 * via a small wrapper object so the C function can recover it on subscribe. */

/* Closure data attached to a from-iterable subscribe callback. */
struct FromIterableCtx {
    JSValue iterable;
};

static JSClassID from_iter_class_id;
static void from_iter_finalizer(JSRuntime* rt, JSValue val) {
    auto* c = static_cast<FromIterableCtx*>(JS_GetOpaque(val, from_iter_class_id));
    if (!c) return;
    JS_FreeValueRT(rt, c->iterable);
    delete c;
}
static void from_iter_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* c = static_cast<FromIterableCtx*>(JS_GetOpaque(val, from_iter_class_id));
    if (!c) return;
    JS_MarkValue(rt, c->iterable, mark_func);
}
static JSClassDef from_iter_class_def = {
    "FromIterableCtx",
    from_iter_finalizer,
    from_iter_gc_mark,
    nullptr,
    nullptr,
};

static JSValue from_iterable_subscribe(JSContext* ctx, JSValueConst this_val, int argc,
                                       JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    if (argc < 1) return JS_UNDEFINED;
    JSValue subscriber = argv[0];

    /* func_data[0] holds an opaque object carrying the iterable. */
    auto* c = static_cast<FromIterableCtx*>(JS_GetOpaque(func_data[0], from_iter_class_id));
    if (!c) return JS_ThrowInternalError(ctx, "from_iterable: missing context");

    JSValue iterator = get_iterator(ctx, c->iterable);
    if (JS_IsException(iterator)) return iterator;

    JSAtom next_atom = JS_NewAtom(ctx, "next");

    bool done = false;
    while (!done) {
        /* Check closed before each pull so take(N) downstream can stop us
         * synchronously inside the loop. */
        auto* sd = static_cast<SubscriberData*>(
            JS_GetOpaque(subscriber, subscriber_class_id));
        if (!sd || sd->closed) break;

        JSValue value = iterator_next(ctx, iterator, &done);
        if (JS_IsException(value)) {
            JS_FreeAtom(ctx, next_atom);
            JS_FreeValue(ctx, iterator);
            return value;
        }
        if (done) {
            JS_FreeValue(ctx, value);
            break;
        }
        invoke_safely(ctx, subscriber, next_atom, 1, &value);
        JS_FreeValue(ctx, value);
    }
    JS_FreeAtom(ctx, next_atom);
    JS_FreeValue(ctx, iterator);

    auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(subscriber, subscriber_class_id));
    if (sd && !sd->closed) {
        JSAtom complete_atom = JS_NewAtom(ctx, "complete");
        invoke_safely(ctx, subscriber, complete_atom, 0, nullptr);
        JS_FreeAtom(ctx, complete_atom);
    }
    return JS_UNDEFINED;
}

struct FromPromiseCtx {
    JSValue promise;
};

static JSClassID from_promise_class_id;
static void from_promise_finalizer(JSRuntime* rt, JSValue val) {
    auto* c = static_cast<FromPromiseCtx*>(JS_GetOpaque(val, from_promise_class_id));
    if (!c) return;
    JS_FreeValueRT(rt, c->promise);
    delete c;
}
static void from_promise_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* c = static_cast<FromPromiseCtx*>(JS_GetOpaque(val, from_promise_class_id));
    if (!c) return;
    JS_MarkValue(rt, c->promise, mark_func);
}
static JSClassDef from_promise_class_def = {
    "FromPromiseCtx",
    from_promise_finalizer,
    from_promise_gc_mark,
    nullptr,
    nullptr,
};

/* The .then handler: argv[0] = resolved value, func_data[0] = subscriber. */
static JSValue from_promise_on_resolve(JSContext* ctx, JSValueConst this_val, int argc,
                                       JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    JSValue subscriber = func_data[0];
    auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(subscriber, subscriber_class_id));
    if (!sd || sd->closed) return JS_UNDEFINED;

    JSValue value = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSAtom next_atom = JS_NewAtom(ctx, "next");
    invoke_safely(ctx, subscriber, next_atom, 1, &value);
    JS_FreeAtom(ctx, next_atom);

    /* Re-check closed: an observer's next handler may have unsubscribed. */
    if (sd->closed) return JS_UNDEFINED;
    JSAtom complete_atom = JS_NewAtom(ctx, "complete");
    invoke_safely(ctx, subscriber, complete_atom, 0, nullptr);
    JS_FreeAtom(ctx, complete_atom);
    return JS_UNDEFINED;
}

static JSValue from_promise_subscribe(JSContext* ctx, JSValueConst this_val, int argc,
                                      JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    if (argc < 1) return JS_UNDEFINED;
    JSValueConst subscriber = argv[0];

    auto* c = static_cast<FromPromiseCtx*>(JS_GetOpaque(func_data[0], from_promise_class_id));
    if (!c) return JS_ThrowInternalError(ctx, "from_promise: missing context");

    JSValue subscriber_dup = JS_DupValue(ctx, subscriber);
    JSValue then_handler =
        JS_NewCFunctionData(ctx, from_promise_on_resolve, 1, 0, 1, &subscriber_dup);
    JS_FreeValue(ctx, subscriber_dup);

    JSAtom then_atom = JS_NewAtom(ctx, "then");
    JSValue ret = JS_Invoke(ctx, c->promise, then_atom, 1, &then_handler);
    JS_FreeAtom(ctx, then_atom);
    JS_FreeValue(ctx, then_handler);
    if (JS_IsException(ret)) return ret;
    JS_FreeValue(ctx, ret);
    return JS_UNDEFINED;
}

static JSValue observable_from(JSContext* ctx, JSValueConst this_val, int argc,
                               JSValueConst* argv) {
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "Observable.from: requires a source argument");
    }
    JSValueConst src = argv[0];

    /* (1) Already an Observable — passthrough. */
    if (JS_IsObject(src) &&
        JS_GetOpaque(src, observable_class_id) != nullptr) {
        return JS_DupValue(ctx, src);
    }

    /* (2) PromiseLike — has a callable .then */
    if (JS_IsObject(src)) {
        JSValue then_method = JS_GetPropertyStr(ctx, src, "then");
        bool is_thenable = JS_IsFunction(ctx, then_method);
        JS_FreeValue(ctx, then_method);
        if (is_thenable) {
            JSValue ctx_obj = JS_NewObjectClass(ctx, from_promise_class_id);
            if (JS_IsException(ctx_obj)) return ctx_obj;
            auto* c = new FromPromiseCtx{JS_DupValue(ctx, src)};
            JS_SetOpaque(ctx_obj, c);
            JSValue subscribe_cb =
                JS_NewCFunctionData(ctx, from_promise_subscribe, 1, 0, 1, &ctx_obj);
            JS_FreeValue(ctx, ctx_obj);
            return make_observable_with_cb(ctx, subscribe_cb);
        }
    }

    /* (3) Iterable — has @@iterator. */
    if (JS_IsObject(src) || JS_IsString(src)) {
        JSValue iter_test = get_iterator(ctx, src);
        if (!JS_IsException(iter_test)) {
            JS_FreeValue(ctx, iter_test);
            JSValue ctx_obj = JS_NewObjectClass(ctx, from_iter_class_id);
            if (JS_IsException(ctx_obj)) return ctx_obj;
            auto* c = new FromIterableCtx{JS_DupValue(ctx, src)};
            JS_SetOpaque(ctx_obj, c);
            JSValue subscribe_cb =
                JS_NewCFunctionData(ctx, from_iterable_subscribe, 1, 0, 1, &ctx_obj);
            JS_FreeValue(ctx, ctx_obj);
            return make_observable_with_cb(ctx, subscribe_cb);
        }
        /* Clear the iterability check failure so we can throw a clearer
         * "unsupported source" error below. */
        JS_GetException(ctx);
    }

    return JS_ThrowTypeError(
        ctx, "Observable.from: source must be a Promise, Iterable, or Observable");
}

/* ── Observable.withEmitters ────────────────────────────────────── */

/* The multicast source backing withEmitters().
 *
 * - subscribers: snapshot-on-dispatch via slice-into-local, so a subscriber
 *   unsubscribing during dispatch doesn't shift indices we're iterating.
 * - completed: idempotent close. After complete(), late subscribers receive
 *   complete() immediately during subscribe.
 * - Re-entrant next() dispatches recursively (matches RxJS Subject default).
 */
struct MulticastState {
    JSContext* ctx;
    bool completed;
    /* JSValues for each subscriber: opaque references kept alive by the
     * MulticastState's GC mark hook. */
    std::vector<JSValue> subscribers;
};

static JSClassID multicast_class_id;

static void multicast_finalizer(JSRuntime* rt, JSValue val) {
    auto* m = static_cast<MulticastState*>(JS_GetOpaque(val, multicast_class_id));
    if (!m) return;
    for (auto& s : m->subscribers) JS_FreeValueRT(rt, s);
    delete m;
}

static void multicast_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* m = static_cast<MulticastState*>(JS_GetOpaque(val, multicast_class_id));
    if (!m) return;
    for (auto& s : m->subscribers) JS_MarkValue(rt, s, mark_func);
}

static JSClassDef multicast_class_def = {
    "MulticastState",
    multicast_finalizer,
    multicast_gc_mark,
    nullptr,
    nullptr,
};

/* The subscribe callback for the multicast Observable. */
static JSValue multicast_subscribe(JSContext* ctx, JSValueConst this_val, int argc,
                                   JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    if (argc < 1) return JS_UNDEFINED;
    JSValueConst subscriber = argv[0];

    auto* m = static_cast<MulticastState*>(JS_GetOpaque(func_data[0], multicast_class_id));
    if (!m) return JS_ThrowInternalError(ctx, "multicast_subscribe: missing context");

    if (m->completed) {
        /* Late subscriber: complete immediately. */
        JSAtom complete_atom = JS_NewAtom(ctx, "complete");
        invoke_safely(ctx, subscriber, complete_atom, 0, nullptr);
        JS_FreeAtom(ctx, complete_atom);
        return JS_UNDEFINED;
    }

    /* Add to roster. The multicast holds a reference; the teardown removes it. */
    JSValue dup = JS_DupValue(ctx, subscriber);
    m->subscribers.push_back(dup);

    /* Register teardown that removes this subscriber from the multicast list.
     * Capture the multicast context object via func_data so the teardown
     * survives the subscribe call returning. */
    JSValue mc_ref = JS_DupValue(ctx, func_data[0]);
    JSValue teardown_data[2] = {mc_ref, dup};

    auto teardown_fn = [](JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                          int magic, JSValue* func_data) -> JSValue {
        (void)this_val;
        (void)argc;
        (void)argv;
        (void)magic;
        auto* m = static_cast<MulticastState*>(
            JS_GetOpaque(func_data[0], multicast_class_id));
        if (!m) return JS_UNDEFINED;
        for (auto it = m->subscribers.begin(); it != m->subscribers.end(); ++it) {
            if (JS_VALUE_GET_PTR(*it) == JS_VALUE_GET_PTR(func_data[1])) {
                JS_FreeValue(ctx, *it);
                m->subscribers.erase(it);
                break;
            }
        }
        return JS_UNDEFINED;
    };

    JSValue td = JS_NewCFunctionData(ctx, teardown_fn, 0, 0, 2, teardown_data);
    JS_FreeValue(ctx, mc_ref);
    /* dup is owned by m->subscribers, no free here. */

    JSValue ret = JS_Invoke(ctx, subscriber, JS_NewAtom(ctx, "addTeardown"), 1, &td);
    JS_FreeValue(ctx, td);
    if (JS_IsException(ret)) return ret;
    JS_FreeValue(ctx, ret);

    return JS_UNDEFINED;
}

/* withEmitters()'s `next` function. func_data[0] = multicast context. */
static JSValue multicast_emit_next(JSContext* ctx, JSValueConst this_val, int argc,
                                   JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)magic;
    auto* m = static_cast<MulticastState*>(JS_GetOpaque(func_data[0], multicast_class_id));
    if (!m || m->completed) return JS_UNDEFINED;

    /* Snapshot for safe iteration: a subscriber's next handler might
     * unsubscribe during dispatch, modifying m->subscribers. */
    std::vector<JSValue> snapshot;
    snapshot.reserve(m->subscribers.size());
    for (auto& s : m->subscribers) snapshot.push_back(JS_DupValue(ctx, s));

    JSValue value = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSAtom next_atom = JS_NewAtom(ctx, "next");
    for (auto& s : snapshot) {
        auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(s, subscriber_class_id));
        if (!sd || sd->closed) {
            JS_FreeValue(ctx, s);
            continue;
        }
        invoke_safely(ctx, s, next_atom, 1, &value);
        JS_FreeValue(ctx, s);
    }
    JS_FreeAtom(ctx, next_atom);
    return JS_UNDEFINED;
}

/* withEmitters()'s `complete` function. */
static JSValue multicast_emit_complete(JSContext* ctx, JSValueConst this_val, int argc,
                                       JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    auto* m = static_cast<MulticastState*>(JS_GetOpaque(func_data[0], multicast_class_id));
    if (!m || m->completed) return JS_UNDEFINED;
    m->completed = true;

    /* Drain subscribers, completing each. We've taken them out of the roster
     * before dispatch so any reentrant emit() finds an empty list. */
    std::vector<JSValue> snapshot;
    snapshot.swap(m->subscribers);

    JSAtom complete_atom = JS_NewAtom(ctx, "complete");
    for (auto& s : snapshot) {
        auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(s, subscriber_class_id));
        if (sd && !sd->closed) {
            invoke_safely(ctx, s, complete_atom, 0, nullptr);
        }
        JS_FreeValue(ctx, s);
    }
    JS_FreeAtom(ctx, complete_atom);
    return JS_UNDEFINED;
}

static JSValue observable_with_emitters(JSContext* ctx, JSValueConst this_val, int argc,
                                        JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue mc_obj = JS_NewObjectClass(ctx, multicast_class_id);
    if (JS_IsException(mc_obj)) return mc_obj;
    auto* m = new MulticastState{ctx, false, {}};
    JS_SetOpaque(mc_obj, m);

    JSValue subscribe_cb = JS_NewCFunctionData(ctx, multicast_subscribe, 1, 0, 1, &mc_obj);
    JSValue observable = make_observable_with_cb(ctx, subscribe_cb);
    if (JS_IsException(observable)) {
        JS_FreeValue(ctx, mc_obj);
        return observable;
    }

    JSValue next_fn = JS_NewCFunctionData(ctx, multicast_emit_next, 1, 0, 1, &mc_obj);
    JSValue complete_fn = JS_NewCFunctionData(ctx, multicast_emit_complete, 0, 0, 1, &mc_obj);
    JS_FreeValue(ctx, mc_obj);

    JSValue result = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, result, "observable", observable, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, result, "next", next_fn, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, result, "complete", complete_fn, JS_PROP_C_W_E);
    return result;
}

/* ── Observable prototype ─────────────────────────────────────────── */

static const JSCFunctionListEntry observable_proto_funcs[] = {
    JS_CFUNC_DEF("subscribe", 1, observable_subscribe),
    JS_CFUNC_DEF("pipe", 1, observable_pipe),
};

/* ── Module init ──────────────────────────────────────────────────── */

static int observable_module_init(JSContext* ctx, JSModuleDef* m) {
    /* Build prototype objects and bind to class IDs. The classes themselves
     * are registered by mik__observable_init below. */
    JSValue subscriber_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, subscriber_proto, subscriber_proto_funcs,
                               sizeof(subscriber_proto_funcs) /
                                   sizeof(subscriber_proto_funcs[0]));
    JS_SetClassProto(ctx, subscriber_class_id, subscriber_proto);

    JSValue subscription_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, subscription_proto, subscription_proto_funcs,
                               sizeof(subscription_proto_funcs) /
                                   sizeof(subscription_proto_funcs[0]));
    JS_SetClassProto(ctx, subscription_class_id, subscription_proto);

    JSValue obs_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, obs_proto, observable_proto_funcs,
                               sizeof(observable_proto_funcs) /
                                   sizeof(observable_proto_funcs[0]));
    JS_SetClassProto(ctx, observable_class_id, obs_proto);

    JSValue obs_ctor = JS_NewCFunction2(ctx, observable_constructor, "Observable", 1,
                                        JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, obs_ctor, obs_proto);

    JS_DefinePropertyValueStr(
        ctx, obs_ctor, "from",
        JS_NewCFunction(ctx, observable_from, "from", 1), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(
        ctx, obs_ctor, "withEmitters",
        JS_NewCFunction(ctx, observable_with_emitters, "withEmitters", 0), JS_PROP_C_W_E);

    JS_SetModuleExport(ctx, m, "Observable", obs_ctor);
    return 0;
}

}  // namespace

JSModuleDef* mik__observable_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Class IDs are runtime-scoped; safe to register once per runtime. */
    JS_NewClassID(rt, &observable_class_id);
    JS_NewClass(rt, observable_class_id, &observable_class_def);
    JS_NewClassID(rt, &subscriber_class_id);
    JS_NewClass(rt, subscriber_class_id, &subscriber_class_def);
    JS_NewClassID(rt, &subscription_class_id);
    JS_NewClass(rt, subscription_class_id, &subscription_class_def);
    JS_NewClassID(rt, &from_iter_class_id);
    JS_NewClass(rt, from_iter_class_id, &from_iter_class_def);
    JS_NewClassID(rt, &from_promise_class_id);
    JS_NewClass(rt, from_promise_class_id, &from_promise_class_def);
    JS_NewClassID(rt, &multicast_class_id);
    JS_NewClass(rt, multicast_class_id, &multicast_class_def);

    JSModuleDef* m = JS_NewCModule(ctx, "native:observable", observable_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Observable");
    return m;
}

/* mik_observable.cpp — push-based composable event stream primitive.
 *
 * See .claude/plans/observable.md (worktree branch) for the locked design.
 *
 * Classes registered:
 *   - Observable: constructor(cb), subscribe(observer), pipe(...ops),
 *                 static withEmitters()
 *                 (cb may return a function; it is registered as a teardown)
 *   - from(src): module function, promise or iterable -> Observable
 *   - of(...values): module function, from() over the argument array
 *   - Subscriber (internal handle passed to subscribe callback): next, complete,
 *                 addTeardown, closed
 *   - Subscription: unsubscribe
 *
 * A second module, mikro/observable/operators, holds every operator (map,
 * filter, take, timer, switchMap, debounceTime, ...). It is loaded lazily
 * through the C-module table in modules.cpp, so runtimes that never import
 * it pay nothing. Per-subscription operator state lives in a C struct and
 * upstream subscribers dispatch straight into C handlers, so a chain costs no
 * JS closures per value or per subscription and no bytecode per app.
 *
 * Error semantics: a throw inside an observer, operator, or teardown callback
 * is caught at the dispatch boundary only to report it and apply the app's
 * onPanic policy; it is an application crash like any other uncaught error.
 * Nothing further is delivered: queued entries are dropped, the multicast
 * fan-out stops, from(iterable) stops pulling, and later next/complete calls
 * from the producer's own callback (which JS cannot interrupt mid-function)
 * are no-ops. Teardowns are the exception, since they release resources for
 * work that is already ending; the rest of the chain still runs.
 *
 * Producer-setup throws inside the subscribe callback bubble synchronously
 * to the .subscribe() caller — that's a bug in the producer factory itself,
 * not a runtime dispatch event. Teardowns registered before the throw still
 * run: no Subscription reaches the caller, so nothing else could ever
 * release what the producer already acquired.
 *
 * Dispatch trampoline: next/complete invoked while a dispatch is already
 * active (i.e. from inside a handler) enqueue onto a per-runtime FIFO
 * instead of recursing; the outermost dispatch drains the queue before
 * returning. Chain length and re-entrant emission therefore cost O(1)
 * stack per delivery — on-device JS stacks are small and quickjs-ng 0.16
 * frames are large enough that a 3-operator chain used to exhaust a 16 KB
 * limit. Two consequences:
 *   - Handler code after a sub.next()/sub.complete() call runs before the
 *     downstream handler sees that event (FIFO order is preserved).
 *   - complete() closes the subscriber at the call site (complete_pending),
 *     so closed/no-op semantics stay synchronous while the complete_fn +
 *     teardowns run when the queued entry drains.
 * Delivery is what became O(1) stack, not subscription setup or teardown:
 * subscribe() recurses once per chain layer (user JS calling subscribe), and
 * unsubscribe -> run_teardowns -> upstream.unsubscribe() mirrors it on the
 * way out. Both are paid once per subscription rather than once per value,
 * so neither reintroduces a per-value ceiling.
 * Trade-off: what used to be bounded stack growth is now unbounded heap
 * growth. A synchronous producer emitting N values from inside a dispatch
 * buffers N entries (plus the retained values) instead of recursing N deep.
 * That turns a catchable stack overflow into heap pressure, which on device
 * ends in an OOM panic. Left uncapped deliberately: no shipped producer
 * emits unbounded bursts from inside a handler.
 */

#include <cstddef>
#include <cstdint>
#include <vector>

#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

extern "C" {
#include "quickjs.h"
}

/* Per-runtime dispatch queue. Entries hold their own references (dup on
 * enqueue, freed after the drained delivery). The queue is only non-empty
 * while a dispatch is on the stack, so runtime teardown never sees values. */
struct MIKObservableDispatch {
    struct Entry {
        JSValue subscriber;
        JSValue value; /* JS_UNDEFINED for complete entries */
        bool is_complete;
    };
    bool active = false;
    size_t head = 0;
    std::vector<Entry> queue;
};

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
    /* complete() was called while queued dispatch was active: the subscriber
     * is closed to producers, but complete_fn + teardowns run when the queued
     * complete entry drains. */
    bool complete_pending;
    /* observer object retained so its props can't be reclaimed mid-dispatch. */
    JSValue observer;
    JSValue next_fn;
    JSValue complete_fn;
    /* Teardowns are functions, or upstream Subscriber objects that are
     * unsubscribed in place of a call (see run_teardown_entry). */
    std::vector<JSValue> teardowns;
    /* Set for a native operator's upstream subscriber: deliveries go to
     * op_on_next/op_on_complete with this state instead of next_fn/complete_fn.
     * Released once the subscriber closes. */
    JSValue op_state = JS_UNDEFINED;
    int op_index = 0;
};

struct SubscriptionData {
    /* Owns the subscriber JSValue so unsubscribe() can reach the SubscriberData
     * even after the producer's reference drops. */
    JSValue subscriber_value;
};

/* ── Helpers ─────────────────────────────────────────────────────── */

/* An uncaught throw from a subscriber, operator, or teardown callback is an
 * application crash like any other: report it, notify the host error handler,
 * and apply the app's onPanic policy. Reporting happens here rather than
 * through a deferred re-throw because MIK_Loop stops pumping timers once the
 * panic is armed, so a deferred report would never run. Consumes
 * `exception`. */
static void panic(JSContext* ctx, JSValue exception) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik__report_uncaught(ctx, exception, false) && mik_rt) {
        if (mik_rt->error_handler_fn) {
            mik_rt->error_handler_fn(ctx, exception, mik_rt->error_handler_opaque);
        }
        MIK_Stop(mik_rt);
    }
    JS_FreeValue(ctx, exception);
}

/* Call `fn(argv...)` synchronously and return its result (owned); a throw
 * panics and yields JS_EXCEPTION. */
static JSValue call_or_panic(JSContext* ctx, JSValueConst fn, int argc, JSValueConst* argv) {
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    if (JS_IsException(ret)) {
        panic(ctx, JS_GetException(ctx));
    }
    return ret;
}

/* Call `fn(argv...)` synchronously; a throw panics. Caller is not informed. */
static void run_safely(JSContext* ctx, JSValue fn, int argc, JSValue* argv) {
    JS_FreeValue(ctx, call_or_panic(ctx, fn, argc, argv));
}

/* Same panic-on-throw semantics as run_safely, for invoke-by-method calls
 * (used when we don't have direct access to the C-level subscriber struct
 * — multicast dispatch, from-iterable, from-promise). */
static void invoke_safely(JSContext* ctx, JSValueConst this_val, JSAtom method, int argc,
                          JSValueConst* argv) {
    JSValue ret = JS_Invoke(ctx, this_val, method, argc, argv);
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        panic(ctx, exc);
    } else {
        JS_FreeValue(ctx, ret);
    }
}

static void close_subscriber(JSContext* ctx, SubscriberData* d);
static bool op_teardown(JSContext* ctx, JSValueConst entry);

/* A teardown entry is a function to call, an upstream subscriber to close, or
 * an operator state whose timer and inner subscription end with it. */
static void run_teardown_entry(JSContext* ctx, JSValueConst entry) {
    auto* up = static_cast<SubscriberData*>(JS_GetOpaque(entry, subscriber_class_id));
    if (up) {
        close_subscriber(ctx, up);
    } else if (!op_teardown(ctx, entry)) {
        run_safely(ctx, entry, 0, nullptr);
    }
}

/* Run all registered teardowns in reverse insertion order. A throw panics,
 * but the remaining teardowns still run: they release resources for work
 * that is already ending. */
static void run_teardowns(JSContext* ctx, SubscriberData* d) {
    /* Swap into a local list. If a teardown calls addTeardown synchronously,
     * the SubscriberData.closed flag is already true so addTeardown fires the
     * new callback immediately (handled in add_teardown). */
    std::vector<JSValue> list;
    list.swap(d->teardowns);
    for (auto it = list.rbegin(); it != list.rend(); ++it) {
        run_teardown_entry(ctx, *it);
        JS_FreeValue(ctx, *it);
    }
}

/* Register `entry` (owned) as a teardown; on a closed subscriber it runs at
 * once instead, so a late registration can never leak. */
static void add_teardown(JSContext* ctx, SubscriberData* d, JSValue entry) {
    if (d->closed) {
        run_teardown_entry(ctx, entry);
        JS_FreeValue(ctx, entry);
    } else {
        d->teardowns.push_back(entry);
    }
}

static void release_op_state(JSContext* ctx, SubscriberData* d) {
    JSValue state = d->op_state;
    d->op_state = JS_UNDEFINED;
    JS_FreeValue(ctx, state);
}

/* Silent close: teardowns run, the observer is not told. Idempotent. A
 * pending complete owns the close: its queued entry delivers complete_fn +
 * teardowns, matching the recursive-dispatch order where the complete had
 * already run before unsubscribe could. */
static void close_subscriber(JSContext* ctx, SubscriberData* d) {
    if (d->closed || d->complete_pending) return;
    d->closed = true;
    run_teardowns(ctx, d);
    release_op_state(ctx, d);
}

/* ── Dispatch trampoline ────────────────────────────────────────── */

static MIKObservableDispatch* dispatch_state(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    return mik_rt ? mik_rt->observable_dispatch : nullptr;
}

/* True once a panic is armed. The producer's own callback keeps running (JS
 * cannot be stopped mid-function), so its later next/complete calls have to
 * become no-ops rather than delivering against crashed state. */
static bool dispatch_stopped(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    return mik_rt && MIK_IsStopRequested(mik_rt);
}

static void op_on_next(JSContext* ctx, JSValueConst state, int index, JSValueConst value);
static void op_on_complete(JSContext* ctx, JSValueConst state, int index, SubscriberData* from);

/* Deliver a value to the subscriber's next handler. `value` is borrowed. */
static void deliver_next(JSContext* ctx, SubscriberData* d, JSValue value) {
    if (!JS_IsUndefined(d->op_state)) {
        /* Hold the state: the handler may close this subscriber, which
         * releases d->op_state. */
        JSValue state = JS_DupValue(ctx, d->op_state);
        op_on_next(ctx, state, d->op_index, value);
        JS_FreeValue(ctx, state);
    } else if (!JS_IsUndefined(d->next_fn)) {
        run_safely(ctx, d->next_fn, 1, &value);
    }
}

static void deliver_complete(JSContext* ctx, SubscriberData* d) {
    d->complete_pending = false;
    d->closed = true;
    if (!JS_IsUndefined(d->op_state)) {
        JSValue state = JS_DupValue(ctx, d->op_state);
        op_on_complete(ctx, state, d->op_index, d);
        JS_FreeValue(ctx, state);
    } else if (!JS_IsUndefined(d->complete_fn)) {
        run_safely(ctx, d->complete_fn, 0, nullptr);
    }
    run_teardowns(ctx, d);
    release_op_state(ctx, d);
}

/* Drain queued deliveries in FIFO order. Deliveries may enqueue more; the
 * loop keeps going until the queue is empty. Entries whose subscriber closed
 * (unsubscribed) between enqueue and drain are dropped. */
static void drain(JSContext* ctx, MIKObservableDispatch* ds) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    while (ds->head < ds->queue.size()) {
        MIKObservableDispatch::Entry e = ds->queue[ds->head++];
        auto* d = static_cast<SubscriberData*>(JS_GetOpaque(e.subscriber, subscriber_class_id));
        /* A panicked handler means the state these deliveries were queued
         * against may be broken; free the rest without delivering. */
        bool stopped = mik_rt && MIK_IsStopRequested(mik_rt);
        if (d && !d->closed && !stopped) {
            if (e.is_complete) {
                deliver_complete(ctx, d);
            } else {
                deliver_next(ctx, d, e.value);
            }
        }
        JS_FreeValue(ctx, e.subscriber);
        JS_FreeValue(ctx, e.value);
    }
    ds->queue.clear();
    ds->head = 0;
    /* Don't let a one-off burst pin its capacity for the runtime lifetime. */
    if (ds->queue.capacity() > 32) {
        std::vector<MIKObservableDispatch::Entry>().swap(ds->queue);
    }
}

/* ── Subscriber ─────────────────────────────────────────────────── */

static void subscriber_finalizer(JSRuntime* rt, JSValue val) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(val, subscriber_class_id));
    if (!d) return;
    JS_FreeValueRT(rt, d->observer);
    JS_FreeValueRT(rt, d->next_fn);
    JS_FreeValueRT(rt, d->complete_fn);
    JS_FreeValueRT(rt, d->op_state);
    for (auto& td : d->teardowns) JS_FreeValueRT(rt, td);
    delete d;
}

static void subscriber_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(val, subscriber_class_id));
    if (!d) return;
    JS_MarkValue(rt, d->observer, mark_func);
    JS_MarkValue(rt, d->next_fn, mark_func);
    JS_MarkValue(rt, d->complete_fn, mark_func);
    JS_MarkValue(rt, d->op_state, mark_func);
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
    if (d->closed || d->complete_pending) return JS_UNDEFINED;
    if (dispatch_stopped(ctx)) return JS_UNDEFINED;
    JSValue arg = argc > 0 ? argv[0] : JS_UNDEFINED;
    MIKObservableDispatch* ds = dispatch_state(ctx);
    if (!ds) {
        deliver_next(ctx, d, arg);
        return JS_UNDEFINED;
    }
    if (ds->active) {
        ds->queue.push_back({JS_DupValue(ctx, this_val), JS_DupValue(ctx, arg), false});
        return JS_UNDEFINED;
    }
    ds->active = true;
    deliver_next(ctx, d, arg);
    drain(ctx, ds);
    ds->active = false;
    return JS_UNDEFINED;
}

static JSValue subscriber_complete(JSContext* ctx, JSValueConst this_val, int argc,
                                   JSValueConst* argv) {
    (void)argc;
    (void)argv;
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    if (d->closed || d->complete_pending) return JS_UNDEFINED;
    if (dispatch_stopped(ctx)) return JS_UNDEFINED;
    MIKObservableDispatch* ds = dispatch_state(ctx);
    if (!ds) {
        deliver_complete(ctx, d);
        return JS_UNDEFINED;
    }
    if (ds->active) {
        d->complete_pending = true;
        ds->queue.push_back({JS_DupValue(ctx, this_val), JS_UNDEFINED, true});
        return JS_UNDEFINED;
    }
    ds->active = true;
    deliver_complete(ctx, d);
    drain(ctx, ds);
    ds->active = false;
    return JS_UNDEFINED;
}

static JSValue subscriber_add_teardown(JSContext* ctx, JSValueConst this_val, int argc,
                                       JSValueConst* argv) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "addTeardown: argument must be a function");
    }
    add_teardown(ctx, d, JS_DupValue(ctx, argv[0]));
    return JS_UNDEFINED;
}

static JSValue subscriber_get_closed(JSContext* ctx, JSValueConst this_val) {
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque2(ctx, this_val, subscriber_class_id));
    if (!d) return JS_EXCEPTION;
    return JS_NewBool(ctx, d->closed || d->complete_pending);
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
    /* unsubscribe() is silent — does NOT call observer.complete().
     * Only natural producer-driven completion fires observer.complete(). */
    if (sub) close_subscriber(ctx, sub);
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

/* Run the producer against a freshly built subscriber. Sync emission is
 * allowed: the producer may call next/complete inside the callback, so the
 * subscriber may already be closed on return; idempotent unsubscribe handles
 * it. Returns subscriber_val (ownership passes back), or JS_EXCEPTION with it
 * freed. */
static JSValue start_subscriber(JSContext* ctx, JSValueConst subscribe_cb, JSValue subscriber_val,
                                SubscriberData* d) {
    JSValue cb_result = JS_Call(ctx, subscribe_cb, JS_UNDEFINED, 1, &subscriber_val);
    if (JS_IsException(cb_result)) {
        /* Producer setup threw — bubble up, but release whatever it already
         * acquired first. No Subscription reaches the caller, so a teardown
         * skipped here can never run: the handle it would close is
         * unreachable for the rest of the runtime's life. Park the pending
         * exception while the teardowns run, since they are JS calls and
         * must not inherit it, then restore it for the caller.
         * A queued completion is different: that entry owns the close and
         * runs the teardowns when it drains. */
        if (!d->complete_pending) {
            d->closed = true;
            JSValue pending = JS_GetException(ctx);
            run_teardowns(ctx, d);
            JS_Throw(ctx, pending);
        }
        JS_FreeValue(ctx, subscriber_val);
        return cb_result;
    }
    if (JS_IsFunction(ctx, cb_result)) {
        /* A returned function is a teardown, exactly as if the producer had
         * passed it to addTeardown() last (owned; runs now if setup already
         * closed the subscriber). */
        add_teardown(ctx, d, cb_result);
    } else {
        JS_FreeValue(ctx, cb_result);
    }
    return subscriber_val;
}

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
        false,
        observer_dup,
        next_fn,
        complete_fn,
        {},
    };
    JS_SetOpaque(subscriber_val, d);

    subscriber_val = start_subscriber(ctx, subscribe_cb, subscriber_val, d);
    if (JS_IsException(subscriber_val)) return subscriber_val;
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

/* ── from / of ────────────────────────────────────────────────────── */

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

/* Helper: from(iterable) — sync drain. The iterable is captured
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
        MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
        if (mik_rt && MIK_IsStopRequested(mik_rt)) break;

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
        return JS_ThrowTypeError(ctx, "from: requires a source argument");
    }
    JSValueConst src = argv[0];

    /* (1) PromiseLike — has a callable .then */
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

    /* (2) Iterable — has @@iterator. */
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

    return JS_ThrowTypeError(ctx, "from: source must be a Promise or an Iterable");
}

/* of(...values): from() over the argument array. */
static JSValue observable_of(JSContext* ctx, JSValueConst this_val, int argc,
                             JSValueConst* argv) {
    (void)this_val;
    std::vector<JSValue> owned;
    owned.reserve(argc);
    for (int i = 0; i < argc; i++) owned.push_back(JS_DupValue(ctx, argv[i]));
    /* Takes ownership of the values, and frees them itself on failure. */
    JSValue values = JS_NewArrayFrom(ctx, argc, owned.data());
    if (JS_IsException(values)) return values;
    JSValue result = observable_from(ctx, JS_UNDEFINED, 1, &values);
    JS_FreeValue(ctx, values);
    return result;
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

    JSAtom teardown_atom = JS_NewAtom(ctx, "addTeardown");
    JSValue ret = JS_Invoke(ctx, subscriber, teardown_atom, 1, &td);
    JS_FreeAtom(ctx, teardown_atom);
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
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    for (auto& s : snapshot) {
        auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(s, subscriber_class_id));
        if (!sd || sd->closed || (mik_rt && MIK_IsStopRequested(mik_rt))) {
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
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    for (auto& s : snapshot) {
        auto* sd = static_cast<SubscriberData*>(JS_GetOpaque(s, subscriber_class_id));
        if (sd && !sd->closed && !(mik_rt && MIK_IsStopRequested(mik_rt))) {
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

/* ── Operators (mikro/observable/operators) ─────────────────────────── */

static void ensure_protos(JSContext* ctx);

/* Each factory (map(fn), take(n), ...) validates its arguments and returns
 * an operator function whose func_data holds them; applying it to a source
 * builds an Observable whose subscribe callback (op_subscribe) carries
 * [source, args...]. A C-function `magic` packs the kind in its low byte and
 * the captured argument count above it. */
enum OpKind : int {
    OP_MAP,
    OP_FILTER,
    OP_TAP,
    OP_TAKE,
    OP_SKIP,
    OP_SCAN,
    OP_DISTINCT,
    OP_START_WITH,
    OP_FINALIZE,
    OP_TAKE_UNTIL,
    OP_MERGE_WITH,
    OP_WITH_LATEST_FROM,
    OP_COMBINE_LATEST,
    OP_SWITCH_MAP,
    OP_TIMER,
    OP_DEBOUNCE,
    OP_THROTTLE,
    /* takeUntil(predicate), chosen by the takeUntil factory; not exported. */
    OP_TAKE_WHILE,
};

/* Indexed by OpKind; export names, and the prefix of every error message. */
static const char* const op_names[] = {
    "map",      "filter",    "tap",       "take",           "skip",          "scan",
    "distinctUntilChanged",  "startWith", "finalize",       "takeUntil",     "mergeWith",
    "withLatestFrom",        "combineLatest",              "switchMap",      "timer",
    "debounceTime",          "throttleTime",               "takeUntil",
};
static_assert(sizeof(op_names) / sizeof(op_names[0]) == OP_TAKE_WHILE + 1,
              "op_names must name every OpKind");

static inline int op_kind(int magic) { return magic & 0xff; }
static inline int op_argc(int magic) { return magic >> 8; }
static inline int op_magic(int kind, int argc) { return kind | (argc << 8); }

/* Per-subscription operator state, shared by every upstream subscriber the
 * operator opens. `down` is the subscriber the operator emits to. */
struct OpState {
    int kind = 0;
    JSValue down = JS_UNDEFINED;
    JSValue fn = JS_UNDEFINED;    /* callable argument, or JS_UNDEFINED */
    JSValue value = JS_UNDEFINED; /* accumulator, last value, latest of `other`, pending value */
    JSValue inner = JS_UNDEFINED; /* switchMap: the current inner upstream subscriber */
    /* combineLatest: latest value per source, JS_UNINITIALIZED until seen. */
    std::vector<JSValue> values;
    int32_t count = 0;    /* take/skip: remaining; mergeWith/combineLatest: open; timer: ticks */
    int32_t missing = 0;  /* combineLatest: sources yet to emit */
    int32_t ms = 0;       /* debounce/throttle window; timer period (-1: one-shot) */
    uint32_t timer_id = 0;
    bool flag = false;    /* has a value (distinct, withLatestFrom); inclusive; timer repeating */
    bool pending = false; /* debounce/throttle: `value` waits for the window to end */
    bool leading = false;
    bool trailing = false;
    bool inner_open = false;
    bool source_done = false;
};

static JSClassID op_state_class_id;

static void op_state_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<OpState*>(JS_GetOpaque(val, op_state_class_id));
    if (!s) return;
    JS_FreeValueRT(rt, s->down);
    JS_FreeValueRT(rt, s->fn);
    JS_FreeValueRT(rt, s->value);
    JS_FreeValueRT(rt, s->inner);
    for (auto& v : s->values) JS_FreeValueRT(rt, v);
    delete s;
}

static void op_state_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* s = static_cast<OpState*>(JS_GetOpaque(val, op_state_class_id));
    if (!s) return;
    JS_MarkValue(rt, s->down, mark_func);
    JS_MarkValue(rt, s->fn, mark_func);
    JS_MarkValue(rt, s->value, mark_func);
    JS_MarkValue(rt, s->inner, mark_func);
    for (auto& v : s->values) JS_MarkValue(rt, v, mark_func);
}

static JSClassDef op_state_class_def = {
    "OperatorState", op_state_finalizer, op_state_gc_mark, nullptr, nullptr,
};

static SubscriberData* op_down(OpState* s) {
    return static_cast<SubscriberData*>(JS_GetOpaque(s->down, subscriber_class_id));
}

static bool down_closed(OpState* s) {
    SubscriberData* d = op_down(s);
    return !d || d->closed || d->complete_pending;
}

/* Emit downstream through the regular next/complete entry points, so the
 * dispatch trampoline and closed checks apply exactly as for JS callers. */
static void emit(JSContext* ctx, OpState* s, JSValueConst value) {
    JSValue arg = value;
    JS_FreeValue(ctx, subscriber_next(ctx, s->down, 1, &arg));
}

static void finish(JSContext* ctx, OpState* s) {
    JS_FreeValue(ctx, subscriber_complete(ctx, s->down, 0, nullptr));
}

/* Emit a fresh array of `count` values (owned; consumed either way). */
static void emit_array(JSContext* ctx, OpState* s, int count, JSValue* owned) {
    JSValue arr = JS_NewArrayFrom(ctx, count, owned);
    if (JS_IsException(arr)) {
        panic(ctx, JS_GetException(ctx));
        return;
    }
    emit(ctx, s, arr);
    JS_FreeValue(ctx, arr);
}

/* Call `fn(argv...)` for its boolean result; a throw panics and yields false
 * with *ok cleared. */
static bool call_for_bool(JSContext* ctx, JSValueConst fn, int argc, JSValueConst* argv, bool* ok) {
    JSValue ret = call_or_panic(ctx, fn, argc, argv);
    *ok = !JS_IsException(ret);
    if (!*ok) return false;
    bool result = JS_ToBool(ctx, ret) == 1;
    JS_FreeValue(ctx, ret);
    return result;
}

static JSValue op_timer_fire(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                             int magic, JSValueConst* func_data);

/* Arm the operator's timer through the registry (never the JS setTimeout
 * global). The registry holds the callback, and with it `state`. */
static void schedule(JSContext* ctx, OpState* s, JSValueConst state, int32_t ms, bool repeat) {
    JSValue fn = JS_NewCFunctionData(ctx, op_timer_fire, 0, 0, 1, &state);
    if (JS_IsException(fn)) {
        panic(ctx, JS_GetException(ctx));
        return;
    }
    s->timer_id = MIK_Timer_Schedule(MIK_GetRuntime(ctx)->timers, ctx, fn, 0, nullptr,
                                     static_cast<int64_t>(ms) * 1000, repeat,
                                     MIK_GetPlatform()->get_boot_us());
    JS_FreeValue(ctx, fn);
}

static void unschedule(JSContext* ctx, OpState* s) {
    if (s->timer_id == 0) return;
    MIK_Timer_UnSchedule(MIK_GetRuntime(ctx)->timers, ctx, s->timer_id);
    s->timer_id = 0;
}

/* Emit the pending value, if any. Held across the emit: a synchronous
 * delivery may replace `s->value` before it returns. */
static void flush(JSContext* ctx, OpState* s) {
    if (!s->pending) return;
    s->pending = false;
    JSValue v = JS_DupValue(ctx, s->value);
    emit(ctx, s, v);
    JS_FreeValue(ctx, v);
}

static void set_pending(JSContext* ctx, OpState* s, JSValueConst value, bool pending) {
    JS_FreeValue(ctx, s->value);
    s->value = JS_DupValue(ctx, value);
    s->pending = pending;
}

static void close_inner(JSContext* ctx, OpState* s) {
    if (JS_IsUndefined(s->inner)) return;
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(s->inner, subscriber_class_id));
    if (d) close_subscriber(ctx, d);
    JSValue inner = s->inner;
    s->inner = JS_UNDEFINED;
    JS_FreeValue(ctx, inner);
}

/* Teardown for an operator state registered on its downstream subscriber:
 * ends the timer and the inner subscription. False if `entry` is no state. */
static bool op_teardown(JSContext* ctx, JSValueConst entry) {
    auto* s = static_cast<OpState*>(JS_GetOpaque(entry, op_state_class_id));
    if (!s) return false;
    unschedule(ctx, s);
    close_inner(ctx, s);
    return true;
}

static JSValue op_timer_fire(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                             int magic, JSValueConst* func_data) {
    (void)this_val;
    (void)argc;
    (void)argv;
    (void)magic;
    JSValueConst state = func_data[0];
    auto* s = static_cast<OpState*>(JS_GetOpaque(state, op_state_class_id));
    if (!s || down_closed(s)) return JS_UNDEFINED;
    switch (s->kind) {
        case OP_TIMER: {
            /* The registry drops a one-shot entry after it fires. */
            bool first = !s->flag;
            if (first) s->timer_id = 0;
            emit(ctx, s, JS_NewInt32(ctx, s->count++));
            if (!first || down_closed(s)) return JS_UNDEFINED;
            if (s->ms < 0) {
                finish(ctx, s);
                return JS_UNDEFINED;
            }
            s->flag = true;
            schedule(ctx, s, state, s->ms, true);
            return JS_UNDEFINED;
        }
        case OP_DEBOUNCE:
            s->timer_id = 0;
            flush(ctx, s);
            return JS_UNDEFINED;
        case OP_THROTTLE:
            s->timer_id = 0;
            if (!s->pending) return JS_UNDEFINED;
            flush(ctx, s);
            /* A trailing emission opens the next window. */
            if (!down_closed(s)) schedule(ctx, s, state, s->ms, false);
            return JS_UNDEFINED;
        default:
            return JS_UNDEFINED;
    }
}

/* Build an upstream subscriber that dispatches into `state` as number
 * `index`. Not started. */
static JSValue make_upstream(JSContext* ctx, JSValueConst state, int index) {
    JSValue sub_val = JS_NewObjectClass(ctx, subscriber_class_id);
    if (JS_IsException(sub_val)) return sub_val;
    auto* d = new SubscriberData{
        ctx, false, false, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, {}, JS_DupValue(ctx, state),
        index,
    };
    JS_SetOpaque(sub_val, d);
    return sub_val;
}

/* switchMap: replace the inner subscription with one to `project(value)`.
 * Runs inside a dispatch, so failures panic rather than throw. */
static void switch_inner(JSContext* ctx, OpState* s, JSValueConst state, JSValueConst value) {
    close_inner(ctx, s);
    JSValue source = call_or_panic(ctx, s->fn, 1, &value);
    if (JS_IsException(source)) return;
    auto* src = static_cast<ObservableData*>(JS_GetOpaque(source, observable_class_id));
    if (!src) {
        JS_FreeValue(ctx, source);
        JS_ThrowTypeError(ctx, "switchMap: project must return an Observable");
        panic(ctx, JS_GetException(ctx));
        return;
    }
    JSValue sub_val = make_upstream(ctx, state, 1);
    if (JS_IsException(sub_val)) {
        JS_FreeValue(ctx, source);
        panic(ctx, JS_GetException(ctx));
        return;
    }
    s->inner_open = true;
    s->inner = JS_DupValue(ctx, sub_val);
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(sub_val, subscriber_class_id));
    JSValue started = start_subscriber(ctx, src->subscribe_cb, sub_val, d);
    JS_FreeValue(ctx, source);
    if (JS_IsException(started)) {
        panic(ctx, JS_GetException(ctx));
        return;
    }
    JS_FreeValue(ctx, started);
}

static void op_on_next(JSContext* ctx, JSValueConst state, int index, JSValueConst value) {
    auto* s = static_cast<OpState*>(JS_GetOpaque(state, op_state_class_id));
    bool ok = true;
    switch (s->kind) {
        case OP_MAP: {
            JSValue out = call_or_panic(ctx, s->fn, 1, &value);
            if (JS_IsException(out)) return;
            emit(ctx, s, out);
            JS_FreeValue(ctx, out);
            return;
        }
        case OP_FILTER:
            if (call_for_bool(ctx, s->fn, 1, &value, &ok)) emit(ctx, s, value);
            return;
        case OP_TAP: {
            JSValue ret = call_or_panic(ctx, s->fn, 1, &value);
            if (JS_IsException(ret)) return;
            JS_FreeValue(ctx, ret);
            emit(ctx, s, value);
            return;
        }
        case OP_TAKE:
            if (s->count <= 0) return;
            s->count--;
            emit(ctx, s, value);
            if (s->count == 0) finish(ctx, s);
            return;
        case OP_SKIP:
            if (s->count > 0) {
                s->count--;
                return;
            }
            emit(ctx, s, value);
            return;
        case OP_SCAN: {
            JSValue args[2] = {s->value, value};
            JSValue acc = call_or_panic(ctx, s->fn, 2, args);
            if (JS_IsException(acc)) return;
            JS_FreeValue(ctx, s->value);
            s->value = acc;
            emit(ctx, s, acc);
            return;
        }
        case OP_DISTINCT: {
            if (s->flag) {
                bool same;
                if (JS_IsUndefined(s->fn)) {
                    same = JS_IsStrictEqual(ctx, s->value, value);
                } else {
                    JSValue args[2] = {s->value, value};
                    same = call_for_bool(ctx, s->fn, 2, args, &ok);
                    if (!ok) return;
                }
                if (same) return;
            }
            s->flag = true;
            JS_FreeValue(ctx, s->value);
            s->value = JS_DupValue(ctx, value);
            emit(ctx, s, value);
            return;
        }
        case OP_TAKE_UNTIL:
            /* index 1 is the notifier: any value ends the stream. */
            if (index == 1) {
                finish(ctx, s);
            } else {
                emit(ctx, s, value);
            }
            return;
        case OP_TAKE_WHILE: {
            bool stop = call_for_bool(ctx, s->fn, 1, &value, &ok);
            if (!ok) return;
            if (!stop || s->flag) emit(ctx, s, value);
            if (stop) finish(ctx, s);
            return;
        }
        case OP_WITH_LATEST_FROM: {
            /* index 1 is `other`: remember its latest value. */
            if (index == 1) {
                s->flag = true;
                JS_FreeValue(ctx, s->value);
                s->value = JS_DupValue(ctx, value);
                return;
            }
            if (!s->flag) return;
            JSValue pair[2] = {JS_DupValue(ctx, value), JS_DupValue(ctx, s->value)};
            emit_array(ctx, s, 2, pair);
            return;
        }
        case OP_COMBINE_LATEST: {
            if (JS_IsUninitialized(s->values[index])) {
                s->missing--;
            } else {
                JS_FreeValue(ctx, s->values[index]);
            }
            s->values[index] = JS_DupValue(ctx, value);
            if (s->missing > 0) return;
            int n = static_cast<int>(s->values.size());
            std::vector<JSValue> copy;
            copy.reserve(n);
            for (auto& v : s->values) copy.push_back(JS_DupValue(ctx, v));
            emit_array(ctx, s, n, copy.data());
            return;
        }
        case OP_SWITCH_MAP:
            if (index == 1) {
                emit(ctx, s, value);
            } else {
                switch_inner(ctx, s, state, value);
            }
            return;
        case OP_DEBOUNCE: {
            bool quiet = s->timer_id == 0;
            unschedule(ctx, s);
            schedule(ctx, s, state, s->ms, false);
            if (quiet && s->leading) {
                emit(ctx, s, value);
            } else {
                set_pending(ctx, s, value, s->trailing);
            }
            return;
        }
        case OP_THROTTLE:
            if (s->timer_id != 0) {
                set_pending(ctx, s, value, s->trailing);
                return;
            }
            if (s->leading) {
                emit(ctx, s, value);
            } else {
                set_pending(ctx, s, value, s->trailing);
            }
            if (!down_closed(s)) schedule(ctx, s, state, s->ms, false);
            return;
        default:
            /* startWith, finalize, mergeWith: pass through. */
            emit(ctx, s, value);
            return;
    }
}

/* `from` is the upstream subscriber that completed. */
static void op_on_complete(JSContext* ctx, JSValueConst state, int index, SubscriberData* from) {
    auto* s = static_cast<OpState*>(JS_GetOpaque(state, op_state_class_id));
    switch (s->kind) {
        case OP_MERGE_WITH:
            if (--s->count == 0) finish(ctx, s);
            return;
        case OP_COMBINE_LATEST:
            /* A source ending without a value means no tuple can ever form. */
            if (JS_IsUninitialized(s->values[index]) || --s->count == 0) finish(ctx, s);
            return;
        case OP_TAKE_UNTIL:
        case OP_WITH_LATEST_FROM:
            /* The notifier or `other` completing does not end the stream. */
            if (index != 1) finish(ctx, s);
            return;
        case OP_SWITCH_MAP:
            /* Completes once the source and the last inner stream both have.
             * An inner that was switched away while its completion was still
             * queued (complete_pending) drains here too; only the current
             * inner's completion counts. */
            if (index == 1) {
                if (from == JS_GetOpaque(s->inner, subscriber_class_id)) s->inner_open = false;
            } else {
                s->source_done = true;
            }
            if (s->source_done && !s->inner_open) finish(ctx, s);
            return;
        case OP_DEBOUNCE:
            unschedule(ctx, s);
            flush(ctx, s);
            finish(ctx, s);
            return;
        case OP_THROTTLE:
            unschedule(ctx, s);
            flush(ctx, s);
            finish(ctx, s);
            return;
        default:
            finish(ctx, s);
            return;
    }
}

/* Route `source` into the operator as upstream number `index`; the upstream
 * ends with `down`. The upstream subscriber joins `down`'s teardowns before
 * the producer runs, so a chain that completes during setup (startWith into
 * take(1)) already closes it, and a closed `down` subscribes nothing. */
static bool forward(JSContext* ctx, OpState* s, JSValueConst source, JSValueConst state,
                    int index) {
    auto* src = static_cast<ObservableData*>(JS_GetOpaque2(ctx, source, observable_class_id));
    if (!src) return false;
    if (down_closed(s)) return true;
    JSValue sub_val = make_upstream(ctx, state, index);
    if (JS_IsException(sub_val)) return false;
    auto* d = static_cast<SubscriberData*>(JS_GetOpaque(sub_val, subscriber_class_id));
    op_down(s)->teardowns.push_back(JS_DupValue(ctx, sub_val));
    JSValue started = start_subscriber(ctx, src->subscribe_cb, sub_val, d);
    if (JS_IsException(started)) return false;
    JS_FreeValue(ctx, started);
    return true;
}

/* Counts and durations: non-finite or huge values saturate, NaN counts as 0. */
static int32_t to_count(JSContext* ctx, JSValueConst v) {
    double n = 0;
    JS_ToFloat64(ctx, &n, v);
    if (!(n > 0)) return 0;
    if (n >= INT32_MAX) return INT32_MAX;
    return static_cast<int32_t>(n);
}

/* The subscribe callback of an operator-built Observable.
 * func_data = [source, args...]; argv[0] = the downstream subscriber. */
static JSValue op_subscribe(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                            int magic, JSValueConst* func_data) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    int kind = op_kind(magic);
    JSValueConst source = func_data[0];
    JSValueConst* args = func_data + 1;

    JSValue state = JS_NewObjectClass(ctx, op_state_class_id);
    if (JS_IsException(state)) return state;
    auto* s = new OpState();
    s->kind = kind;
    s->down = JS_DupValue(ctx, argv[0]);
    JS_SetOpaque(state, s);

    bool ok = true;
    bool subscribed = false;
    switch (kind) {
        case OP_MAP:
        case OP_FILTER:
        case OP_TAP:
            s->fn = JS_DupValue(ctx, args[0]);
            break;
        case OP_TAKE_WHILE:
            s->fn = JS_DupValue(ctx, args[0]);
            s->flag = JS_ToBool(ctx, args[1]) == 1;
            break;
        case OP_SCAN:
            s->fn = JS_DupValue(ctx, args[0]);
            s->value = JS_DupValue(ctx, args[1]);
            break;
        case OP_DISTINCT:
            s->fn = JS_DupValue(ctx, args[0]);
            break;
        case OP_TAKE:
            s->count = to_count(ctx, args[0]);
            /* take(0): complete without ever subscribing upstream. */
            if (s->count == 0) {
                finish(ctx, s);
                subscribed = true;
            }
            break;
        case OP_SKIP:
            s->count = to_count(ctx, args[0]);
            break;
        case OP_START_WITH:
            emit(ctx, s, args[0]);
            /* The first value may have closed the chain (take(1)). */
            if (down_closed(s)) subscribed = true;
            break;
        case OP_FINALIZE:
            /* Registered first, so it runs after the upstream unsubscribe. */
            add_teardown(ctx, op_down(s), JS_DupValue(ctx, args[0]));
            break;
        case OP_TAKE_UNTIL:
            /* Notifier first, as in RxJS: one that fires during its own
             * subscribe ends the stream before the source is subscribed. */
            ok = forward(ctx, s, args[0], state, 1) && forward(ctx, s, source, state, 0);
            subscribed = true;
            break;
        case OP_MERGE_WITH: {
            int n = op_argc(magic);
            s->count = n + 1;
            ok = forward(ctx, s, source, state, 0);
            for (int i = 0; ok && i < n; i++) ok = forward(ctx, s, args[i], state, i + 1);
            subscribed = true;
            break;
        }
        case OP_WITH_LATEST_FROM:
            ok = forward(ctx, s, args[0], state, 1) && forward(ctx, s, source, state, 0);
            subscribed = true;
            break;
        case OP_COMBINE_LATEST: {
            /* `source` is the array of sources. */
            int64_t len = 0;
            if (JS_GetLength(ctx, source, &len) < 0) {
                ok = false;
                subscribed = true;
                break;
            }
            int n = static_cast<int>(len);
            s->values.assign(n, JS_UNINITIALIZED);
            s->count = n;
            s->missing = n;
            if (n == 0) {
                emit_array(ctx, s, 0, nullptr);
                finish(ctx, s);
            }
            for (int i = 0; ok && i < n; i++) {
                /* A source that completed without a value already closed
                 * `down`; the rest would be unsubscribed at once anyway. */
                if (down_closed(s)) break;
                JSValue elem = JS_GetPropertyUint32(ctx, source, i);
                ok = !JS_IsException(elem) && forward(ctx, s, elem, state, i);
                JS_FreeValue(ctx, elem);
            }
            subscribed = true;
            break;
        }
        case OP_SWITCH_MAP:
            s->fn = JS_DupValue(ctx, args[0]);
            add_teardown(ctx, op_down(s), JS_DupValue(ctx, state));
            break;
        case OP_TIMER:
            /* `source` is the delay; args[0] the period, or undefined. */
            s->ms = JS_IsUndefined(args[0]) ? -1 : to_count(ctx, args[0]);
            add_teardown(ctx, op_down(s), JS_DupValue(ctx, state));
            schedule(ctx, s, state, to_count(ctx, source), false);
            subscribed = true;
            break;
        case OP_DEBOUNCE:
        case OP_THROTTLE:
            s->ms = to_count(ctx, args[0]);
            s->leading = JS_ToBool(ctx, args[1]) == 1;
            s->trailing = JS_ToBool(ctx, args[2]) == 1;
            add_teardown(ctx, op_down(s), JS_DupValue(ctx, state));
            break;
        default:
            break;
    }
    if (ok && !subscribed) ok = forward(ctx, s, source, state, 0);
    JS_FreeValue(ctx, state);
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
}

/* The operator function returned by a factory: (source) => Observable.
 * func_data = the factory's arguments. */
static JSValue op_apply(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                        int magic, JSValueConst* func_data) {
    (void)this_val;
    if (argc < 1 || !JS_GetOpaque(argv[0], observable_class_id)) {
        return JS_ThrowTypeError(ctx, "%s: source must be an Observable",
                                 op_names[op_kind(magic)]);
    }
    int n = op_argc(magic);
    std::vector<JSValue> data;
    data.reserve(n + 1);
    data.push_back(argv[0]);
    for (int i = 0; i < n; i++) data.push_back(func_data[i]);
    /* JS_NewCFunctionData duplicates the data values. */
    JSValue cb = JS_NewCFunctionData(ctx, op_subscribe, 1, magic, n + 1, data.data());
    if (JS_IsException(cb)) return cb;
    return make_observable_with_cb(ctx, cb);
}

static bool is_observable(JSValueConst v) {
    return JS_GetOpaque(v, observable_class_id) != nullptr;
}

/* One factory for every operator; `magic` is the OpKind. */
static JSValue op_factory(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                          int magic) {
    (void)this_val;
    int kind = magic;
    const char* name = op_names[kind];
    JSValueConst first = argc > 0 ? argv[0] : JS_UNDEFINED;
    std::vector<JSValue> data;
    JSValue owned = JS_UNDEFINED;
    switch (kind) {
        case OP_MAP:
        case OP_FILTER:
        case OP_TAP:
        case OP_FINALIZE:
        case OP_SCAN:
        case OP_SWITCH_MAP:
            if (!JS_IsFunction(ctx, first)) {
                return JS_ThrowTypeError(ctx, "%s: argument must be a function", name);
            }
            data.push_back(first);
            if (kind == OP_SCAN) data.push_back(argc > 1 ? argv[1] : JS_UNDEFINED);
            break;
        case OP_DISTINCT:
            if (!JS_IsUndefined(first) && !JS_IsFunction(ctx, first)) {
                return JS_ThrowTypeError(ctx, "%s: argument must be a function", name);
            }
            data.push_back(first);
            break;
        case OP_TAKE:
        case OP_SKIP:
            if (!JS_IsNumber(first)) {
                return JS_ThrowTypeError(ctx, "%s: count must be a number", name);
            }
            data.push_back(first);
            break;
        case OP_START_WITH:
            data.push_back(first);
            break;
        case OP_TAKE_UNTIL: {
            if (JS_IsFunction(ctx, first)) {
                kind = OP_TAKE_WHILE;
                bool inclusive = true;
                if (argc > 1 && JS_IsObject(argv[1])) {
                    JSValue opt = JS_GetPropertyStr(ctx, argv[1], "inclusive");
                    if (JS_IsException(opt)) return opt;
                    if (!JS_IsUndefined(opt)) inclusive = JS_ToBool(ctx, opt) == 1;
                    JS_FreeValue(ctx, opt);
                }
                owned = JS_NewBool(ctx, inclusive);
                data.push_back(first);
                data.push_back(owned);
                break;
            }
            if (!is_observable(first)) {
                return JS_ThrowTypeError(ctx, "%s: argument must be an Observable or a predicate",
                                         name);
            }
            data.push_back(first);
            break;
        }
        case OP_MERGE_WITH:
        case OP_WITH_LATEST_FROM:
            for (int i = 0; i < (kind == OP_MERGE_WITH ? argc : 1); i++) {
                JSValueConst v = i < argc ? argv[i] : JS_UNDEFINED;
                if (!is_observable(v)) {
                    return JS_ThrowTypeError(ctx, "%s: arguments must be Observables", name);
                }
                data.push_back(v);
            }
            break;
        case OP_TIMER: {
            if (!JS_IsNumber(first) || (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNumber(argv[1]))) {
                return JS_ThrowTypeError(ctx, "%s: delay and period must be numbers", name);
            }
            /* Not an operator: the delay is the "source" of op_subscribe. */
            JSValue timer_args[2] = {first, argc > 1 ? argv[1] : JS_UNDEFINED};
            JSValue cb =
                JS_NewCFunctionData(ctx, op_subscribe, 1, op_magic(kind, 1), 2, timer_args);
            if (JS_IsException(cb)) return cb;
            return make_observable_with_cb(ctx, cb);
        }
        case OP_DEBOUNCE:
        case OP_THROTTLE: {
            if (!JS_IsNumber(first)) {
                return JS_ThrowTypeError(ctx, "%s: duration must be a number", name);
            }
            /* {leading, trailing}: debounce defaults to the trailing edge,
             * throttle to the leading one. */
            bool leading = kind == OP_THROTTLE;
            bool trailing = kind == OP_DEBOUNCE;
            if (argc > 1 && JS_IsObject(argv[1])) {
                JSValue l = JS_GetPropertyStr(ctx, argv[1], "leading");
                if (JS_IsException(l)) return l;
                JSValue t = JS_GetPropertyStr(ctx, argv[1], "trailing");
                if (JS_IsException(t)) {
                    JS_FreeValue(ctx, l);
                    return t;
                }
                if (!JS_IsUndefined(l)) leading = JS_ToBool(ctx, l) == 1;
                if (!JS_IsUndefined(t)) trailing = JS_ToBool(ctx, t) == 1;
                JS_FreeValue(ctx, l);
                JS_FreeValue(ctx, t);
            }
            data.push_back(first);
            data.push_back(JS_NewBool(ctx, leading));
            data.push_back(JS_NewBool(ctx, trailing));
            break;
        }
        case OP_COMBINE_LATEST: {
            int64_t len = -1;
            if (!JS_IsArray(first) || JS_GetLength(ctx, first, &len) < 0) {
                return JS_ThrowTypeError(ctx, "%s: argument must be an array of Observables",
                                         name);
            }
            for (int64_t i = 0; i < len; i++) {
                JSValue elem = JS_GetPropertyUint32(ctx, first, static_cast<uint32_t>(i));
                bool valid = is_observable(elem);
                JS_FreeValue(ctx, elem);
                if (!valid) {
                    return JS_ThrowTypeError(ctx, "%s: argument must be an array of Observables",
                                             name);
                }
            }
            /* Not an operator: the array is the "source" of op_subscribe. */
            JSValue cb = JS_NewCFunctionData(ctx, op_subscribe, 1, kind, 1, &first);
            if (JS_IsException(cb)) return cb;
            return make_observable_with_cb(ctx, cb);
        }
        default:
            break;
    }
    int n = static_cast<int>(data.size());
    JSValue fn = JS_NewCFunctionData(ctx, op_apply, 1, op_magic(kind, n), n, data.data());
    JS_FreeValue(ctx, owned);
    return fn;
}

/* pipe(...ops): compose operators left to right into one operator.
 * func_data = the operators; `magic` = their count. */
static JSValue pipe_apply(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                          int magic, JSValueConst* func_data) {
    (void)this_val;
    JSValueConst source = argc > 0 ? argv[0] : JS_UNDEFINED;
    return observable_pipe(ctx, source, magic, func_data);
}

static JSValue pipe_factory(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        if (!JS_IsFunction(ctx, argv[i])) {
            return JS_ThrowTypeError(ctx, "pipe: arguments must be operator functions");
        }
    }
    return JS_NewCFunctionData(ctx, pipe_apply, 1, argc, argc, argv);
}

static int operators_module_init(JSContext* ctx, JSModuleDef* m) {
    ensure_protos(ctx);
    for (int kind = OP_MAP; kind < OP_TAKE_WHILE; kind++) {
        const char* name = op_names[kind];
        JS_SetModuleExport(
            ctx, m, name,
            JS_NewCFunctionMagic(ctx, op_factory, name, 1, JS_CFUNC_generic_magic, kind));
    }
    JS_SetModuleExport(ctx, m, "pipe", JS_NewCFunction(ctx, pipe_factory, "pipe", 0));
    return 0;
}

/* ── Observable prototype ─────────────────────────────────────────── */

static const JSCFunctionListEntry observable_proto_funcs[] = {
    JS_CFUNC_DEF("subscribe", 1, observable_subscribe),
    JS_CFUNC_DEF("pipe", 1, observable_pipe),
};

/* ── Module init ──────────────────────────────────────────────────── */

/* Build the prototypes and the constructor once per context, on the first
 * import of either module: operators create Observables without the
 * observable module ever being imported. The classes themselves are
 * registered by mik__observable_init below. */
static void ensure_protos(JSContext* ctx) {
    JSValue existing = JS_GetClassProto(ctx, observable_class_id);
    bool done = JS_IsObject(existing);
    JS_FreeValue(ctx, existing);
    if (done) return;

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
        ctx, obs_ctor, "withEmitters",
        JS_NewCFunction(ctx, observable_with_emitters, "withEmitters", 0), JS_PROP_C_W_E);
    /* The prototype keeps the constructor reachable (proto.constructor). */
    JS_FreeValue(ctx, obs_ctor);
}

static int observable_module_init(JSContext* ctx, JSModuleDef* m) {
    ensure_protos(ctx);
    JSValue obs_proto = JS_GetClassProto(ctx, observable_class_id);
    JSValue obs_ctor = JS_GetPropertyStr(ctx, obs_proto, "constructor");
    JS_FreeValue(ctx, obs_proto);
    JS_SetModuleExport(ctx, m, "Observable", obs_ctor);
    JS_SetModuleExport(ctx, m, "from", JS_NewCFunction(ctx, observable_from, "from", 1));
    JS_SetModuleExport(ctx, m, "of", JS_NewCFunction(ctx, observable_of, "of", 0));
    return 0;
}

}  // namespace

/* mikro/observable/operators, resolved through the C-module table in
 * modules.cpp on first import. */
JSModuleDef* mik__observable_operators_load(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/observable/operators", operators_module_init);
    if (!m) return nullptr;
    for (int kind = OP_MAP; kind < OP_TAKE_WHILE; kind++) {
        JS_AddModuleExport(ctx, m, op_names[kind]);
    }
    JS_AddModuleExport(ctx, m, "pipe");
    return m;
}

void mik__observable_dispatch_free(MIKRuntime* mik_rt) {
    delete mik_rt->observable_dispatch;
    mik_rt->observable_dispatch = nullptr;
}

JSModuleDef* mik__observable_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt && !mik_rt->observable_dispatch) {
        mik_rt->observable_dispatch = new MIKObservableDispatch();
    }

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
    JS_NewClassID(rt, &op_state_class_id);
    JS_NewClass(rt, op_state_class_id, &op_state_class_def);

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/observable", observable_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Observable");
    JS_AddModuleExport(ctx, m, "from");
    JS_AddModuleExport(ctx, m, "of");
    return m;
}

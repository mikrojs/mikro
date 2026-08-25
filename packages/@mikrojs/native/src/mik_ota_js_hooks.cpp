#include "mikrojs/ota_js_hooks.h"

#include <map>

#include "mikrojs/utils.h"

namespace mikrojs {

namespace {

/* The hooks instance rides to the promise callbacks as a pair of integers in
 * func_data, which carries JSValues and not pointers.
 *
 * A JS class with an opaque would be the tidier vehicle, but class ids are
 * per-runtime and this unit has no per-runtime init to register one in — doing
 * it lazily inside a call aborts the second runtime in a process. Two ints have
 * no lifecycle at all.
 *
 * What travels is an id and not the address: a pending beforeCheck outlives the
 * hooks object whenever watch() is called a second time or the client is torn
 * down mid-round, and the allocator is free to hand the same address to the
 * replacement. An id is never reused, so a continuation from a destroyed
 * instance finds nothing rather than settling its successor. */
uint64_t next_hook_id() {
    static uint64_t counter = 0;
    return ++counter;
}

std::map<uint64_t, MIKOtaJsHooks*>& live_hooks() {
    static std::map<uint64_t, MIKOtaJsHooks*> hooks;
    return hooks;
}

void put_self(JSContext* ctx, uint64_t id, JSValue out[2]) {
    out[0] = JS_NewUint32(ctx, static_cast<uint32_t>(id & 0xffffffffu));
    out[1] = JS_NewUint32(ctx, static_cast<uint32_t>((id >> 32) & 0xffffffffu));
}

MIKOtaJsHooks* take_self(JSContext* ctx, JSValue* func_data) {
    if (!func_data) return nullptr;
    uint32_t low = 0;
    uint32_t high = 0;
    if (JS_ToUint32(ctx, &low, func_data[0]) < 0) return nullptr;
    if (JS_ToUint32(ctx, &high, func_data[1]) < 0) return nullptr;
    uint64_t id = (static_cast<uint64_t>(high) << 32) | low;
    auto it = live_hooks().find(id);
    return it == live_hooks().end() ? nullptr : it->second;
}

/* A Result is an object carrying a boolean `ok`. Told apart from a bare
 * teardown, which is a function, and from nothing at all. */
bool is_result(JSContext* ctx, JSValueConst value) {
    if (!JS_IsObject(value) || JS_IsFunction(ctx, value)) return false;
    JSValue ok = JS_GetPropertyStr(ctx, value, "ok");
    bool looks_like = JS_IsBool(ok);
    JS_FreeValue(ctx, ok);
    return looks_like;
}

}  // namespace

MIKOtaJsHooks::MIKOtaJsHooks(JSContext* ctx, JSValue before_check)
    : ctx_(ctx), before_check_(before_check), id_(next_hook_id()) {
    live_hooks()[id_] = this;
}

MIKOtaJsHooks::~MIKOtaJsHooks() {
    live_hooks().erase(id_);
    JS_FreeValue(ctx_, before_check_);
    JS_FreeValue(ctx_, teardown_);
}

bool MIKOtaJsHooks::has_teardown() const { return JS_IsFunction(ctx_, teardown_); }

bool MIKOtaJsHooks::BeginBeforeCheck() {
    if (!JS_IsFunction(ctx_, before_check_)) return false;
    awaiting_before_check_ = true;
    state_ = MIKOtaHookState::kPending;
    JS_FreeValue(ctx_, teardown_);
    teardown_ = JS_UNDEFINED;
    Call(before_check_);
    return true;
}

MIKOtaHookState MIKOtaJsHooks::PollBeforeCheck() { return state_; }

bool MIKOtaJsHooks::BeginTeardown() {
    if (!JS_IsFunction(ctx_, teardown_)) return false;
    awaiting_before_check_ = false;
    state_ = MIKOtaHookState::kPending;
    /* Held across the call: settling clears it, and the call needs it alive. */
    JSValue teardown = JS_DupValue(ctx_, teardown_);
    Call(teardown);
    JS_FreeValue(ctx_, teardown);
    return true;
}

MIKOtaHookState MIKOtaJsHooks::PollTeardown() { return state_; }

void MIKOtaJsHooks::Call(JSValue fn) {
    JSValue result = JS_Call(ctx_, fn, JS_UNDEFINED, 0, nullptr);
    if (JS_IsException(result)) {
        /* A hook that threw is a hook that failed. Report it on serial rather
         * than leaving the exception on the context for something unrelated to
         * trip over later. */
        mik_dump_error(ctx_);
        JS_FreeValue(ctx_, result);
        state_ = MIKOtaHookState::kFailed;
        return;
    }

    /* A hook may return nothing at all, and reading a property off undefined
     * throws rather than answering — so ask what it is before asking anything
     * of it. */
    JSValue then = JS_IsObject(result) ? JS_GetPropertyStr(ctx_, result, "then") : JS_UNDEFINED;
    if (!JS_IsFunction(ctx_, then)) {
        JS_FreeValue(ctx_, then);
        Settle(result);
        JS_FreeValue(ctx_, result);
        return;
    }

    JSValue data[2];
    put_self(ctx_, id_, data);
    JSValue on_ok = JS_NewCFunctionData(ctx_, OnFulfilled, 1, /*magic=*/1, 2, data);
    JSValue on_err = JS_NewCFunctionData(ctx_, OnFulfilled, 1, /*magic=*/0, 2, data);
    JS_FreeValue(ctx_, data[0]);
    JS_FreeValue(ctx_, data[1]);

    JSValue args[2] = {on_ok, on_err};
    JSValue chained = JS_Call(ctx_, then, result, 2, args);
    if (JS_IsException(chained)) {
        JS_FreeValue(ctx_, JS_GetException(ctx_));
        state_ = MIKOtaHookState::kFailed;
    }
    JS_FreeValue(ctx_, chained);
    JS_FreeValue(ctx_, on_ok);
    JS_FreeValue(ctx_, on_err);
    JS_FreeValue(ctx_, then);
    JS_FreeValue(ctx_, result);
}

void MIKOtaJsHooks::Settle(JSValue value) {
    if (!awaiting_before_check_) {
        /* Whatever a teardown returns is ignored: it has nothing left to say. */
        state_ = MIKOtaHookState::kOk;
        return;
    }

    /* A bare function is the teardown, with no Result to unwrap. */
    if (JS_IsFunction(ctx_, value)) {
        JS_FreeValue(ctx_, teardown_);
        teardown_ = JS_DupValue(ctx_, value);
        state_ = MIKOtaHookState::kOk;
        return;
    }

    if (is_result(ctx_, value)) {
        JSValue ok = JS_GetPropertyStr(ctx_, value, "ok");
        bool succeeded = JS_ToBool(ctx_, ok);
        JS_FreeValue(ctx_, ok);
        if (!succeeded) {
            state_ = MIKOtaHookState::kFailed;
            return;
        }
        JS_FreeValue(ctx_, teardown_);
        teardown_ = JS_GetPropertyStr(ctx_, value, "value");
        state_ = MIKOtaHookState::kOk;
        return;
    }

    /* Nothing, or something that is neither: the round runs, with no teardown. */
    state_ = MIKOtaHookState::kOk;
}

JSValue MIKOtaJsHooks::OnFulfilled(JSContext* ctx, JSValueConst this_val, int argc,
                                   JSValueConst* argv, int magic, JSValue* func_data) {
    (void)this_val;
    MIKOtaJsHooks* hooks = take_self(ctx, func_data);
    if (!hooks) return JS_UNDEFINED;
    if (magic == 0) {
        /* Rejected: a failed hook, whichever half was running. */
        hooks->state_ = MIKOtaHookState::kFailed;
        return JS_UNDEFINED;
    }
    hooks->Settle(argc > 0 ? argv[0] : JS_UNDEFINED);
    return JS_UNDEFINED;
}

}  // namespace mikrojs

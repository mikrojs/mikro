/* The beforeCheck bridge, driven with real JS functions.
 *
 * Every shape here is one an app can legitimately hand back, and getting any of
 * them wrong takes the device down mid-round rather than failing a test — which
 * is what happened before this file existed. */

#include <memory>
#include <string>

#include "doctest.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_js_hooks.h"

using namespace mikrojs;

namespace {

struct Host {
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    ~Host() { MIK_FreeRuntime(rt); }

    /* Evaluate an expression and keep the value. */
    JSValue Value(const char* expression) {
        return JS_Eval(ctx, expression, strlen(expression), "<hook>", JS_EVAL_TYPE_GLOBAL);
    }

    /* Run pending jobs, the way the loop does between polls. */
    void Drain() {
        JSContext* pending = nullptr;
        while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &pending) > 0) {
        }
    }

    /* Take the hook through beforeCheck to a settled state. */
    MIKOtaHookState RunBeforeCheck(MIKOtaJsHooks& hooks) {
        REQUIRE(hooks.BeginBeforeCheck());
        for (int i = 0; i < 8 && hooks.PollBeforeCheck() == MIKOtaHookState::kPending; i++) {
            Drain();
        }
        return hooks.PollBeforeCheck();
    }

    MIKOtaHookState RunTeardown(MIKOtaJsHooks& hooks) {
        if (!hooks.BeginTeardown()) return MIKOtaHookState::kOk;
        for (int i = 0; i < 8 && hooks.PollTeardown() == MIKOtaHookState::kPending; i++) {
            Drain();
        }
        return hooks.PollTeardown();
    }

    /* Nothing was left pending for the next thing to run: evaluating anything
     * at all would inherit a stranded exception. */
    bool ContextIsClean() {
        const char* trivial = "1 + 1";
        JSValue value = JS_Eval(ctx, trivial, strlen(trivial), "<probe>", JS_EVAL_TYPE_GLOBAL);
        bool clean = !JS_IsException(value);
        if (!clean) JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, value);
        return clean;
    }

    /* A counter the hooks can bump, so a teardown proves it ran. */
    int Counter(const char* name) {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue value = JS_GetPropertyStr(ctx, global, name);
        int32_t out = 0;
        JS_ToInt32(ctx, &out, value);
        JS_FreeValue(ctx, value);
        JS_FreeValue(ctx, global);
        return out;
    }
};

}  // namespace

TEST_SUITE("ota: js hooks") {

TEST_CASE("a bare teardown function needs no Result around it") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => { globalThis.t = 0; "
                                       "return () => { globalThis.t++ } })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(hooks.has_teardown());
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 1);
}

TEST_CASE("a teardown may return anything, including a Result it ignores") {
    // `() => wifi.disconnect()` is the shape this exists for: the teardown hands
    // back whatever it called, and the round has nothing to do with it.
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => () => ({ok: false, error: 'ignored'}))"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
}

TEST_CASE("a teardown that returns nothing does not crash the round") {
    // `() => void wifi.disconnect()` returns undefined, and asking undefined for
    // `.then` throws rather than answering.
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => { globalThis.t = 0; "
                                       "return () => { globalThis.t++; return undefined } })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 1);
    CHECK(h.ContextIsClean());
}

TEST_CASE("an ok Result carrying a teardown still works") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => { globalThis.t = 0; "
                                       "return {ok: true, value: () => { globalThis.t++ }} })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(hooks.has_teardown());
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 1);
}

TEST_CASE("an err Result skips the round, and runs no teardown") {
    // The failing-setup path: the hook hands its own error straight back.
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => ({ok: false, error: 'no wifi'}))"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kFailed);
    CHECK(!hooks.has_teardown());
    CHECK(!hooks.BeginTeardown());
}

TEST_CASE("a hook that returns nothing runs the round with no teardown") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => undefined)"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(!hooks.has_teardown());
    CHECK(!hooks.BeginTeardown());
}

TEST_CASE("a synchronous hook settles without waiting for a job") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(() => { globalThis.t = 0; "
                                       "return () => { globalThis.t++ } })"));
    REQUIRE(hooks.BeginBeforeCheck());
    // Settled already: nothing was queued to drain.
    CHECK(hooks.PollBeforeCheck() == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 1);
}

TEST_CASE("a hook that throws skips the round") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(() => { throw new Error('boom') })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kFailed);
    CHECK(h.ContextIsClean());
}

TEST_CASE("a hook whose promise rejects skips the round") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => { throw new Error('boom') })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kFailed);
}

TEST_CASE("a teardown that throws does not take the round down with it") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => () => { throw new Error('boom') })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kFailed);
    CHECK(h.ContextIsClean());
}

TEST_CASE("no hook at all is not a failure") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, JS_UNDEFINED);
    CHECK(!hooks.BeginBeforeCheck());
    CHECK(!hooks.BeginTeardown());
}

TEST_CASE("each round gets its own teardown, and the previous one is dropped") {
    Host h;
    MIKOtaJsHooks hooks(h.ctx, h.Value("(async () => { globalThis.t = (globalThis.t ?? 0); "
                                       "return () => { globalThis.t++ } })"));
    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 1);

    CHECK(h.RunBeforeCheck(hooks) == MIKOtaHookState::kOk);
    CHECK(h.RunTeardown(hooks) == MIKOtaHookState::kOk);
    CHECK(h.Counter("t") == 2);
}

TEST_CASE("a hook destroyed mid-round does not settle whatever replaced it") {
    // watch() called a second time, or a client torn down while beforeCheck is
    // still pending, frees the hooks object with a promise continuation still
    // holding on to it. The allocator is free to hand the same address to the
    // replacement, so a continuation that carried a raw pointer would settle
    // the wrong instance.
    Host h;
    h.Value("globalThis.settle = null");
    auto first = std::make_unique<MIKOtaJsHooks>(
        h.ctx, h.Value("(() => new Promise((resolve) => { globalThis.settle = resolve }))"));
    REQUIRE(first->BeginBeforeCheck());
    h.Drain();
    REQUIRE(first->PollBeforeCheck() == MIKOtaHookState::kPending);

    first.reset();

    // The replacement, which commonly lands on the freed address.
    MIKOtaJsHooks second(h.ctx, h.Value("(() => undefined)"));
    CHECK(h.RunBeforeCheck(second) == MIKOtaHookState::kOk);
    CHECK(!second.has_teardown());

    // Now let the abandoned hook's promise settle, with a teardown function.
    JS_FreeValue(h.ctx, h.Value("globalThis.settle(() => { globalThis.leaked = 1 })"));
    h.Drain();

    CHECK(!second.has_teardown());
    CHECK(h.Counter("leaked") == 0);
    CHECK(h.ContextIsClean());
}

}  // TEST_SUITE

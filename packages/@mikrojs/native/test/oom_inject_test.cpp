#include <cstring>

#include <mikrojs/mem.h>
#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Incremental OOM injection, SQLite-style: run the same module eval while the
 * JS-heap allocator fails at point n, for every n until the eval succeeds.
 * Each round must end in a clean success or a clean JS error, with the
 * runtime still usable afterwards and no leaked allocations. Runtime
 * creation runs with injection disabled: a creation-time OOM aborts by
 * design (CHECK_NOT_NULL), only the JS heap must stay catchable. */

namespace {

enum class EvalOutcome { Success, JsError };

EvalOutcome eval_module(JSContext* ctx, const char* name, const char* src) {
    JSValue result = MIK_EvalModuleContent(ctx, name, src, strlen(src));
    EvalOutcome outcome = EvalOutcome::JsError;
    if (!JS_IsException(result) && JS_PromiseState(ctx, result) == JS_PROMISE_FULFILLED) {
        outcome = EvalOutcome::Success;
    }
    JS_FreeValue(ctx, result);
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    return outcome;
}

}  // namespace

TEST_CASE("module eval fails cleanly at every JS-heap allocation point" *
          doctest::test_suite("oom")) {
    /* Warm up lazily-initialized state so the per-round leak check compares
     * like with like. */
    {
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        MIK_FreeRuntime(rt);
    }

    const char* src =
        "const parts = [];\n"
        "for (let i = 0; i < 8; i++) parts.push(`chunk-${i}`.repeat(4));\n"
        "export const text = parts.join(',');\n";

    bool succeeded = false;
    const int64_t max_rounds = 100000;
    for (int64_t n = 0; n < max_rounds && !succeeded; n++) {
        int64_t live_before = mik__oom_inject_live_allocs();
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        JSContext* ctx = MIK_GetJSContext(rt);

        mik__oom_inject_fail_after(n);
        EvalOutcome outcome = eval_module(ctx, "<oom-inject>", src);
        mik__oom_inject_fail_after(-1);

        if (outcome == EvalOutcome::Success) {
            succeeded = true;
        } else {
            /* A JS-heap OOM must not wedge the runtime: with the allocator
             * healthy again, the next eval has to work. */
            EvalOutcome recovery = eval_module(ctx, "<oom-recovery>", "export const ok = 1;\n");
            if (recovery != EvalOutcome::Success) {
                CAPTURE(n);
                REQUIRE(recovery == EvalOutcome::Success);
            }
        }

        MIK_FreeRuntime(rt);

        int64_t live_after = mik__oom_inject_live_allocs();
        if (live_after != live_before) {
            CAPTURE(n);
            REQUIRE(live_after == live_before);
        }
    }
    CHECK_MESSAGE(succeeded, "eval never succeeded; raise max_rounds");
}

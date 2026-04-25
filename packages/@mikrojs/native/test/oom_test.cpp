#include <cstring>
#include <vector>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Test harness: collect OOM events into a stack-backed vector so we can
 * assert on them after the runtime is done. Handler does only C++ heap
 * work, never touches QuickJS, so it's safe when the JS heap is fully
 * exhausted. */
struct OOMRecorder {
    std::vector<MIKOOMEvent> events;
};

static void record_oom(const MIKOOMEvent* event, void* opaque) {
    auto* recorder = static_cast<OOMRecorder*>(opaque);
    /* Copy the event struct — the caller's storage may be on a C stack
     * frame that pops before the test inspects the recorded events. */
    recorder->events.push_back(*event);
}

TEST_CASE("MIK_SetOOMHandler fires on pre-eval headroom warning" *
          doctest::test_suite("oom")) {
    /* Create the runtime unlimited so QuickJS can bootstrap its class
     * tables and atoms (~40-60 KB), then measure current usage and
     * configure the soft cap to leave less than the pre-eval warn
     * threshold of headroom. This is the only way to exercise the
     * warning without crashing during runtime init. */
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    JSMemoryUsage mem_baseline;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem_baseline);

    /* Leave only 8 KB of headroom — comfortably below the 16 KB warn
     * threshold, but enough room for a trivial module to finish loading
     * and reach the pre-eval check. */
    JS_SetMemoryLimit(JS_GetRuntime(ctx), mem_baseline.malloc_size + 8 * 1024);

    OOMRecorder recorder;
    MIK_SetOOMHandler(rt, record_oom, &recorder);

    /* Evaluate a trivial module. The pre-eval check runs inside
     * MIK_EvalModuleContent right after JS_ResolveModule and before
     * JS_EvalFunction, so a single-line module triggers it as long as
     * headroom is already below the threshold. */
    const char* src = "export const x = 1;";
    JSValue result = MIK_EvalModuleContent(ctx, "<test>", src, strlen(src));
    JS_FreeValue(ctx, result);

    CHECK_MESSAGE(!recorder.events.empty(),
                  "Expected OOM handler to fire at least once for pre-eval warning");

    if (!recorder.events.empty()) {
        const auto& event = recorder.events[0];
        CHECK_MESSAGE(event.phase == MIK_OOM_PRE_EVAL_WARN,
                      "Expected phase=MIK_OOM_PRE_EVAL_WARN");
        REQUIRE_MESSAGE(event.filename != nullptr, "Expected filename to be non-null");
        CHECK_MESSAGE(strcmp(event.filename, "<test>") == 0,
                      "Expected filename to be the module being evaluated");
        CHECK_MESSAGE(event.malloc_size > 0, "Expected some heap to be used");
        CHECK_MESSAGE(event.headroom < 16 * 1024,
                      "Expected headroom below the 16 KB pre-eval warn threshold");
    }

    /* MIK_ConsumeOOMFlag should also have been set and should report true
     * exactly once. */
    CHECK_MESSAGE(MIK_ConsumeOOMFlag(rt), "Expected OOM flag to be set");
    CHECK_MESSAGE(!MIK_ConsumeOOMFlag(rt),
                  "Expected OOM flag to be cleared on consume (second call returns false)");

    MIK_FreeRuntime(rt);
}

TEST_CASE("MIK_ConsumeOOMFlag works without a handler registered" *
          doctest::test_suite("oom")) {
    /* Flag-only consumers should work even if no MIK_SetOOMHandler was
     * ever called. This is the polling-only access pattern. */
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    JSMemoryUsage mem_baseline;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem_baseline);
    JS_SetMemoryLimit(JS_GetRuntime(ctx), mem_baseline.malloc_size + 8 * 1024);

    /* No MIK_SetOOMHandler call — rely entirely on the flag. */
    const char* src = "export const x = 1;";
    JSValue result = MIK_EvalModuleContent(ctx, "<test>", src, strlen(src));
    JS_FreeValue(ctx, result);

    CHECK_MESSAGE(MIK_ConsumeOOMFlag(rt),
                  "Expected OOM flag to be set even without a handler");

    MIK_FreeRuntime(rt);
}

TEST_CASE("No OOM event when memory limit is generous" * doctest::test_suite("oom")) {
    /* Sanity: with a 16 MB limit, a trivial module should NOT trigger the
     * pre-eval check. If this fires, the threshold is too aggressive and
     * normal apps would spam false positives. */
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);
    JS_SetMemoryLimit(JS_GetRuntime(ctx), 16 * 1024 * 1024);

    OOMRecorder recorder;
    MIK_SetOOMHandler(rt, record_oom, &recorder);

    const char* src = "export const x = 1;";
    JSValue result = MIK_EvalModuleContent(ctx, "<test>", src, strlen(src));
    JS_FreeValue(ctx, result);

    CHECK_MESSAGE(recorder.events.empty(),
                  "Expected no OOM events with a generous (16 MB) memory limit");
    CHECK_MESSAGE(!MIK_ConsumeOOMFlag(rt), "Expected OOM flag to be clear");

    MIK_FreeRuntime(rt);
}

TEST_CASE("No OOM event when mem_limit is 0 (unlimited)" * doctest::test_suite("oom")) {
    /* mem_limit == 0 means no soft cap. The pre-eval check should
     * short-circuit and never fire. */
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);

    OOMRecorder recorder;
    MIK_SetOOMHandler(rt, record_oom, &recorder);

    JSContext* ctx = MIK_GetJSContext(rt);
    const char* src = "export const x = 1;";
    JSValue result = MIK_EvalModuleContent(ctx, "<test>", src, strlen(src));
    JS_FreeValue(ctx, result);

    CHECK_MESSAGE(recorder.events.empty(),
                  "Expected no OOM events when mem_limit is 0 (unlimited)");

    MIK_FreeRuntime(rt);
}

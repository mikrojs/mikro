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

TEST_CASE("Cycle GC fires before a mem_limit below the QuickJS default threshold" *
          doctest::test_suite("oom")) {
    /* QuickJS's automatic cycle collector only runs once the heap crosses
     * the GC threshold (256 KB default), and allocations fail hard against
     * the memory limit without a GC retry. With a mem_limit below 256 KB
     * (the norm on no-PSRAM chips), cyclic garbage would accumulate
     * straight into OOM unless runtime creation caps the threshold below
     * the limit. This builds ~480 KB of cyclic garbage under a ~192 KB
     * limit; it only survives if the collector fires along the way. */
    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    options.mem_limit = 192 * 1024;
    MIKRuntime* rt = MIK_NewRuntimeOptions(&options);
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    /* The threshold cap is the fix's contract: below the limit, with margin
     * for garbage created between trigger checks. */
    CHECK_MESSAGE(JS_GetGCThreshold(JS_GetRuntime(ctx)) < (size_t)options.mem_limit,
                  "Expected GC threshold to be capped below mem_limit at creation");

    OOMRecorder recorder;
    MIK_SetOOMHandler(rt, record_oom, &recorder);

    /* Each iteration leaks one a<->b reference cycle pinning a 1 KB buffer.
     * Refcounting alone never frees these; only the cycle collector can. */
    const char* src =
        "for (let i = 0; i < 400; i++) {\n"
        "  const a = { buf: new ArrayBuffer(1024) };\n"
        "  const b = { a };\n"
        "  a.b = b;\n"
        "}\n"
        "export const ok = true;\n";
    JSValue result = MIK_EvalModuleContent(ctx, "<cycles>", src, strlen(src));
    /* Module evaluation returns a promise; an OOM during top-level
     * execution rejects it rather than raising a synchronous exception. */
    CHECK_MESSAGE(!JS_IsException(result), "Expected module compilation to succeed");
    CHECK_MESSAGE(JS_PromiseState(ctx, result) == JS_PROMISE_FULFILLED,
                  "Expected cyclic garbage to be collected before the memory limit");
    JS_FreeValue(ctx, result);
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }

    CHECK_MESSAGE(recorder.events.empty(), "Expected no OOM events");
    CHECK_MESSAGE(!MIK_ConsumeOOMFlag(rt), "Expected OOM flag to be clear");

    MIK_FreeRuntime(rt);
}

TEST_CASE("Cycle GC keeps firing within a single long job storm" * doctest::test_suite("oom")) {
    /* QuickJS raises the GC threshold to 1.5x live size after every GC
     * pass. With live data >= ~2/3 of mem_limit (the norm on esp32c3),
     * one mid-turn GC pushes the threshold past the limit, and without a
     * re-clamp between jobs the rest of that same turn allocates cyclic
     * garbage straight into the hard limit. The per-job re-clamp in
     * mik__execute_jobs is what this pins: the setup retains ~130 KB
     * (90 ArrayBuffer ballast plus the 60-promise chain) above the
     * measured base runtime size, leaving ~70 KB that a 60-job storm
     * leaking ~4 KB of cycles each overruns unless GC keeps firing.
     * The limit is derived from a probe runtime because an absolute
     * limit is not portable: glibc and macOS account different usable
     * sizes for the same workload. */
    size_t base_size = 0;
    {
        MIKRunOptions probe_options;
        MIK_DefaultOptions(&probe_options);
        MIKRuntime* probe = MIK_NewRuntimeOptions(&probe_options);
        REQUIRE(probe != nullptr);
        JSMemoryUsage usage;
        JS_ComputeMemoryUsage(JS_GetRuntime(MIK_GetJSContext(probe)), &usage);
        base_size = (size_t)usage.malloc_size;
        MIK_FreeRuntime(probe);
    }

    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    options.mem_limit = (int)(base_size + 200 * 1024);
    MIKRuntime* rt = MIK_NewRuntimeOptions(&options);
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    OOMRecorder recorder;
    MIK_SetOOMHandler(rt, record_oom, &recorder);

    const char* src =
        "globalThis.live = Array.from({length: 90}, () => new ArrayBuffer(1024));\n"
        "let p = Promise.resolve();\n"
        "for (let i = 0; i < 60; i++) {\n"
        "  p = p.then(() => {\n"
        "    for (let j = 0; j < 4; j++) {\n"
        "      const a = { buf: new ArrayBuffer(1024) };\n"
        "      const b = { a };\n"
        "      a.b = b;\n"
        "    }\n"
        "  });\n"
        "}\n"
        "p.then(() => { globalThis.stormDone = true; });\n";
    JSValue result = JS_Eval(ctx, src, strlen(src), "main.js", JS_EVAL_TYPE_GLOBAL);
    CHECK_MESSAGE(!JS_IsException(result), "Expected storm setup to evaluate");
    JS_FreeValue(ctx, result);

    /* One MIK_Loop turn drains the whole chain. */
    MIK_Loop(rt);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue done = JS_GetPropertyStr(ctx, global, "stormDone");
    CHECK_MESSAGE(JS_ToBool(ctx, done) == 1,
                  "Expected the storm to finish without an OOM rejection");
    JS_FreeValue(ctx, done);
    JS_FreeValue(ctx, global);
    CHECK_MESSAGE(recorder.events.empty(), "Expected no OOM events during the storm");
    CHECK_MESSAGE(!MIK_ConsumeOOMFlag(rt), "Expected OOM flag to be clear");

    MIK_FreeRuntime(rt);
}

TEST_CASE("MIK_Loop re-clamps the GC threshold after adaptive growth" *
          doctest::test_suite("oom")) {
    /* After every GC pass QuickJS raises the threshold to 1.5x the live
     * size, which can push it back above mem_limit and silently re-disable
     * automatic collection. MIK_Loop must pull it back under the limit. */
    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    options.mem_limit = 192 * 1024;
    MIKRuntime* rt = MIK_NewRuntimeOptions(&options);
    REQUIRE(rt != nullptr);
    JSRuntime* js_rt = JS_GetRuntime(MIK_GetJSContext(rt));

    /* Simulate the post-GC adaptive update overshooting the limit. */
    JS_SetGCThreshold(js_rt, 10 * 1024 * 1024);
    MIK_Loop(rt);
    CHECK_MESSAGE(JS_GetGCThreshold(js_rt) < (size_t)options.mem_limit,
                  "Expected MIK_Loop to re-clamp the GC threshold below mem_limit");

    MIK_FreeRuntime(rt);
}

TEST_CASE("GC threshold untouched when mem_limit is 0 (unlimited)" *
          doctest::test_suite("oom")) {
    /* Hosts (Node addon, tests) run unlimited; the QuickJS default
     * threshold must stay in effect there. */
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSRuntime* js_rt = JS_GetRuntime(MIK_GetJSContext(rt));
    /* Compare against a vanilla runtime's default rather than pinning the
     * upstream constant, so a quickjs-ng bump that retunes the default
     * doesn't fail this test while mikrojs behavior is still correct. */
    JSRuntime* vanilla = JS_NewRuntime();
    size_t vanilla_threshold = JS_GetGCThreshold(vanilla);
    JS_FreeRuntime(vanilla);
    CHECK_MESSAGE(JS_GetGCThreshold(js_rt) == vanilla_threshold,
                  "Expected the QuickJS default GC threshold with no mem_limit");
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

#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <quickjs.h>

#include <doctest.h>

int jsval_as_int32(JSContext* ctx, JSValue val) {
    int32_t num;
    JS_ToInt32(ctx, &num, val);
    JS_FreeValue(ctx, val);
    return num;
}

TEST_CASE("Simple eval works" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);
    const char* code = "2+2";
    const auto result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);

    CHECK(JS_IsNumber(result));
    CHECK(JS_IsEqual(ctx, result, JS_NewNumber(ctx, 4)));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Returns exception upon error" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    const char* code = "this.will.fail";

    const auto result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);

    CHECK(JS_IsException(result));
    JS_FreeValue(ctx, result);
    MIK_FreeRuntime(rt);
}

TEST_CASE("Defines setTimeout, clearTimeout, setInterval, clearInterval" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    auto const eval = [ctx](const char* code) -> JSValue {
        return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    };

    const char* s;
    s = JS_ToCString(ctx, eval("typeof setTimeout"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof clearTimeout"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof setInterval"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof clearInterval"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Unhandled rejection calls error handler exactly once" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    int error_count = 0;
    MIK_SetErrorHandler(rt, [](JSContext*, JSValue, void* opaque) {
        (*static_cast<int*>(opaque))++;
    }, &error_count);

    const char* code = "Promise.reject(new Error('test'))";
    JSValue result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, result);

    /* Run the loop — should return 1 (error) and stop */
    int rc = MIK_Loop(rt);

    /* The promise rejection fires during execute_jobs inside MIK_Loop.
     * The error handler must be called exactly once, not twice. */
    CHECK_EQ(1, error_count);
    CHECK_EQ(1, rc);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Does not leak memory when running timers" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    const char* code = R"(
    globalThis.ticks = 0;
    const tick = () => {
        globalThis.ticks++
        setTimeout(() => tick(), 0)
     }
    setTimeout(() => tick(), 0)
  )";

    auto const eval = [ctx](const char* code) -> JSValue {
        return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    };
    JSValue result = eval(code);

    for (int i = 0; i < 1000; i++) {
        MIK_Loop(rt);
    }
    auto ticks = jsval_as_int32(ctx, eval("globalThis.ticks"));

    CHECK_EQ(1000, ticks);

    JS_FreeValue(ctx, result);
    MIK_FreeRuntime(rt);
}

/* Instrumented platform for the yield tests: a fake boot clock that jumps
 * forward on every read, and a yield counter. Lets the test simulate seconds
 * of continuous job execution in microseconds of real time. */
static int64_t s_fake_boot_us = 0;
static int64_t s_fake_step_us = 0;
static int s_yield_count = 0;

static int64_t fake_get_boot_us(void) {
    s_fake_boot_us += s_fake_step_us;
    return s_fake_boot_us;
}

static void counting_yield(void) {
    s_yield_count++;
}

TEST_CASE("Long promise-job storms yield to the platform periodically" *
          doctest::test_suite("runtime")) {
    /* A chain of already-settled promises drains as one synchronous storm of
     * jobs. On ESP32 that starves the FreeRTOS idle task and trips the task
     * watchdog, so mik__execute_jobs must call platform->yield() about once
     * per second of continuous work. */
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.get_boot_us = fake_get_boot_us;
    fake.yield = counting_yield;
    s_fake_boot_us = 1000;
    s_fake_step_us = 300 * 1000; /* every clock read advances 300 ms */
    s_yield_count = 0;
    MIK_SetPlatform(&fake);

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    const char* src =
        "let p = Promise.resolve();"
        "for (let i = 0; i < 30; i++) p = p.then(() => {});";
    JSValue result = JS_Eval(ctx, src, strlen(src), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, result);
    MIK_Loop(rt); /* drains all 30 jobs; ~9 s of fake clock elapse */
    int yields_during_storm = s_yield_count;

    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);

    CHECK_MESSAGE(yields_during_storm >= 3,
                  "Expected periodic yields during a long job storm, got "
                      << yields_during_storm);
}

TEST_CASE("Waking after a long idle period does not inject a spurious yield" *
          doctest::test_suite("runtime")) {
    /* The yield interval measures continuous BUSY work. An app that idles
     * between timer wakes must not pay a yield (one ~10 ms tick) on the
     * first job of every wake just because wall-clock time passed while
     * the queue was empty: empty drains re-arm the interval. */
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.get_boot_us = fake_get_boot_us;
    fake.yield = counting_yield;
    s_fake_boot_us = 1000;
    /* Small per-read step: a single turn's handful of clock reads must
     * stay inside the 1 s interval, while ten idle turns add up to
     * several fake seconds. */
    s_fake_step_us = 200 * 1000;
    s_yield_count = 0;
    MIK_SetPlatform(&fake);

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    /* A short burst to seed the busy-interval timestamp. */
    const char* burst = "Promise.resolve().then(() => {});";
    JSValue r1 = JS_Eval(ctx, burst, strlen(burst), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r1);
    MIK_Loop(rt);
    s_yield_count = 0;

    /* Simulate several seconds of idle: empty MIK_Loop turns while the
     * fake clock marches 0.6 s per read. */
    for (int i = 0; i < 10; i++) {
        MIK_Loop(rt);
    }

    /* First job after the idle stretch must not yield. */
    JSValue r2 = JS_Eval(ctx, burst, strlen(burst), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r2);
    MIK_Loop(rt);

    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);

    CHECK_MESSAGE(s_yield_count == 0,
                  "Expected no yield on the first job after idle, got " << s_yield_count);
}

TEST_CASE("Short job bursts do not force a yield" * doctest::test_suite("runtime")) {
    /* With a frozen clock no interval ever elapses; the job drain must not
     * inject yields (and their ~10 ms tick latency) into short bursts. */
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.get_boot_us = fake_get_boot_us;
    fake.yield = counting_yield;
    s_fake_boot_us = 1000;
    s_fake_step_us = 0;
    s_yield_count = 0;
    MIK_SetPlatform(&fake);

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    const char* src =
        "let p = Promise.resolve();"
        "for (let i = 0; i < 30; i++) p = p.then(() => {});";
    JSValue result = JS_Eval(ctx, src, strlen(src), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, result);
    MIK_Loop(rt);
    int yields_during_burst = s_yield_count;

    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);

    CHECK_MESSAGE(yields_during_burst == 0,
                  "Expected no yields with no elapsed time, got " << yields_during_burst);
}

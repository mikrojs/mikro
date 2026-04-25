#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "soc/soc_caps.h"
#include "unity.h"

/* Sleep module is self-registered via MIK_REGISTER_MODULE and lazily initialized */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

/* ── Module exports ──────────────────────────────────────────────── */

TEST_CASE("native:sleep exports expected functions", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import {
            deepSleep, lightSleep, getWakeupCause,
            enableTimerWakeup, enableGpioWakeup,
            disableWakeupSource
        } from "native:sleep";
        globalThis.__deepSleep = typeof deepSleep === "function";
        globalThis.__lightSleep = typeof lightSleep === "function";
        globalThis.__getWakeupCause = typeof getWakeupCause === "function";
        globalThis.__enableTimerWakeup = typeof enableTimerWakeup === "function";
        globalThis.__enableGpioWakeup = typeof enableGpioWakeup === "function";
        globalThis.__disableWakeupSource = typeof disableWakeupSource === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    const char* names[] = {"__deepSleep",          "__lightSleep",    "__getWakeupCause",
                           "__enableTimerWakeup",   "__enableGpioWakeup",
                           "__disableWakeupSource"};
    for (int i = 0; i < 6; i++) {
        JSValue v = JS_GetPropertyStr(ctx, global, names[i]);
        TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), names[i]);
        JS_FreeValue(ctx, v);
    }

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── getWakeupCause returns a string ─────────────────────────────── */

TEST_CASE("native:sleep getWakeupCause returns a string", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { getWakeupCause } from "native:sleep";
        const cause = getWakeupCause();
        globalThis.__isString = typeof cause === "string";
        globalThis.__cause = cause;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue isString = JS_GetPropertyStr(ctx, global, "__isString");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isString), "getWakeupCause should return a string");
    JS_FreeValue(ctx, isString);

    JSValue cause = JS_GetPropertyStr(ctx, global, "__cause");
    const char* str = JS_ToCString(ctx, cause);
    TEST_ASSERT_NOT_NULL_MESSAGE(str, "cause should be a valid string");
    /* On fresh boot (no prior sleep), cause is typically "undefined" or "timer"
     * depending on how the test harness rebooted. Just verify it's non-empty. */
    TEST_ASSERT_GREATER_THAN_MESSAGE(0, strlen(str), "cause should be non-empty");
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, cause);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── enableTimerWakeup accepts microseconds ──────────────────────── */

TEST_CASE("native:sleep enableTimerWakeup does not throw", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { enableTimerWakeup } from "native:sleep";
        enableTimerWakeup(5000000);
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "enableTimerWakeup should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── disableWakeupSource works ───────────────────────────────────── */

TEST_CASE("native:sleep disableWakeupSource clears all sources", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { enableTimerWakeup, disableWakeupSource } from "native:sleep";
        enableTimerWakeup(1000000);
        disableWakeupSource();
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "disableWakeupSource should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── disableWakeupSource with specific source ────────────────────── */

TEST_CASE("native:sleep disableWakeupSource with 'timer'", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { enableTimerWakeup, disableWakeupSource } from "native:sleep";
        enableTimerWakeup(1000000);
        disableWakeupSource("timer");
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "disableWakeupSource('timer') should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── disableWakeupSource throws on invalid source ────────────────── */

TEST_CASE("native:sleep disableWakeupSource throws on invalid source", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { disableWakeupSource } from "native:sleep";
        try {
            disableWakeupSource("invalid");
            globalThis.__threw = false;
        } catch (e) {
            globalThis.__threw = true;
            globalThis.__isRangeError = e instanceof RangeError;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue threw = JS_GetPropertyStr(ctx, global, "__threw");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, threw),
                             "disableWakeupSource should throw on invalid source");
    JS_FreeValue(ctx, threw);

    JSValue isRange = JS_GetPropertyStr(ctx, global, "__isRangeError");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isRange), "error should be RangeError");
    JS_FreeValue(ctx, isRange);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── lightSleep with very short duration ─────────────────────────── */
/* Light sleep disconnects UART console on targets without USB Serial/JTAG,
   causing the test monitor to stall. Only run on chips that have USB
   Serial/JTAG which keeps the connection alive through light sleep. */
TEST_CASE("native:sleep lightSleep with 1ms returns or rejects gracefully", "[modules]") {
#if !SOC_USB_SERIAL_JTAG_SUPPORTED
    TEST_IGNORE_MESSAGE("light sleep disconnects UART console — skipped on non-USB targets");
#endif
    setup();

    JSValue ret = eval_module(R"(
        import { lightSleep } from "native:sleep";
        try {
            lightSleep(1);
            globalThis.__result = "ok";
        } catch (e) {
            // Light sleep may fail on boards with USB JTAG or other constraints
            globalThis.__result = "caught:" + e.message;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result = JS_GetPropertyStr(ctx, global, "__result");
    const char* str = JS_ToCString(ctx, result);
    TEST_ASSERT_NOT_NULL_MESSAGE(str, "result should be set");
    /* Either "ok" (sleep succeeded) or "caught:..." (threw a catchable error) — both are fine */
    TEST_ASSERT_TRUE_MESSAGE(strncmp(str, "ok", 2) == 0 || strncmp(str, "caught:", 7) == 0,
                             "lightSleep should either succeed or throw a catchable error");
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);
    teardown();
}

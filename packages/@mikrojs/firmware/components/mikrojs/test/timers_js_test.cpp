#include "mikrojs.h"
#include "quickjs.h"
#include "unity.h"

static MIKRuntime* rt;
static JSContext* ctx;

static JSValue eval(const char* code) {
    return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
}

static int32_t eval_int(const char* code) {
    int32_t num;
    JSValue val = eval(code);
    JS_ToInt32(ctx, &num, val);
    JS_FreeValue(ctx, val);
    return num;
}

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

TEST_CASE("setTimeout fires callback", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.fired = false;
        setTimeout(() => { globalThis.fired = true; }, 0);
    )");
    JS_FreeValue(ctx, r);

    MIK_Loop(rt);

    JSValue fired = eval("globalThis.fired");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, fired), "setTimeout callback should have fired");
    JS_FreeValue(ctx, fired);

    teardown();
}

TEST_CASE("clearTimeout cancels a pending timer", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.fired = false;
        const id = setTimeout(() => { globalThis.fired = true; }, 0);
        clearTimeout(id);
    )");
    JS_FreeValue(ctx, r);

    MIK_Loop(rt);

    JSValue fired = eval("globalThis.fired");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, fired),
                              "Callback should not fire after clearTimeout");
    JS_FreeValue(ctx, fired);

    teardown();
}

TEST_CASE("setInterval fires repeatedly", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.count = 0;
        setInterval(() => { globalThis.count++; }, 0);
    )");
    JS_FreeValue(ctx, r);

    for (int i = 0; i < 5; i++) {
        MIK_Loop(rt);
    }

    int32_t count = eval_int("globalThis.count");
    TEST_ASSERT_GREATER_OR_EQUAL_INT32_MESSAGE(5, count,
                                               "setInterval should fire on each loop iteration");

    teardown();
}

TEST_CASE("clearInterval stops an interval", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.count = 0;
        globalThis.intervalId = setInterval(() => { globalThis.count++; }, 0);
    )");
    JS_FreeValue(ctx, r);

    // Run a few loops to accumulate some ticks
    for (int i = 0; i < 3; i++) {
        MIK_Loop(rt);
    }

    JSValue r2 = eval("clearInterval(globalThis.intervalId);");
    JS_FreeValue(ctx, r2);

    int32_t count_after_clear = eval_int("globalThis.count");

    // Run more loops — count should not increase
    for (int i = 0; i < 3; i++) {
        MIK_Loop(rt);
    }

    int32_t count_final = eval_int("globalThis.count");
    TEST_ASSERT_EQUAL_INT32_MESSAGE(count_after_clear, count_final,
                                    "Count should not increase after clearInterval");

    teardown();
}

TEST_CASE("setTimeout passes extra arguments to callback", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.result = 0;
        setTimeout((a, b) => { globalThis.result = a + b; }, 0, 17, 25);
    )");
    JS_FreeValue(ctx, r);

    MIK_Loop(rt);

    int32_t result = eval_int("globalThis.result");
    TEST_ASSERT_EQUAL_INT32_MESSAGE(42, result,
                                    "Callback should receive extra args passed to setTimeout");

    teardown();
}

TEST_CASE("clearTimeout on non-existent ID is a no-op", "[timers]") {
    setup();

    // Should not throw or crash
    JSValue r = eval("clearTimeout(99999);");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r),
                              "clearTimeout with invalid ID should not throw");
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("setTimeout throws RangeError when passing too many args", "[timers]") {
    setup();

    JSValue r = eval(R"(
        try {
            setTimeout(() => {}, 0, 1, 2, 3, 4, 5);
            false;
        } catch (e) {
            e instanceof RangeError;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "Should not throw at top level");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, r), "Should have caught a RangeError");
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("setTimeout with non-zero delay does not fire immediately", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.fired = false;
        setTimeout(() => { globalThis.fired = true; }, 1000);
    )");
    JS_FreeValue(ctx, r);

    // Run the loop once — the 1000ms timer should not fire yet
    MIK_Loop(rt);

    JSValue fired = eval("globalThis.fired");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, fired),
                              "setTimeout with 1000ms delay should not fire immediately");
    JS_FreeValue(ctx, fired);

    teardown();
}

TEST_CASE("setInterval with non-zero delay does not fire immediately", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.count = 0;
        setInterval(() => { globalThis.count++; }, 500);
    )");
    JS_FreeValue(ctx, r);

    // Run the loop once — the 500ms interval should not fire yet
    MIK_Loop(rt);

    int32_t count = eval_int("globalThis.count");
    TEST_ASSERT_EQUAL_INT32_MESSAGE(0, count,
                                    "setInterval with 500ms delay should not fire immediately");

    teardown();
}

TEST_CASE("clearInterval inside callback does not crash", "[timers]") {
    setup();

    JSValue r = eval(R"(
        globalThis.result = "";
        var id = setInterval(() => {
            globalThis.result += "tick";
            clearInterval(id);
        }, 0);
    )");
    JS_FreeValue(ctx, r);

    // Run several loops — the callback should fire once and then stop.
    // Before the fix this would crash (use-after-free) because clearInterval
    // freed JSValues while the copied dueTimers vector still referenced them.
    for (int i = 0; i < 5; i++) {
        MIK_Loop(rt);
    }

    JSValue val = eval("globalThis.result");
    const char* str = JS_ToCString(ctx, val);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("tick", str,
                                      "Callback should fire exactly once before clearInterval stops it");
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, val);

    teardown();
}

TEST_CASE("setTimeout returns a numeric timer ID", "[timers]") {
    setup();

    JSValue r = eval("setTimeout(() => {}, 0)");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsNumber(r), "setTimeout should return a number");

    int32_t id;
    JS_ToInt32(ctx, &id, r);
    TEST_ASSERT_GREATER_THAN_INT32_MESSAGE(0, id, "Timer ID should be > 0");
    JS_FreeValue(ctx, r);

    teardown();
}

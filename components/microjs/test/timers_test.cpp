#include "../timers.cpp"

#include "error_utils.h"
#include "quickjs.h"
#include "unity.h"

JSValue __timer_test__noop(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    return JS_UNDEFINED;
}

TEST_CASE("Supports adding new timers", "[timers]") {
    UJSTimerRegistry timers = UJSTimerRegistry();
    JSContext* ctx = JS_NewContext(JS_NewRuntime());
    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);
    uint32_t timer_id;
    JS_ToUint32(ctx, &timer_id, timers.schedule(ctx, cb, argc, argv, 1000, false, 1000));

    TEST_ASSERT_EQUAL_INT(1, timer_id);
    JS_ToUint32(ctx, &timer_id, timers.schedule(ctx, cb, argc, argv, 2000, false, 2000));

    TEST_ASSERT_EQUAL_INT(2, timer_id);
    TEST_ASSERT_EQUAL_INT(timers.timerCount(), 2);
}

TEST_CASE("Supports removing existing timers", "[timers]") {
    UJSTimerRegistry timers = UJSTimerRegistry();
    JSContext* ctx = JS_NewContext(JS_NewRuntime());
    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);
    timers.schedule(ctx, cb, argc, argv, 2000, false, 2000);
    JSValue timer_id = timers.schedule(ctx, cb, argc, argv, 1000, false, 1000);
    TEST_ASSERT_EQUAL_INT(timers.timerCount(), 2);
    timers.unschedule(ctx, timer_id);
    TEST_ASSERT_EQUAL_INT(timers.timerCount(), 1);
}

TEST_CASE("Supports getting due deadline from timers", "[timers]") {
    UJSTimerRegistry timers = UJSTimerRegistry();
    JSContext* ctx = JS_NewContext(JS_NewRuntime());
    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    timers.schedule(ctx, cb, argc, argv, 10, false, 10);
    timers.schedule(ctx, cb, argc, argv, 100, false, 100);
    timers.schedule(ctx, cb, argc, argv, 200, false, 200);

    TEST_ASSERT_EQUAL_INT(timers.timerCount(), 3);
    TEST_ASSERT_EQUAL(timers.timersDue(0).size(), 0);
    TEST_ASSERT_EQUAL(timers.timersDue(50).size(), 1);
    TEST_ASSERT_EQUAL(timers.timersDue(99).size(), 1);
    TEST_ASSERT_EQUAL(timers.timersDue(100).size(), 2);
    TEST_ASSERT_EQUAL(timers.timersDue(200).size(), 3);
}

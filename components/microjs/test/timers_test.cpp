#include "../timers.cpp"

#include "error_utils.h"
#include "quickjs.h"
#include "unity.h"

JSValue __timer_test__noop(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    return JS_UNDEFINED;
}

TEST_CASE("init and destroy", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    UJSTimerRegistry* timers = UJS_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    uint32_t timer_id;

    timer_id = UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    TEST_ASSERT_EQUAL_UINT32(1, timer_id);

    timer_id = UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    TEST_ASSERT_EQUAL_UINT32(2, timer_id);
    JS_FreeValue(ctx, cb);
    UJS_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Supports removing existing timers", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    UJSTimerRegistry* timers = UJS_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    auto const timer_id_1 = UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    auto const timer_id_2 = UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);

    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 2);
    UJS_Timer_UnSchedule(timers, ctx, timer_id_1);
    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 1);
    UJS_Timer_UnSchedule(timers, ctx, timer_id_2);
    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 0);
    JS_FreeValue(ctx, cb);
    UJS_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Supports getting due deadline from timers", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    UJSTimerRegistry* timers = UJS_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 10, false, 0);
    UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 100, false, 0);
    UJS_Timer_Schedule(timers, ctx, cb, argc, argv, 200, false, 0);

    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 3);
    TEST_ASSERT_EQUAL(UJS_Timer_GetDueTimers(timers, 0).size(), 0);
    TEST_ASSERT_EQUAL(UJS_Timer_GetDueTimers(timers, 50).size(), 1);
    TEST_ASSERT_EQUAL(UJS_Timer_GetDueTimers(timers, 99).size(), 1);
    TEST_ASSERT_EQUAL(UJS_Timer_GetDueTimers(timers, 100).size(), 2);
    TEST_ASSERT_EQUAL(UJS_Timer_GetDueTimers(timers, 200).size(), 3);
    JS_FreeValue(ctx, cb);
    UJS_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

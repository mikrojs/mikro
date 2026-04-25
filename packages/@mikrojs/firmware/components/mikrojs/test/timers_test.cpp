/* Include standalone library source directly for testing internal functions */
#include "../../../../packages/@mikrojs/native/src/timers.cpp"

#include "quickjs.h"
#include "unity.h"

JSValue __timer_test__noop(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    return JS_UNDEFINED;
}

TEST_CASE("init and destroy", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    MIKTimerRegistry* timers = MIK_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    uint32_t timer_id;

    timer_id = MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    TEST_ASSERT_EQUAL_UINT32(1, timer_id);

    timer_id = MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    TEST_ASSERT_EQUAL_UINT32(2, timer_id);
    JS_FreeValue(ctx, cb);
    MIK_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Supports removing existing timers", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    MIKTimerRegistry* timers = MIK_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    auto const timer_id_1 = MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);
    auto const timer_id_2 = MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 1000, false);

    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 2);
    MIK_Timer_UnSchedule(timers, ctx, timer_id_1);
    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 1);
    MIK_Timer_UnSchedule(timers, ctx, timer_id_2);
    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 0);
    JS_FreeValue(ctx, cb);
    MIK_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Supports getting due deadline from timers", "[timers]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);
    MIKTimerRegistry* timers = MIK_NewTimerRegistry();

    JSValue argv[0];
    JSValue argc = JS_NewUint32(ctx, 0);
    JSValue cb = JS_NewCFunction(ctx, __timer_test__noop, "callme", 0);

    MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 10, false, 0);
    MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 100, false, 0);
    MIK_Timer_Schedule(timers, ctx, cb, argc, argv, 200, false, 0);

    TEST_ASSERT_EQUAL_INT(timers->entries.size(), 3);
    TEST_ASSERT_EQUAL(MIK_Timer_CountDue(timers, 0), 0);
    TEST_ASSERT_EQUAL(MIK_Timer_CountDue(timers, 50), 1);
    TEST_ASSERT_EQUAL(MIK_Timer_CountDue(timers, 99), 1);
    TEST_ASSERT_EQUAL(MIK_Timer_CountDue(timers, 100), 2);
    TEST_ASSERT_EQUAL(MIK_Timer_CountDue(timers, 200), 3);
    JS_FreeValue(ctx, cb);
    MIK_Timer_ClearAll(timers, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

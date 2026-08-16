#include <cstdio>
#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for timers.cpp driven by a fully controlled clock: the
 * fake platform's get_boot_us returns a value the test advances explicitly,
 * so due-ness is deterministic and no test ever sleeps. */

/* Registry C API: defined in timers.cpp without a public header (the
 * on-device suite declares them the same way). */
size_t MIK_Timer_CountDue(MIKTimers* timers, int64_t now);
void MIK_Timer_SetNextDeadline(MIKTimers* timers, uint32_t id, int64_t next_deadline);

namespace {

static int64_t g_now_us = 0;

static int64_t fake_boot_us(void) {
    return g_now_us;
}

struct TimerFixture {
    const MIKPlatform* orig = nullptr;
    MIKPlatform fake;
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    TimerFixture() {
        g_now_us = 1000;
        orig = MIK_GetPlatform();
        fake = *orig;
        fake.get_boot_us = fake_boot_us;
        MIK_SetPlatform(&fake);
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~TimerFixture() {
        MIK_FreeRuntime(rt);
        MIK_SetPlatform(orig);
    }

    void advance_ms(int64_t ms) { g_now_us += ms * 1000; }

    void eval(const char* src) {
        JSValue rv = JS_Eval(ctx, src, strlen(src), "timers.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(rv)) {
            JSValue exc = JS_GetException(ctx);
            const char* s = JS_ToCString(ctx, exc);
            if (s) {
                fprintf(stderr, "[timers eval] %s\n", s);
                JS_FreeCString(ctx, s);
            }
            JS_FreeValue(ctx, exc);
            FAIL("eval threw");
        }
        JS_FreeValue(ctx, rv);
    }

    int global_int(const char* name) {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue v = JS_GetPropertyStr(ctx, g, name);
        JS_FreeValue(ctx, g);
        int32_t i = -1;
        JS_ToInt32(ctx, &i, v);
        JS_FreeValue(ctx, v);
        return i;
    }

    std::string global_str(const char* name) {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue v = JS_GetPropertyStr(ctx, g, name);
        JS_FreeValue(ctx, g);
        const char* s = JS_ToCString(ctx, v);
        std::string out = s ? s : "";
        JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, v);
        return out;
    }
};

}  // namespace

TEST_CASE_FIXTURE(TimerFixture, "setTimeout fires once after its delay" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__fired = 0\n"
         "setTimeout(() => { globalThis.__fired++ }, 10)\n");
    MIK_Loop(rt);
    CHECK(global_int("__fired") == 0); /* not due yet */
    advance_ms(11);
    MIK_Loop(rt);
    CHECK(global_int("__fired") == 1);
    advance_ms(50);
    MIK_Loop(rt); /* one-shot: never fires again */
    CHECK(global_int("__fired") == 1);
    CHECK(rt->timers->entries.empty());
}

TEST_CASE_FIXTURE(TimerFixture, "setTimeout forwards extra arguments" *
                                    doctest::test_suite("timers")) {
    eval("setTimeout((a, b, c) => { globalThis.__args = `${a}|${b}|${c}` }, 0, 'x', 7, true)\n");
    advance_ms(1);
    MIK_Loop(rt);
    CHECK(global_str("__args") == "x|7|true");
}

TEST_CASE_FIXTURE(TimerFixture, "setTimeout argument validation" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__notFn = (() => { try { setTimeout(42) } catch (e) { return e.name } })()\n"
         "globalThis.__tooMany = (() => {\n"
         "  try { setTimeout(() => {}, 0, 1, 2, 3, 4, 5) } catch (e) { return e.name }\n"
         "})()\n"
         "globalThis.__badDelay = (() => {\n"
         "  try { setTimeout(() => {}, Symbol('no')) } catch (e) { return e.name }\n"
         "})()\n"
         "globalThis.__noDelay = typeof setTimeout(() => { globalThis.__zero = 1 })\n"
         "globalThis.__badClear = (() => {\n"
         "  try { clearTimeout(Symbol('no')) } catch (e) { return e.name }\n"
         "})()\n");
    CHECK(global_str("__notFn") == "TypeError");
    CHECK(global_str("__tooMany") == "RangeError");
    CHECK(global_str("__badDelay") == "TypeError");
    CHECK(global_str("__noDelay") == "number"); /* missing delay means 0 */
    CHECK(global_str("__badClear") == "TypeError");
    advance_ms(1);
    MIK_Loop(rt);
    CHECK(global_int("__zero") == 1);
}

TEST_CASE_FIXTURE(TimerFixture, "clearTimeout cancels and is id-tolerant" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__fired = 0\n"
         "const id = setTimeout(() => { globalThis.__fired++ }, 5)\n"
         "clearTimeout(id)\n"
         "clearTimeout(id)\n"     /* double-clear is a no-op */
         "clearTimeout(99999)\n"  /* unknown id is a no-op */);
    advance_ms(10);
    MIK_Loop(rt);
    CHECK(global_int("__fired") == 0);
}

TEST_CASE_FIXTURE(TimerFixture, "setInterval repeats until cleared" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__ticks = 0\n"
         "globalThis.__id = setInterval(() => { globalThis.__ticks++ }, 10)\n");
    for (int i = 0; i < 3; i++) {
        advance_ms(11);
        MIK_Loop(rt);
    }
    CHECK(global_int("__ticks") == 3);
    eval("clearInterval(globalThis.__id)\n");
    advance_ms(11);
    MIK_Loop(rt);
    CHECK(global_int("__ticks") == 3);
}

TEST_CASE_FIXTURE(TimerFixture, "an interval can clear itself mid-callback" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__self = 0\n"
         "const id = setInterval(() => { globalThis.__self++; clearInterval(id) }, 10)\n");
    advance_ms(11);
    MIK_Loop(rt);
    advance_ms(11);
    MIK_Loop(rt);
    CHECK(global_int("__self") == 1);
    CHECK(rt->timers->entries.empty());
}

TEST_CASE_FIXTURE(TimerFixture, "a callback can clear a sibling due in the same pass" *
                                    doctest::test_suite("timers")) {
    /* due timers run in scheduling order, so the clearing callback goes
     * first: its sibling is unscheduled before the pass reaches it and the
     * cleared-entry skip branch must fire */
    eval("globalThis.__log = ''\n"
         "setTimeout(() => { globalThis.__log += 'A'; clearTimeout(globalThis.__second) }, 4)\n"
         "globalThis.__second = setTimeout(() => { globalThis.__log += 'B' }, 5)\n");
    advance_ms(10); /* both due in the same pass */
    MIK_Loop(rt);
    CHECK(global_str("__log") == "A");
    CHECK(rt->timers->entries.empty());
}

TEST_CASE_FIXTURE(TimerFixture, "more than MIK_MAX_DUE_TIMERS due timers drain across passes" *
                                    doctest::test_suite("timers")) {
    eval("globalThis.__count = 0\n"
         "for (let i = 0; i < 20; i++) setTimeout(() => { globalThis.__count++ }, 1)\n");
    advance_ms(5);
    MIK_Loop(rt); /* one pass handles at most 16 */
    CHECK(global_int("__count") == MIK_MAX_DUE_TIMERS);
    MIK_Loop(rt); /* the rest drain on the next pass */
    CHECK(global_int("__count") == 20);
}

namespace {

static std::string g_timer_error;
static void capture_timer_error(JSContext* ctx, JSValue error, void* opaque) {
    (void)opaque;
    const char* s = JS_ToCString(ctx, error);
    if (s) {
        g_timer_error = s;
        JS_FreeCString(ctx, s);
    }
}

}  // namespace

TEST_CASE_FIXTURE(TimerFixture, "a throwing callback stops the pass and reports" *
                                    doctest::test_suite("timers")) {
    g_timer_error.clear();
    MIK_SetErrorHandler(rt, capture_timer_error, nullptr);
    eval("globalThis.__ran = ''\n"
         /* scheduled first, so it runs first in the due pass */
         "setTimeout(() => { globalThis.__ran += 'X'; throw new Error('timer boom') }, 1)\n"
         "setTimeout(() => { globalThis.__ran += 'Y' }, 2)\n");
    advance_ms(5);
    MIK_Loop(rt);
    CHECK(global_str("__ran") == "X"); /* panic policy: later due timers skipped */
    CHECK(g_timer_error.find("timer boom") != std::string::npos);
    CHECK(MIK_IsStopRequested(rt));
    /* the skipped timer is left scheduled for the post-restart world */
    CHECK(rt->timers->entries.size() == 1);
}

TEST_CASE_FIXTURE(TimerFixture, "registry C API: CountDue and SetNextDeadline" *
                                    doctest::test_suite("timers")) {
    eval("setTimeout(() => { globalThis.__moved = 1 }, 1000)\n");
    REQUIRE(rt->timers->entries.size() == 1);
    uint32_t id = rt->timers->entries[0].id;
    CHECK(MIK_Timer_CountDue(rt->timers, g_now_us) == 0);
    /* pull the deadline in to "now": it becomes due without advancing time */
    MIK_Timer_SetNextDeadline(rt->timers, id, g_now_us);
    MIK_Timer_SetNextDeadline(rt->timers, 424242, g_now_us); /* unknown id: no-op */
    CHECK(MIK_Timer_CountDue(rt->timers, g_now_us) == 1);
    MIK_Loop(rt);
    CHECK(global_int("__moved") == 1);
}

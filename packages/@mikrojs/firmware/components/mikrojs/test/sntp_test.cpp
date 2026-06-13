#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* SNTP module is self-registered via MIK_REGISTER_MODULE and lazily initialized.
 * mik__sntp_consume and mik__sntp_inject_sync are exposed for test use. */
extern void mik__sntp_consume(JSContext* ctx);
extern void mik__sntp_inject_sync(int64_t epoch_sec);

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    /* SNTP module + loop consumer are registered lazily on first import */
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

/* ── Module structure tests ───────────────────────────────────────── */

TEST_CASE("native:mikro/sntp exports sync, stop, and setTimezone", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync, stop, setTimezone } from "native:mikro/sntp";
        globalThis.__syncIsFunc = typeof sync === "function";
        globalThis.__stopIsFunc = typeof stop === "function";
        globalThis.__setTzIsFunc = typeof setTimezone === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__syncIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sync should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__stopIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stop should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__setTzIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "setTimezone should be a function");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── sync returns a promise ───────────────────────────────────────── */

TEST_CASE("native:mikro/sntp sync returns a result-wrapped promise", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync, stop } from "native:mikro/sntp";
        const result = sync(["pool.ntp.org"], "UTC0", false);
        globalThis.__isOk = result.ok === true;
        globalThis.__isPromise = result.value instanceof Promise;
        stop();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isOk = JS_GetPropertyStr(ctx, global, "__isOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isOk), "sync() should return ok=true");
    JS_FreeValue(ctx, isOk);
    JSValue isPromise = JS_GetPropertyStr(ctx, global, "__isPromise");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isPromise), "sync().value should be a Promise");
    JS_FreeValue(ctx, isPromise);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── sync promise resolves with time on injected sync event ───────── */

TEST_CASE("native:mikro/sntp sync resolves with time when sync completes", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync, stop } from "native:mikro/sntp";
        const startResult = sync(["pool.ntp.org"], "UTC0", false);
        startResult.value.then(result => {
            globalThis.__resolved = true;
            globalThis.__hasTime = result.ok && "time" in result.value;
            globalThis.__timeValue = result.ok ? result.value.time : 0;
        });
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    /* Inject a fake sync event: 2026-06-15T12:00:00Z = 1781524800 */
    mik__sntp_inject_sync(1781524800);
    mik__sntp_consume(ctx);
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue resolved = JS_GetPropertyStr(ctx, global, "__resolved");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, resolved), "sync promise should have resolved");
    JS_FreeValue(ctx, resolved);

    JSValue hasTime = JS_GetPropertyStr(ctx, global, "__hasTime");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasTime), "result should have 'time' property");
    JS_FreeValue(ctx, hasTime);

    JSValue timeVal = JS_GetPropertyStr(ctx, global, "__timeValue");
    double time_ms;
    JS_ToFloat64(ctx, &time_ms, timeVal);
    JS_FreeValue(ctx, timeVal);
    /* 1781524800 seconds = 1781524800000 ms */
    TEST_ASSERT_FLOAT_WITHIN(1000.0, 1781524800000.0, time_ms);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── one-shot sync stops SNTP after resolving ─────────────────────── */

TEST_CASE("native:mikro/sntp one-shot sync stops after first sync", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync, stop } from "native:mikro/sntp";
        globalThis.__resolved = false;
        const startResult = sync(["pool.ntp.org"], "UTC0", false);
        startResult.value.then(() => {
            globalThis.__resolved = true;
        });
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    mik__sntp_inject_sync(1781524800);
    mik__sntp_consume(ctx);
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue resolved = JS_GetPropertyStr(ctx, global, "__resolved");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, resolved), "sync promise should have resolved");
    JS_FreeValue(ctx, resolved);

    /* A second injected event should be ignored (no pending promise) */
    mik__sntp_inject_sync(1781524800);
    mik__sntp_consume(ctx);
    /* No crash = pass */

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── stop does not crash when not running ─────────────────────────── */

TEST_CASE("native:mikro/sntp stop does not crash when not running", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stop } from "native:mikro/sntp";
        stop();
        globalThis.__stopDone = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue done = JS_GetPropertyStr(ctx, global, "__stopDone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, done), "stop should complete without error");
    JS_FreeValue(ctx, done);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── setTimezone does not crash ───────────────────────────────────── */

TEST_CASE("native:mikro/sntp setTimezone sets TZ without error", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { setTimezone } from "native:mikro/sntp";
        setTimezone("CET-1CEST,M3.5.0,M10.5.0/3");
        globalThis.__tzDone = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue done = JS_GetPropertyStr(ctx, global, "__tzDone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, done), "setTimezone should complete without error");
    JS_FreeValue(ctx, done);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── sync rejects invalid server array ────────────────────────────── */

TEST_CASE("native:mikro/sntp sync throws on invalid servers argument", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync } from "native:mikro/sntp";
        try {
            sync("not-an-array", "UTC0", false);
            globalThis.__threw = false;
        } catch (e) {
            globalThis.__threw = true;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue threw = JS_GetPropertyStr(ctx, global, "__threw");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, threw), "sync should throw on non-array servers");
    JS_FreeValue(ctx, threw);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── sync throws on empty server array ────────────────────────────── */

TEST_CASE("native:mikro/sntp sync throws on empty servers array", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { sync } from "native:mikro/sntp";
        try {
            sync([], "UTC0", false);
            globalThis.__threw = false;
        } catch (e) {
            globalThis.__threw = true;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue threw = JS_GetPropertyStr(ctx, global, "__threw");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, threw), "sync should throw on empty servers array");
    JS_FreeValue(ctx, threw);
    JS_FreeValue(ctx, global);
    teardown();
}

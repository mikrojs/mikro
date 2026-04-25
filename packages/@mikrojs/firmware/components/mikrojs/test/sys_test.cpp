#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

static MIKRuntime* rt;
static JSContext* ctx;

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

TEST_CASE("native:sys evalScript evaluates global code", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { evalScript } from "native:sys";
        globalThis.__evalResult = evalScript("2 + 2");
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    // evalScript returns a promise (due to JS_EVAL_FLAG_ASYNC), execute jobs
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result = JS_GetPropertyStr(ctx, global, "__evalResult");

    // The result is a Promise, we need to check if it resolved
    // For simple expressions, after executing jobs it should be available
    TEST_ASSERT_FALSE_MESSAGE(JS_IsUndefined(result), "evalScript should produce a result");
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("native:sys memoryUsage returns object with heapTotal and heapUsed", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { memoryUsage } from "native:sys";
        const mem = memoryUsage();
        globalThis.__hasTotal = "heapTotal" in mem;
        globalThis.__hasUsed = "heapUsed" in mem;
        globalThis.__totalIsNum = typeof mem.heapTotal === "number";
        globalThis.__usedIsNum = typeof mem.heapUsed === "number";
        globalThis.__totalGtZero = mem.heapTotal > 0;
        globalThis.__usedGtZero = mem.heapUsed > 0;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__hasTotal");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "memoryUsage should have heapTotal");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasUsed");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "memoryUsage should have heapUsed");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__totalIsNum");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "heapTotal should be a number");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__usedIsNum");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "heapUsed should be a number");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__totalGtZero");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "heapTotal should be > 0");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__usedGtZero");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "heapUsed should be > 0");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("native:sys exports are not uninitialized", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { evalScript, memoryUsage, gc, setTime, uptime, restart } from "native:sys";
        globalThis.__allFunctions =
            typeof evalScript === "function" &&
            typeof memoryUsage === "function" &&
            typeof gc === "function" &&
            typeof setTime === "function" &&
            typeof uptime === "function" &&
            typeof restart === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Importing native:sys should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, "__allFunctions");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v),
                             "All native:sys exports should be functions, not uninitialized");
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("native:sys uptime returns a positive number", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { uptime } from "native:sys";
        const t = uptime();
        globalThis.__isObj = typeof t === "object" && t !== null;
        globalThis.__isPositive = typeof t.boot === "number" && t.boot >= 0;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "uptime() should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__isObj");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "uptime should return an object");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__isPositive");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "uptime().boot should be a positive number");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("native:sys gc does not crash", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { gc } from "native:sys";
        gc();
        globalThis.__gcDone = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "gc() should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue done = JS_GetPropertyStr(ctx, global, "__gcDone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, done), "gc should complete without error");
    JS_FreeValue(ctx, done);
    JS_FreeValue(ctx, global);

    teardown();
}

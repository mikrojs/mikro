#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* native:mikro/udp lives in @mikrojs/native and is initialized eagerly via
 * MIK_NewRuntime — no force-include needed. These tests are smoke-level:
 * verify the module loads and a basic bind/close cycle works. Full
 * roundtrip + multicast tests live host-side (ctest). */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

TEST_CASE("mikro/udp module is importable", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import {bind} from "mikro/udp";
        globalThis.__hasBind = typeof bind === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, "__hasBind");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "bind should be a function");
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, g);

    teardown();
}

TEST_CASE("mikro/udp bind and close work on device", "[modules]") {
    setup();

    /* Drives a bind+close, holds the socket on globalThis to keep it alive
     * past the IIFE, then verifies port assignment and idempotent close. */
    JSValue ret = eval_module(R"(
        import {bind} from "mikro/udp";
        globalThis.__phase = "init";
        (async () => {
          const r = await bind({port: 0, family: 'ipv4'});
          if (!r.ok) {
            globalThis.__phase = "bind-fail:" + r.error.name;
            return;
          }
          globalThis.__sock = r.value;
          globalThis.__port = r.value.port;
          r.value.close();
          r.value.close();
          globalThis.__phase = "done";
        })();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    /* Spin the loop a few times so the IIFE settles. */
    for (int i = 0; i < 10; i++) {
        MIK_Loop(rt);
    }

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue phase = JS_GetPropertyStr(ctx, g, "__phase");
    const char* phase_str = JS_ToCString(ctx, phase);
    TEST_ASSERT_EQUAL_STRING("done", phase_str);
    JS_FreeCString(ctx, phase_str);
    JS_FreeValue(ctx, phase);

    JSValue port_v = JS_GetPropertyStr(ctx, g, "__port");
    int32_t port = -1;
    JS_ToInt32(ctx, &port, port_v);
    TEST_ASSERT_GREATER_THAN(0, port);
    JS_FreeValue(ctx, port_v);

    JS_FreeValue(ctx, g);
    teardown();
}

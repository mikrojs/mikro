#include <cstring>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Virtual modules (MIK_RegisterVirtualModule) replace native:* C modules
 * with JS source compiled on demand — the simulator uses them for every
 * device stub. Critically, they get compiled from INSIDE bytecode
 * deserialization: quickjs-ng resolves a module's imports while
 * JS_ReadObject is still reading it, so loading a builtin like mikro/sys
 * re-enters JS_Eval for the virtual native:mikro/sleep it imports. These tests
 * pin that path; it used to segfault (sim's only coverage was e2e). */

static const char* SLEEP_STUB = R"JS(
export function deepSleep() {}
export function lightSleep() {}
export function getWakeupCause() { return 'undefined' }
export function canWakeFromExt0() { return false }
export function canWakeFromExt1() { return true }
)JS";

TEST_CASE("virtual module shadows a native module inside builtin deserialization" *
          doctest::test_suite("modules")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_RegisterVirtualModule(rt, "native:mikro/sleep", SLEEP_STUB, strlen(SLEEP_STUB));

    /* mikro/sys imports native:mikro/sleep; deserializing its bytecode resolves
     * (and compiles) the virtual module re-entrantly. */
    const char* code = "import {memoryUsage} from 'mikro/sys'\n"
                       "globalThis.__ok = typeof memoryUsage === 'function'\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/main.js", code, strlen(code));
    CHECK(!JS_IsException(ret));
    JS_FreeValue(ctx, ret);
    MIK_Loop(rt);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    CHECK(JS_ToBool(ctx, ok) == 1);
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(rt);
}

TEST_CASE("test runner builtin loads and runs with virtual native modules" *
          doctest::test_suite("modules")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_RegisterVirtualModule(rt, "native:mikro/sleep", SLEEP_STUB, strlen(SLEEP_STUB));
    static const char* HTTP_STUB = "export function pendingCount() { return 0 }\n";
    MIK_RegisterVirtualModule(rt, "native:mikro/http", HTTP_STUB, strlen(HTTP_STUB));

    /* Mirrors what the simulator does per test file: evaluate a module
     * that registers a test through mikro/test (which pulls mikro/sys,
     * native:mikro/sleep, native:mikro/http) and pump until the suite reports. */
    const char* code = "import {assert, describe, test} from 'mikro/test'\n"
                       "describe('smoke', () => {\n"
                       "  test('1+1', () => { assert.equal(1 + 1, 2) })\n"
                       "})\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/test/x.test.js", code, strlen(code));
    CHECK(!JS_IsException(ret));
    JS_FreeValue(ctx, ret);
    for (int i = 0; i < 50; i++) {
        MIK_Loop(rt);
    }
    MIK_FreeRuntime(rt);
}

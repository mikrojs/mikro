/* Shared harness for device tests that drive a mikro module from JS: a fresh
 * runtime per case with TEST_GPIO as a global, module-code evaluation, and
 * results read back as JSON from globalThis.out. */
#pragma once

#include <cstring>
#include <string>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"
#include "utils.h"

#define TEST_GPIO CONFIG_MIKROJS_TEST_GPIO_PIN

namespace js_harness {

inline MIKRuntime* rt;
inline JSContext* ctx;

inline void setup() {
    /* A failed assert jumps past teardown(); free what that test left behind. */
    if (rt) MIK_FreeRuntime(rt);
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "TEST_GPIO", JS_NewInt32(ctx, TEST_GPIO));
    JS_FreeValue(ctx, global);
}

inline void teardown() {
    MIK_FreeRuntime(rt);
    rt = nullptr;
    TEST_ASSERT_NULL_MESSAGE(MIK_GpioOwner(TEST_GPIO), "runtime teardown should release the GPIO");
}

inline void run(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "test.js", code, strlen(code));
    if (JS_IsException(ret)) mik_dump_error(ctx);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "module eval threw");
    mik__execute_jobs(ctx);
    /* A throw while the module runs rejects its promise instead of raising here. */
    bool rejected = JS_PromiseState(ctx, ret) == JS_PROMISE_REJECTED;
    if (rejected) {
        JSValue reason = JS_PromiseResult(ctx, ret);
        mik_dump_error1(ctx, reason);
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, ret);
    TEST_ASSERT_FALSE_MESSAGE(rejected, "module rejected");
}

inline std::string out() {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, "out");
    const char* s = JS_ToCString(ctx, v);
    std::string result = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return result;
}

/* Runs event-loop passes so loop consumers (fades, reads) deliver. */
inline void loop_passes(int n) {
    for (int i = 0; i < n; i++) {
        MIK_Loop(rt);
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

}  // namespace js_harness

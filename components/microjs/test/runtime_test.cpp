#include "error_utils.h"
#include "esp_flash.h"
#include "esp_system.h"
#include "microjs.h"
#include "quickjs.h"
#include "unity.h"

int jsval_as_int32(JSContext* ctx, JSValue val) {
    int32_t num;
    JS_ToInt32(ctx, &num, val);
    JS_FreeValue(ctx, val);
    return num;
}

TEST_CASE("Simple eval works", "[runtime]") {
    const auto rt = UJS_NewRuntime();
    const auto ctx = UJS_GetJSContext(rt);
    const char* code = "2+2";
    const auto result = UJS_EvalGlobalDebug(ctx, "index.js", code, strlen(code));

    TEST_ASSERT_TRUE(JS_IsNumber(result));
    TEST_ASSERT_TRUE(JS_IsEqual(ctx, result, JS_NewNumber(ctx, 4)));

    UJS_FreeRuntime(rt);
}

TEST_CASE("Returns exception upon error", "[runtime]") {
    const auto rt = UJS_NewRuntime();
    const auto ctx = UJS_GetJSContext(rt);

    const char* code = "this.will.fail";

    const auto result = UJS_EvalGlobalDebug(ctx, code, "index.js", strlen(code));
    UJS_EvalGlobalDebug(ctx, "index.js", code, strlen(code));

    TEST_ASSERT_TRUE(JS_IsException(result));
    JS_FreeValue(ctx, result);
    UJS_FreeRuntime(rt);
}

TEST_CASE("Defines setTimeout, clearTimeout, setInterval, clearInterval", "[runtime]") {
    const auto rt = UJS_NewRuntime();
    const auto ctx = UJS_GetJSContext(rt);

    auto const eval = [ctx](const char* code) -> JSValue {
        return UJS_EvalGlobalDebug(ctx, "index.js", code, strlen(code));
    };

    TEST_ASSERT_EQUAL_STRING_MESSAGE("function", JS_ToCString(ctx, eval("typeof setTimeout")),
                                     "Expected setTimeout to be defined");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("function", JS_ToCString(ctx, eval("typeof clearTimeout")),
                                     "Expected clearTimeout to be defined");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("function", JS_ToCString(ctx, eval("typeof setInterval")),
                                     "Expected setInterval to be defined");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("function", JS_ToCString(ctx, eval("typeof clearInterval")),
                                     "Expected clearInterval to be defined");

    UJS_FreeRuntime(rt);
}

TEST_CASE("Does not leak memory when running timers", "[runtime]") {
    const auto rt = UJS_NewRuntime();
    const auto ctx = UJS_GetJSContext(rt);

    const char* code = R"(
    globalThis.ticks = 0;
    const tick = () => {
        globalThis.ticks++
        setTimeout(() => tick(), 0)
     }
    setTimeout(() => tick(), 0)
  )";

    auto const eval = [ctx](const char* code) -> JSValue {
        return UJS_EvalGlobalDebug(ctx, "index.js", code, strlen(code));
    };
    JSValue result = eval(code);

    auto const free_heap_before = esp_get_minimum_free_heap_size();
    for (int i = 0; i < 1000; i++) {
        UJS_Loop(rt);
    }
    auto ticks = jsval_as_int32(ctx, eval("globalThis.ticks"));

    TEST_ASSERT_EQUAL(ticks, 1000);
    TEST_ASSERT_INT_WITHIN(1, free_heap_before, esp_get_minimum_free_heap_size());

    JS_FreeValue(ctx, result);
    UJS_FreeRuntime(rt);
}

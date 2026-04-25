#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

int jsval_as_int32(JSContext* ctx, JSValue val) {
    int32_t num;
    JS_ToInt32(ctx, &num, val);
    JS_FreeValue(ctx, val);
    return num;
}

TEST_CASE("Simple eval works" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);
    const char* code = "2+2";
    const auto result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);

    CHECK(JS_IsNumber(result));
    CHECK(JS_IsEqual(ctx, result, JS_NewNumber(ctx, 4)));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Returns exception upon error" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    const char* code = "this.will.fail";

    const auto result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);

    CHECK(JS_IsException(result));
    JS_FreeValue(ctx, result);
    MIK_FreeRuntime(rt);
}

TEST_CASE("Defines setTimeout, clearTimeout, setInterval, clearInterval" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    auto const eval = [ctx](const char* code) -> JSValue {
        return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    };

    const char* s;
    s = JS_ToCString(ctx, eval("typeof setTimeout"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof clearTimeout"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof setInterval"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = JS_ToCString(ctx, eval("typeof clearInterval"));
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Unhandled rejection calls error handler exactly once" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    int error_count = 0;
    MIK_SetErrorHandler(rt, [](JSContext*, JSValue, void* opaque) {
        (*static_cast<int*>(opaque))++;
    }, &error_count);

    const char* code = "Promise.reject(new Error('test'))";
    JSValue result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, result);

    /* Run the loop — should return 1 (error) and stop */
    int rc = MIK_Loop(rt);

    /* The promise rejection fires during execute_jobs inside MIK_Loop.
     * The error handler must be called exactly once, not twice. */
    CHECK_EQ(1, error_count);
    CHECK_EQ(1, rc);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Does not leak memory when running timers" * doctest::test_suite("runtime")) {
    const auto rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(rt);

    const char* code = R"(
    globalThis.ticks = 0;
    const tick = () => {
        globalThis.ticks++
        setTimeout(() => tick(), 0)
     }
    setTimeout(() => tick(), 0)
  )";

    auto const eval = [ctx](const char* code) -> JSValue {
        return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    };
    JSValue result = eval(code);

    for (int i = 0; i < 1000; i++) {
        MIK_Loop(rt);
    }
    auto ticks = jsval_as_int32(ctx, eval("globalThis.ticks"));

    CHECK_EQ(1000, ticks);

    JS_FreeValue(ctx, result);
    MIK_FreeRuntime(rt);
}

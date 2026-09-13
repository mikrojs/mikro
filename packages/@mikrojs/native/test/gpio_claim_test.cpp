#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

TEST_CASE("GPIO claims are exclusive and report the owner") {
    CHECK(MIK_GpioOwner(5) == nullptr);
    CHECK(MIK_ClaimGpio(5, "DigitalOut"));
    CHECK(std::string(MIK_GpioOwner(5)) == "DigitalOut");

    SUBCASE("a second claim fails and keeps the first owner") {
        CHECK_FALSE(MIK_ClaimGpio(5, "Pwm"));
        CHECK_FALSE(MIK_ClaimGpio(5, "DigitalOut"));
        CHECK(std::string(MIK_GpioOwner(5)) == "DigitalOut");
    }

    SUBCASE("release frees the GPIO for the next owner") {
        MIK_ReleaseGpio(5, "DigitalOut");
        CHECK(MIK_GpioOwner(5) == nullptr);
        CHECK(MIK_ClaimGpio(5, "Pwm"));
        CHECK(std::string(MIK_GpioOwner(5)) == "Pwm");
        MIK_ReleaseGpio(5, "Pwm");
    }

    SUBCASE("a release under another owner leaves the claim alone") {
        MIK_ReleaseGpio(5, "Pwm");
        MIK_ReleaseGpio(5, nullptr);
        CHECK(std::string(MIK_GpioOwner(5)) == "DigitalOut");
    }

    MIK_ReleaseGpio(5, "DigitalOut");
}

TEST_CASE("a NULL owner claims nothing") {
    CHECK_FALSE(MIK_ClaimGpio(6, nullptr));
    CHECK(MIK_GpioOwner(6) == nullptr);
}

TEST_CASE("releasing a free GPIO is a no-op") {
    MIK_ReleaseGpio(7, "Uart");
    MIK_ReleaseGpio(7, "Uart");
    CHECK(MIK_GpioOwner(7) == nullptr);
    CHECK(MIK_ClaimGpio(7, "Uart"));
    MIK_ReleaseGpio(7, "Uart");
}

TEST_CASE("GPIO numbers outside the table are not tracked") {
    CHECK(MIK_ClaimGpio(-1, "Spi"));
    CHECK(MIK_ClaimGpio(-1, "Spi"));
    CHECK(MIK_GpioOwner(-1) == nullptr);
    CHECK(MIK_ClaimGpio(64, "Spi"));
    CHECK(MIK_GpioOwner(64) == nullptr);
    MIK_ReleaseGpio(-1, "Spi");
    MIK_ReleaseGpio(64, "Spi");
}

TEST_CASE("mik__claim_gpios rolls back and reports GpioInUse") {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    REQUIRE(MIK_ClaimGpio(12, "Pwm"));

    const int gpios[] = {10, 11, 12};
    JSValue result = mik__claim_gpios(ctx, gpios, 3, "Spi");
    CHECK(JS_IsObject(result));
    CHECK(MIK_GpioOwner(10) == nullptr);
    CHECK(MIK_GpioOwner(11) == nullptr);
    CHECK(std::string(MIK_GpioOwner(12)) == "Pwm");

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__r", result);
    JS_FreeValue(ctx, global);
    const char* code =
        "JSON.stringify([__r.ok, __r.error.name, __r.error.owner, __r.error.message])";
    JSValue json = JS_Eval(ctx, code, strlen(code), "<test>", JS_EVAL_TYPE_GLOBAL);
    const char* s = JS_ToCString(ctx, json);
    CHECK(std::string(s) == "[false,\"GpioInUse\",\"Pwm\",\"GPIO 12 is already in use by Pwm\"]");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, json);

    CHECK(JS_IsUndefined(mik__claim_gpios(ctx, gpios, 2, "Spi")));
    CHECK(std::string(MIK_GpioOwner(11)) == "Spi");
    mik__release_gpios(gpios, 2, "Spi");
    CHECK(MIK_GpioOwner(11) == nullptr);
    CHECK(std::string(MIK_GpioOwner(12)) == "Pwm");
    MIK_ReleaseGpio(12, "Pwm");
    MIK_FreeRuntime(rt);
}

/* Evaluates `code` and returns the result as a string. */
static std::string eval_string(JSContext* ctx, const char* code) {
    JSValue v = JS_Eval(ctx, code, strlen(code), "<test>", JS_EVAL_TYPE_GLOBAL);
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

TEST_CASE("GpioInUse messages name the console and keep long owner names whole") {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    const char* long_owner = "WaveshareEpaperDisplayWithTouchController75Inch";
    REQUIRE(MIK_ClaimGpio(12, "console"));
    REQUIRE(MIK_ClaimGpio(13, long_owner));

    JSValue global = JS_GetGlobalObject(ctx);
    const int console_gpio[] = {12};
    JS_SetPropertyStr(ctx, global, "__console", mik__claim_gpios(ctx, console_gpio, 1, "Uart"));
    const int long_gpio[] = {13};
    JS_SetPropertyStr(ctx, global, "__long", mik__claim_gpios(ctx, long_gpio, 1, "Uart"));
    JS_FreeValue(ctx, global);

    CHECK(eval_string(ctx, "__console.error.message") ==
          "GPIO 12 is already in use by the console");
    CHECK(eval_string(ctx, "__console.error.owner") == "console");
    CHECK(eval_string(ctx, "__long.error.message") ==
          std::string("GPIO 13 is already in use by ") + long_owner);

    JSValue thrown = mik__throw_gpio_in_use(ctx, 12);
    CHECK(JS_IsException(thrown));
    JSValue exc = JS_GetException(ctx);
    JSValue message = JS_GetPropertyStr(ctx, exc, "message");
    const char* s = JS_ToCString(ctx, message);
    CHECK(std::string(s) == "GPIO 12 is already in use by the console");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, message);
    JS_FreeValue(ctx, exc);

    MIK_ReleaseGpio(12, "console");
    MIK_ReleaseGpio(13, long_owner);
    MIK_FreeRuntime(rt);
}

#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

static MIKRuntime* rt;
static JSContext* ctx;

static JSValue eval(const char* code) {
    return JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
}

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

/* Eval `code`, inspect the result, and return the rendered string.
 * The eval itself must not throw. */
static std::string inspect_eval(const char* code) {
    JSValue v = eval(code);
    REQUIRE_MESSAGE(!JS_IsException(v), "test eval should not throw");
    std::string out = mik_inspect(ctx, v, 2, false, false);
    JS_FreeValue(ctx, v);
    return out;
}

TEST_CASE("throwing getter renders placeholder, other keys intact" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({ok: 1, get boom() { throw new Error('nope') }, also: 'yes'})
    )");
    CHECK(out.find("boom: [getter threw]") != std::string::npos);
    CHECK(out.find("ok: 1") != std::string::npos);
    CHECK(out.find("also: 'yes'") != std::string::npos);
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("throwing Symbol.toStringTag getter leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({a: 1, get [Symbol.toStringTag]() { throw new Error('tag') }})
    )");
    CHECK(out.find("a: 1") != std::string::npos);
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("throwing custom inspect hook falls back, no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({x: 42, [Symbol.for('mikrojs.inspect')]() { throw new Error('hook') }})
    )");
    CHECK(out.find("x: 42") != std::string::npos);
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("proxy with throwing get trap renders placeholder per key" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        new Proxy({a: 1}, {get() { throw new Error('trap') }})
    )");
    CHECK(out.find("a: [getter threw]") != std::string::npos);
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("proxy with throwing ownKeys trap leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        new Proxy({a: 1}, {ownKeys() { throw new Error('keys') }})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("array proxy with throwing get trap leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        new Proxy([1, 2], {get() { throw new Error('len') }})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("fake Map with throwing size getter leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({[Symbol.toStringTag]: 'Map', get size() { throw new Error('size') }})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("fake Date with throwing toJSON leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({[Symbol.toStringTag]: 'Date', toJSON() { throw new Error('json') }})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("Error-tagged object with throwing name getter leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({[Symbol.toStringTag]: 'Error', get name() { throw new Error('n') },
          get message() { throw new Error('m') }})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("Uint8Array-tagged plain object leaves no pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({[Symbol.toStringTag]: 'Uint8Array'})
    )");
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

TEST_CASE("nested throwing getter renders placeholder without pending exception" *
          doctest::test_suite("inspect_getter")) {
    setup();
    std::string out = inspect_eval(R"(
        ({outer: {get inner() { throw new Error('deep') }}, tail: true})
    )");
    CHECK(out.find("inner: [getter threw]") != std::string::npos);
    CHECK(out.find("tail: true") != std::string::npos);
    CHECK_FALSE(JS_HasException(ctx));
    teardown();
}

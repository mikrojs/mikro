#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Regression tests for inspect_symbol: ToString throws on symbols, so the
 * old JS_ToCString path lost descriptions and left a TypeError pending. */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static std::string inspect_global(const char* name) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    std::string out = mik_inspect(ctx, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return out;
}

static bool contains(const std::string& hay, const char* needle) {
    return hay.find(needle) != std::string::npos;
}

TEST_CASE("inspect renders symbol descriptions" * doctest::test_suite("inspect")) {
    setup();
    const char* code =
        "globalThis.__sym = Symbol('tag');"
        "globalThis.__bare = Symbol();"
        "globalThis.__obj = {key: Symbol('nested')};"
        "globalThis.__map = new Map([[Symbol('mk'), 1]]);";
    JSValue r = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    REQUIRE(!JS_IsException(r));
    JS_FreeValue(ctx, r);

    CHECK_EQ(inspect_global("__sym"), std::string("Symbol(tag)"));
    CHECK_EQ(inspect_global("__bare"), std::string("Symbol()"));
    CHECK(contains(inspect_global("__obj"), "key: Symbol(nested)"));
    CHECK(contains(inspect_global("__map"), "Symbol(mk) => 1"));
    teardown();
}

TEST_CASE("inspecting a symbol leaves no pending exception" * doctest::test_suite("inspect")) {
    setup();
    const char* code = "globalThis.__sym = Symbol('tag');";
    JSValue r = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    REQUIRE(!JS_IsException(r));
    JS_FreeValue(ctx, r);

    inspect_global("__sym");
    CHECK_FALSE(JS_HasException(ctx)); /* failed ToString must not leave a pending TypeError */
    teardown();
}

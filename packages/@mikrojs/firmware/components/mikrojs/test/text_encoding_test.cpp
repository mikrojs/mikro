#include "mikrojs.h"
#include "quickjs.h"
#include "unity.h"

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

TEST_CASE("TextEncoder is a constructor", "[runtime]") {
    setup();

    JSValue r = eval("typeof TextEncoder");
    const char* type = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("function", type);
    JS_FreeCString(ctx, type);
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("TextDecoder is a constructor", "[runtime]") {
    setup();

    JSValue r = eval("typeof TextDecoder");
    const char* type = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("function", type);
    JS_FreeCString(ctx, type);
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("TextEncoder.encode produces Uint8Array with correct bytes", "[runtime]") {
    setup();

    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const arr = enc.encode("hello");
        globalThis.__len = arr.length;
        globalThis.__b0 = arr[0];
        globalThis.__b4 = arr[4];
        arr instanceof Uint8Array;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "encode should not throw");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, r), "Result should be a Uint8Array");
    JS_FreeValue(ctx, r);

    int32_t len, b0, b4;
    JSValue v;

    v = eval("globalThis.__len");
    JS_ToInt32(ctx, &len, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32(5, len);

    v = eval("globalThis.__b0");
    JS_ToInt32(ctx, &b0, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32('h', b0);

    v = eval("globalThis.__b4");
    JS_ToInt32(ctx, &b4, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32('o', b4);

    teardown();
}

TEST_CASE("TextDecoder.decode converts Uint8Array to string", "[runtime]") {
    setup();

    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const arr = new Uint8Array([72, 101, 108, 108, 111]);
        dec.decode(arr);
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "decode should not throw");
    const char* str = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("Hello", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("TextEncoder/TextDecoder roundtrip", "[runtime]") {
    setup();

    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        dec.decode(enc.encode("mikrojs rocks"));
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "roundtrip should not throw");
    const char* str = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("mikrojs rocks", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);

    teardown();
}

TEST_CASE("TextDecoder.decode rejects non-Uint8Array", "[runtime]") {
    setup();

    JSValue r = eval(R"(
        try {
            const dec = new TextDecoder();
            dec.decode("not a typed array");
            false;
        } catch (e) {
            e instanceof TypeError;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "Should not throw at top level");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, r), "Should have caught a TypeError");
    JS_FreeValue(ctx, r);

    teardown();
}

/* ---- btoa / atob ---- */

TEST_CASE("btoa encodes ASCII string", "[runtime]") {
    setup();
    JSValue r = eval("btoa('Hello')");
    const char* str = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("SGVsbG8=", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob decodes base64 string", "[runtime]") {
    setup();
    JSValue r = eval("atob('SGVsbG8=')");
    const char* str = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("Hello", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa/atob roundtrip", "[runtime]") {
    setup();
    JSValue r = eval("atob(btoa('mikrojs'))");
    const char* str = JS_ToCString(ctx, r);
    TEST_ASSERT_EQUAL_STRING("mikrojs", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa handles padding correctly", "[runtime]") {
    setup();
    JSValue r1 = eval("btoa('a')");
    const char* s1 = JS_ToCString(ctx, r1);
    TEST_ASSERT_EQUAL_STRING("YQ==", s1);
    JS_FreeCString(ctx, s1);
    JS_FreeValue(ctx, r1);

    JSValue r2 = eval("btoa('ab')");
    const char* s2 = JS_ToCString(ctx, r2);
    TEST_ASSERT_EQUAL_STRING("YWI=", s2);
    JS_FreeCString(ctx, s2);
    JS_FreeValue(ctx, r2);
    teardown();
}

TEST_CASE("atob throws on invalid input", "[runtime]") {
    setup();
    JSValue r = eval(R"(
        try { atob('!!!'); false; }
        catch (e) { e instanceof SyntaxError; }
    )");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, r), "Should throw SyntaxError on invalid base64");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextEncoder.encode handles multibyte UTF-8", "[runtime]") {
    setup();

    // "é" is 2 bytes in UTF-8 (0xC3, 0xA9)
    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const arr = enc.encode("\u00e9");
        globalThis.__mbLen = arr.length;
        globalThis.__mb0 = arr[0];
        globalThis.__mb1 = arr[1];
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(r), "encode multibyte should not throw");
    JS_FreeValue(ctx, r);

    int32_t len, b0, b1;
    JSValue v;

    v = eval("globalThis.__mbLen");
    JS_ToInt32(ctx, &len, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32(2, len);

    v = eval("globalThis.__mb0");
    JS_ToInt32(ctx, &b0, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32(0xC3, b0);

    v = eval("globalThis.__mb1");
    JS_ToInt32(ctx, &b1, v);
    JS_FreeValue(ctx, v);
    TEST_ASSERT_EQUAL_INT32(0xA9, b1);

    teardown();
}

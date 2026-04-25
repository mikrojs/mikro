#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
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

TEST_CASE("TextEncoder is a constructor" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("typeof TextEncoder");
    const char* type = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("function"), std::string(type));
    JS_FreeCString(ctx, type);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder is a constructor" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("typeof TextDecoder");
    const char* type = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("function"), std::string(type));
    JS_FreeCString(ctx, type);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextEncoder.encode produces Uint8Array with correct bytes" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const arr = enc.encode("hello");
        globalThis.__len = arr.length;
        globalThis.__b0 = arr[0];
        globalThis.__b4 = arr[4];
        arr instanceof Uint8Array;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "encode should not throw");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "Result should be a Uint8Array");
    JS_FreeValue(ctx, r);

    int32_t len, b0, b4;
    JSValue v;
    v = eval("globalThis.__len"); JS_ToInt32(ctx, &len, v); JS_FreeValue(ctx, v);
    CHECK_EQ(5, len);
    v = eval("globalThis.__b0"); JS_ToInt32(ctx, &b0, v); JS_FreeValue(ctx, v);
    CHECK_EQ((int32_t)'h', b0);
    v = eval("globalThis.__b4"); JS_ToInt32(ctx, &b4, v); JS_FreeValue(ctx, v);
    CHECK_EQ((int32_t)'o', b4);
    teardown();
}

TEST_CASE("TextDecoder.decode converts Uint8Array to string" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const arr = new Uint8Array([72, 101, 108, 108, 111]);
        dec.decode(arr);
    )");
    CHECK_MESSAGE(!JS_IsException(r), "decode should not throw");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("Hello"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextEncoder/TextDecoder roundtrip" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        dec.decode(enc.encode("mikrojs rocks"));
    )");
    CHECK_MESSAGE(!JS_IsException(r), "roundtrip should not throw");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("mikrojs rocks"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder.decode rejects non-Uint8Array" * doctest::test_suite("text_encoding")) {
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
    CHECK_MESSAGE(!JS_IsException(r), "Should not throw at top level");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "Should have caught a TypeError");
    JS_FreeValue(ctx, r);
    teardown();
}

/* ---- btoa / atob ---- */

TEST_CASE("btoa encodes ASCII string" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("btoa('Hello')");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("SGVsbG8="), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob decodes base64 string" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("atob('SGVsbG8=')");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("Hello"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa/atob roundtrip" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("atob(btoa('mikrojs'))");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("mikrojs"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa handles empty string" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("btoa('')");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string(""), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob handles empty string" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("atob('')");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string(""), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa handles padding correctly" * doctest::test_suite("text_encoding")) {
    setup();
    // 1 byte -> 4 chars with == padding
    JSValue r1 = eval("btoa('a')");
    const char* s1 = JS_ToCString(ctx, r1);
    CHECK_EQ(std::string("YQ=="), std::string(s1));
    JS_FreeCString(ctx, s1);
    JS_FreeValue(ctx, r1);

    // 2 bytes -> 4 chars with = padding
    JSValue r2 = eval("btoa('ab')");
    const char* s2 = JS_ToCString(ctx, r2);
    CHECK_EQ(std::string("YWI="), std::string(s2));
    JS_FreeCString(ctx, s2);
    JS_FreeValue(ctx, r2);

    // 3 bytes -> 4 chars, no padding
    JSValue r3 = eval("btoa('abc')");
    const char* s3 = JS_ToCString(ctx, r3);
    CHECK_EQ(std::string("YWJj"), std::string(s3));
    JS_FreeCString(ctx, s3);
    JS_FreeValue(ctx, r3);
    teardown();
}

TEST_CASE("atob ignores whitespace" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("atob('SGVs bG8=')");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("Hello"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob throws on invalid input" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        try { atob('!!!'); false; }
        catch (e) { e instanceof SyntaxError; }
    )");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "Should throw SyntaxError on invalid base64");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("btoa handles binary data (latin1 range)" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval("btoa(String.fromCharCode(0, 128, 255))");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("AID/"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder: utf-8 label accepted" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        new TextDecoder('utf-8');
        new TextDecoder('utf8');
        new TextDecoder('UTF-8');
        true;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "utf-8 labels should be accepted");
    CHECK(JS_ToBool(ctx, r));
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder: unsupported label throws RangeError" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        try { new TextDecoder('utf-16le'); false; }
        catch (e) { e instanceof RangeError; }
    )");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "unsupported label should throw RangeError");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder streaming: multibyte split across chunks" * doctest::test_suite("text_encoding")) {
    setup();
    /* "café" UTF-8 = 63 61 66 C3 A9. Split inside the 'é'. */
    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const a = dec.decode(new Uint8Array([0x63, 0x61, 0x66, 0xC3]), {stream: true});
        const b = dec.decode(new Uint8Array([0xA9]), {stream: true});
        a + b;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "streaming decode should not throw");
    const char* str = JS_ToCString(ctx, r);
    CHECK_EQ(std::string("caf\xC3\xA9"), std::string(str));
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder streaming: invalid byte emits U+FFFD" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const s = dec.decode(new Uint8Array([0x41, 0xFF, 0x42]));
        /* "A" + U+FFFD + "B" */
        s.length === 3 && s.charCodeAt(0) === 0x41 && s.charCodeAt(1) === 0xFFFD && s.charCodeAt(2) === 0x42;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "decode should not throw");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "invalid byte should become U+FFFD");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder streaming: final flush emits U+FFFD for held bytes" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const a = dec.decode(new Uint8Array([0xC3]), {stream: true});
        const b = dec.decode();
        /* a empty, b is a single U+FFFD */
        a.length === 0 && b.length === 1 && b.charCodeAt(0) === 0xFFFD;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "flush should not throw");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "final flush should emit U+FFFD");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextDecoder: non-stream incomplete emits U+FFFD immediately" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const dec = new TextDecoder();
        const s = dec.decode(new Uint8Array([0x41, 0xC3]));
        s.length === 2 && s.charCodeAt(0) === 0x41 && s.charCodeAt(1) === 0xFFFD;
    )");
    CHECK_MESSAGE(!JS_IsException(r), "decode should not throw");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "non-stream trailing incomplete should emit U+FFFD");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("TextEncoder.encode handles multibyte UTF-8" * doctest::test_suite("text_encoding")) {
    setup();
    JSValue r = eval(R"(
        const enc = new TextEncoder();
        const arr = enc.encode("\u00e9");
        globalThis.__mbLen = arr.length;
        globalThis.__mb0 = arr[0];
        globalThis.__mb1 = arr[1];
    )");
    CHECK_MESSAGE(!JS_IsException(r), "encode multibyte should not throw");
    JS_FreeValue(ctx, r);

    int32_t len, b0, b1;
    JSValue v;
    v = eval("globalThis.__mbLen"); JS_ToInt32(ctx, &len, v); JS_FreeValue(ctx, v);
    CHECK_EQ(2, len);
    v = eval("globalThis.__mb0"); JS_ToInt32(ctx, &b0, v); JS_FreeValue(ctx, v);
    CHECK_EQ(0xC3, b0);
    v = eval("globalThis.__mb1"); JS_ToInt32(ctx, &b1, v); JS_FreeValue(ctx, v);
    CHECK_EQ(0xA9, b1);
    teardown();
}

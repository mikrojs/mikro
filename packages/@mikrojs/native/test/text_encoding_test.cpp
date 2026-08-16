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

TEST_CASE("btoa coerces non-string arguments" * doctest::test_suite("text_encoding")) {
    setup();
    /* Per spec the argument is run through ToString before encoding. */
    JSValue r = eval(R"(
        btoa(123) === 'MTIz' &&
        btoa(null) === 'bnVsbA==' &&
        btoa(true) === 'dHJ1ZQ=='
    )");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "btoa should ToString-coerce its argument");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob rejects malformed padding" * doctest::test_suite("text_encoding")) {
    setup();
    /* WHATWG forgiving-base64 rejects bad length/padding: length % 4 == 1, a
     * stray '=', or '=' when the length is not a multiple of 4. */
    JSValue r = eval(R"(
        const bad = ['Zg=', 'Z', '=', 'Zm9v=', 'Zm9v==', '====', 'Zm==='];
        bad.every(s => {
            try { atob(s); return false; }
            catch (e) { return e instanceof SyntaxError; }
        });
    )");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "atob should reject malformed padding with SyntaxError");
    JS_FreeValue(ctx, r);
    teardown();
}

TEST_CASE("atob accepts valid unpadded base64" * doctest::test_suite("text_encoding")) {
    setup();
    /* Missing padding is allowed when the length is not 1 (mod 4). */
    JSValue r = eval(R"(
        atob('Zg') === 'f' && atob('Zm8') === 'fo' && atob('Zm9vYg') === 'foob'
    )");
    CHECK_MESSAGE(JS_ToBool(ctx, r), "atob should accept valid unpadded base64");
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

/* ── Edge coverage: streaming decode, invalid UTF-8, btoa/atob ───── */

static void te_run(const char* src) {
    JSValue rv = eval(src);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[te eval] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, exc);
        FAIL("eval threw");
    }
    JS_FreeValue(ctx, rv);
}

static std::string te_global(const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

TEST_CASE("decoder labels and argument validation" * doctest::test_suite("text_encoding")) {
    setup();
    te_run("const attempt = (fn) => { try { fn(); return 'ok' } catch (e) { return e.name } }\n"
           "globalThis.__utf8 = attempt(() => new TextDecoder('utf-8'))\n"
           "globalThis.__upper = attempt(() => new TextDecoder('UTF-8'))\n"
           "globalThis.__latin = attempt(() => new TextDecoder('latin1'))\n"
           "globalThis.__noArg = attempt(() => new TextDecoder())\n"
           "globalThis.__badData = attempt(() => new TextDecoder().decode('str'))\n");
    CHECK(te_global("__utf8") == "ok");
    CHECK(te_global("__upper") == "ok");
    CHECK(te_global("__latin") == "RangeError");
    CHECK(te_global("__noArg") == "ok");
    CHECK(te_global("__badData") == "TypeError");
    teardown();
}

TEST_CASE("streaming decode splits multi-byte sequences" * doctest::test_suite("text_encoding")) {
    setup();
    te_run("const dec = new TextDecoder()\n"
           /* 'é' = C3 A9, split across chunks; '✓' = E2 9C 93, split 1+2 */
           "let out = dec.decode(new Uint8Array([104, 0xC3]), {stream: true})\n"
           "out += dec.decode(new Uint8Array([0xA9, 0xE2]), {stream: true})\n"
           "out += dec.decode(new Uint8Array([0x9C, 0x93]), {stream: true})\n"
           "out += dec.decode()\n" /* flush */
           "globalThis.__streamed = out\n"
           /* a lone lead byte pending at final flush becomes U+FFFD */
           "const dec2 = new TextDecoder()\n"
           "let out2 = dec2.decode(new Uint8Array([0xC3]), {stream: true})\n"
           "out2 += dec2.decode()\n"
           "globalThis.__pendingFlush = out2\n");
    CHECK(te_global("__streamed") == "hé✓");
    CHECK(te_global("__pendingFlush") == "�");
    teardown();
}

TEST_CASE("invalid UTF-8 becomes replacement characters" * doctest::test_suite("text_encoding")) {
    setup();
    te_run("const d = (bytes) => new TextDecoder().decode(new Uint8Array(bytes))\n"
           "globalThis.__cont = d([0x80, 65])\n"           /* stray continuation */
           "globalThis.__overlong2 = d([0xC0, 0xAF])\n"    /* overlong 2-byte */
           "globalThis.__overlong3 = d([0xE0, 0x80, 0xAF])\n"
           "globalThis.__surrogate = d([0xED, 0xA0, 0x80])\n"
           "globalThis.__tooBig = d([0xF4, 0x90, 0x80, 0x80])\n"
           "globalThis.__badLead = d([0xFF, 66])\n"
           "globalThis.__truncated = d([0xE2, 0x9C])\n"    /* incomplete at end */
           "globalThis.__valid4 = d([0xF0, 0x9F, 0x98, 0x80])\n" /* 😀 */);
    CHECK(te_global("__cont") == "�A");
    CHECK(te_global("__overlong2").find("�") == 0);
    CHECK(te_global("__overlong3").find("�") == 0);
    CHECK(te_global("__surrogate").find("�") == 0);
    CHECK(te_global("__tooBig").find("�") == 0);
    CHECK(te_global("__badLead") == "�B");
    CHECK(te_global("__truncated") == "��"); /* one U+FFFD per consumed byte */
    CHECK(te_global("__valid4") == "😀");
    teardown();
}

TEST_CASE("btoa and atob round-trip and reject bad input" * doctest::test_suite("text_encoding")) {
    setup();
    te_run("const attempt = (fn) => { try { return fn() } catch (e) { return e.name } }\n"
           "globalThis.__b64 = btoa('hello')\n"
           "globalThis.__back = atob(btoa('hello'))\n"
           "globalThis.__emptyB = btoa('')\n"
           "globalThis.__emptyA = atob('')\n"
           /* embedded NUL survives; compare via char codes (C strings truncate) */
           "globalThis.__latin1 = atob(btoa('\\xff\\x00\\x7f')).split('')"
           ".map((c) => c.charCodeAt(0)).join(',')\n"
           "globalThis.__nonLatin = attempt(() => btoa('smile 😀'))\n"
           "globalThis.__badB64 = attempt(() => atob('!!!not-base64!!!'))\n"
           "globalThis.__oddLen = attempt(() => atob('abcde'))\n");
    CHECK(te_global("__b64") == "aGVsbG8=");
    CHECK(te_global("__back") == "hello");
    CHECK(te_global("__emptyB") == "");
    CHECK(te_global("__emptyA") == "");
    CHECK(te_global("__latin1") == "255,0,127");
    CHECK(te_global("__nonLatin") == "RangeError");
    CHECK(te_global("__badB64") == "SyntaxError");
    CHECK(te_global("__oddLen") == "SyntaxError");
    teardown();
}

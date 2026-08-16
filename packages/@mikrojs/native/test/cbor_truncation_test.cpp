#include <cstdio>
#include <cstring>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Regression tests for truncated CBOR input: a definite-length container cut
 * short at an element boundary must decode as a DecodeFailed Result, not as a
 * success with the tail silently dropped. */

namespace {

struct CborTruncFixture {
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    CborTruncFixture() {
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~CborTruncFixture() { MIK_FreeRuntime(rt); }
};

static void run(JSContext* ctx, const char* src) {
    JSValue rv = JS_Eval(ctx, src, strlen(src), "mikro/test-cbor-trunc-driver",
                         JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[cbor_trunc run] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, exc);
    }
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[cbor_trunc run] rejected: %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, rv);
    REQUIRE(state == JS_PROMISE_FULFILLED);
}

static int read_global_int(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    int32_t i = -1;
    JS_ToInt32(ctx, &i, v);
    JS_FreeValue(ctx, v);
    return i;
}

}  // namespace

TEST_CASE_FIXTURE(CborTruncFixture,
                  "every strict prefix of an encoded payload fails to decode" *
                      doctest::test_suite("cbor")) {
    /* Nested array plus several map keys, so cuts land on element boundaries
     * at every container level. Every strict prefix must yield DecodeFailed. */
    run(ctx,
        "import {encode, decode} from 'mikro/cbor'\n"
        "const payload = {device: 'sensor-7', interval: 60,\n"
        "                 channels: ['main', 'beta'], nested: [1, [2, 3], 'x']}\n"
        "const bytes = encode(payload).value\n"
        "let okAt = -1\n"
        "let badErrAt = -1\n"
        "for (let n = 0; n < bytes.length; n++) {\n"
        "  const r = decode(bytes.slice(0, n))\n"
        "  if (r.ok) { if (okAt < 0) okAt = n; continue }\n"
        "  if (r.error.name !== 'DecodeFailed' && badErrAt < 0) badErrAt = n\n"
        "}\n"
        "globalThis.__len = bytes.length\n"
        "globalThis.__okAt = okAt\n"
        "globalThis.__badErrAt = badErrAt\n");
    CHECK(read_global_int(ctx, "__len") > 0);
    CHECK_MESSAGE(read_global_int(ctx, "__okAt") == -1,
                  "prefix of length " << read_global_int(ctx, "__okAt")
                                      << " decoded ok instead of failing");
    CHECK_MESSAGE(read_global_int(ctx, "__badErrAt") == -1,
                  "prefix of length " << read_global_int(ctx, "__badErrAt")
                                      << " failed with an error other than DecodeFailed");
}

TEST_CASE_FIXTURE(CborTruncFixture,
                  "full payload and empty containers still decode ok" *
                      doctest::test_suite("cbor")) {
    run(ctx,
        "import {encode, decode} from 'mikro/cbor'\n"
        "const payload = {device: 'sensor-7', interval: 60, channels: ['main', 'beta']}\n"
        "const full = decode(encode(payload).value)\n"
        "globalThis.__fullOk = full.ok && full.value.channels.length === 2 ? 1 : 0\n"
        "const arr = decode(encode([]).value)\n"
        "globalThis.__emptyArrOk = arr.ok && arr.value.length === 0 ? 1 : 0\n"
        "const map = decode(encode({}).value)\n"
        "globalThis.__emptyMapOk = map.ok && Object.keys(map.value).length === 0 ? 1 : 0\n");
    CHECK_EQ(1, read_global_int(ctx, "__fullOk"));
    CHECK_EQ(1, read_global_int(ctx, "__emptyArrOk"));
    CHECK_EQ(1, read_global_int(ctx, "__emptyMapOk"));
}

TEST_CASE_FIXTURE(CborTruncFixture,
                  "boundary-cut containers fail with DecodeFailed" *
                      doctest::test_suite("cbor")) {
    run(ctx,
        "import {decode} from 'mikro/cbor'\n"
        "const failsDecode = (bytes) => {\n"
        "  const r = decode(new Uint8Array(bytes))\n"
        "  return !r.ok && r.error.name === 'DecodeFailed' ? 1 : 0\n"
        "}\n"
        "/* array(2) with only one element present */\n"
        "globalThis.__arrCut = failsDecode([0x82, 0x01])\n"
        "/* map(1) 'a' -> array(2) with only one element present */\n"
        "globalThis.__mapCut = failsDecode([0xA1, 0x61, 0x61, 0x82, 0x01])\n");
    CHECK_EQ(1, read_global_int(ctx, "__arrCut"));
    CHECK_EQ(1, read_global_int(ctx, "__mapCut"));
}

TEST_CASE_FIXTURE(CborTruncFixture,
                  "strings truncated at the buffer tail fail with DecodeFailed" *
                      doctest::test_suite("cbor")) {
    run(ctx,
        "import {decode} from 'mikro/cbor'\n"
        "const failsDecode = (bytes) => {\n"
        "  const r = decode(new Uint8Array(bytes))\n"
        "  return !r.ok && r.error.name === 'DecodeFailed' ? 1 : 0\n"
        "}\n"
        "/* tstr(5) with only 4 payload bytes after the header */\n"
        "globalThis.__tstrCut = failsDecode([0x65, 0x61, 0x62, 0x63, 0x64])\n"
        "/* bstr(5) with only 4 payload bytes after the header */\n"
        "globalThis.__bstrCut = failsDecode([0x45, 0x01, 0x02, 0x03, 0x04])\n"
        "/* map(1) whose key is a truncated tstr */\n"
        "globalThis.__keyCut = failsDecode([0xA1, 0x65, 0x61, 0x62, 0x63, 0x64])\n");
    CHECK_EQ(1, read_global_int(ctx, "__tstrCut"));
    CHECK_EQ(1, read_global_int(ctx, "__bstrCut"));
    CHECK_EQ(1, read_global_int(ctx, "__keyCut"));
}

TEST_CASE_FIXTURE(CborTruncFixture,
                  "indefinite-length containers: break byte required, not spurious" *
                      doctest::test_suite("cbor")) {
    run(ctx,
        "import {decode} from 'mikro/cbor'\n"
        "/* indefinite array 0x9F 1 2 break: complete, must decode ok */\n"
        "const ok = decode(new Uint8Array([0x9F, 0x01, 0x02, 0xFF]))\n"
        "globalThis.__indefOk =\n"
        "  ok.ok && ok.value.length === 2 && ok.value[0] === 1 && ok.value[1] === 2 ? 1 : 0\n"
        "/* same array truncated before the break byte: must fail */\n"
        "const cut = decode(new Uint8Array([0x9F, 0x01, 0x02]))\n"
        "globalThis.__indefCut = !cut.ok && cut.error.name === 'DecodeFailed' ? 1 : 0\n"
        "/* indefinite map 0xBF 'a' 1 with no break byte: must fail too */\n"
        "const mapCut = decode(new Uint8Array([0xBF, 0x61, 0x61, 0x01]))\n"
        "globalThis.__indefMapCut = !mapCut.ok && mapCut.error.name === 'DecodeFailed' ? 1 : 0\n");
    CHECK_EQ(1, read_global_int(ctx, "__indefOk"));
    CHECK_EQ(1, read_global_int(ctx, "__indefCut"));
    CHECK_EQ(1, read_global_int(ctx, "__indefMapCut"));
}

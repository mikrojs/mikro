#include <cstdio>
#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for the CBOR JS binding (mik_cbor.cpp) via mikro/cbor.
 * cbor_test.cpp covers the nanocbor layer; this exercises the JS value
 * conversion in both directions, including malformed-input errors. */

namespace {

struct CborFixture {
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    CborFixture() {
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~CborFixture() { MIK_FreeRuntime(rt); }
};

static void run(JSContext* ctx, const char* src) {
    std::string code = src;
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-cbor-driver",
                         JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[cbor run] rejected: %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, rv);
    REQUIRE(state == JS_PROMISE_FULFILLED);
}

static std::string read_global_string(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

static bool read_global_bool(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    bool b = JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return b;
}

/* encode/decode return Results; rt(v) → JSON of the round-tripped value */
static const char* PRELUDE =
    "import {encode, decode} from 'mikro/cbor'\n"
    "const rt = (v) => JSON.stringify(decode(encode(v).value).value)\n";

}  // namespace

TEST_CASE_FIXTURE(CborFixture, "integers round-trip across encoding widths" *
                                   doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              /* CBOR switches encodings at 24, 256, 65536, 2^32 */
              "const ints = [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295,\n"
              "              2 ** 40, -1, -24, -25, -256, -257, -65537, -(2 ** 40)]\n"
              "globalThis.__ints = JSON.stringify(ints.map((i) => decode(encode(i).value).value))\n"
              "globalThis.__same = JSON.stringify(ints) === globalThis.__ints\n")
                 .c_str());
    CHECK(read_global_bool(ctx, "__same"));
}

TEST_CASE_FIXTURE(CborFixture, "floats, booleans, and null round-trip" *
                                   doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__f = rt(1.5)\n"
              "globalThis.__negf = rt(-0.25)\n"
              "globalThis.__t = rt(true)\n"
              "globalThis.__fl = rt(false)\n"
              "globalThis.__n = rt(null)\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__f") == "1.5");
    CHECK(read_global_string(ctx, "__negf") == "-0.25");
    CHECK(read_global_string(ctx, "__t") == "true");
    CHECK(read_global_string(ctx, "__fl") == "false");
    CHECK(read_global_string(ctx, "__n") == "null");
}

TEST_CASE_FIXTURE(CborFixture, "strings, arrays, and objects round-trip" *
                                   doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__s = rt('hello')\n"
              "globalThis.__empty = rt('')\n"
              "globalThis.__uni = rt('héllo ✓')\n"
              "globalThis.__arr = rt([1, 'two', [3, [4]]])\n"
              "globalThis.__emptyArr = rt([])\n"
              "globalThis.__obj = rt({a: 1, b: {c: 'deep'}, d: [true]})\n"
              "globalThis.__emptyObj = rt({})\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__s") == "\"hello\"");
    CHECK(read_global_string(ctx, "__empty") == "\"\"");
    CHECK(read_global_string(ctx, "__uni") == "\"héllo ✓\"");
    CHECK(read_global_string(ctx, "__arr") == "[1,\"two\",[3,[4]]]");
    CHECK(read_global_string(ctx, "__emptyArr") == "[]");
    CHECK(read_global_string(ctx, "__obj") == "{\"a\":1,\"b\":{\"c\":\"deep\"},\"d\":[true]}");
    CHECK(read_global_string(ctx, "__emptyObj") == "{}");
}

TEST_CASE_FIXTURE(CborFixture, "byte strings round-trip as Uint8Array" *
                                   doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              "const bytes = decode(encode(new Uint8Array([0, 127, 255])).value).value\n"
              "globalThis.__isU8 = bytes instanceof Uint8Array\n"
              "globalThis.__bytes = Array.from(bytes).join(',')\n")
                 .c_str());
    CHECK(read_global_bool(ctx, "__isU8"));
    CHECK(read_global_string(ctx, "__bytes") == "0,127,255");
}

TEST_CASE_FIXTURE(CborFixture, "wire edge cases: tags, undefined, bad keys, truncation" *
                                   doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              "const name = (r) => r.ok ? 'ok' : r.error.name\n"
              "const d = (bytes) => decode(new Uint8Array(bytes))\n"
              /* tag 1 wrapping the int 5: tags are stripped */
              "globalThis.__tagged = String(d([0xC1, 0x05]).value)\n"
              /* nested tag on a map value */
              "globalThis.__tagMap = JSON.stringify(d([0xA1, 0x61, 0x61, 0xC0, 0x02]).value)\n"
              "globalThis.__undef = String(d([0xF7]).value)\n"
              /* integer-keyed map is rejected, not coerced */
              "globalThis.__intKey = name(d([0xA1, 0x01, 0x02]))\n"
              /* truncated definite-length containers are rejected */
              "globalThis.__shortArr = name(d([0x82, 0x01]))\n"
              "globalThis.__shortNested = name(d([0xA1, 0x61, 0x61, 0x82, 0x01]))\n"
              /* nesting deeper than MIK_CBOR_MAX_DEPTH (32) is refused */
              "const deep = new Uint8Array(40); deep.fill(0x81); deep[39] = 0x01\n"
              "globalThis.__deep = name(decode(deep))\n"
              /* encode side of the same guard */
              "let v = 1; for (let i = 0; i < 40; i++) v = [v]\n"
              "globalThis.__deepEncode = name(encode(v))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__tagged") == "5");
    CHECK(read_global_string(ctx, "__tagMap") == "{\"a\":2}");
    CHECK(read_global_string(ctx, "__undef") == "undefined");
    CHECK(read_global_string(ctx, "__intKey") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__shortArr") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__shortNested") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__deep") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__deepEncode") == "EncodeFailed");
}

TEST_CASE_FIXTURE(CborFixture, "bad input yields Result errors" * doctest::test_suite("cbor")) {
    run(ctx, (std::string(PRELUDE) +
              "const name = (r) => r.ok ? 'ok' : r.error.name\n"
              "globalThis.__notBytes = name(decode('a string'))\n"
              "globalThis.__truncated = name(decode(encode({a: 1}).value.slice(0, 2)))\n"
              "globalThis.__emptyBuf = name(decode(new Uint8Array(0)))\n"
              "globalThis.__badEncode = name(encode(() => {}))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__notBytes") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__truncated") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__emptyBuf") == "DecodeFailed");
    CHECK(read_global_string(ctx, "__badEncode") == "EncodeFailed");
}

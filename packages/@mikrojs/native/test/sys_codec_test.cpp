/* The mik.sys scalar codec is the byte-for-byte agreement between the native OTA
 * policy store and the JS sysGet/sysSet path. The expected encodings below are
 * from RFC 8949, so a change in either implementation shows up here rather than
 * as two implementations quietly disagreeing about a live device's retry budget. */

#include <nanocbor/nanocbor.h>
#include <quickjs.h>

#include <cstring>
#include <string>
#include <vector>

#include "doctest.h"
#include "mikrojs/cbor_helpers.h"
#include "mikrojs/sys_codec.h"
#include "mikrojs/mikrojs.h"

namespace {

std::vector<uint8_t> EncodeStr(const char* value) {
    size_t needed = mik__kv_encode_str(value, nullptr, 0);
    std::vector<uint8_t> out(needed);
    CHECK(mik__kv_encode_str(value, out.data(), out.size()) == needed);
    return out;
}

std::vector<uint8_t> EncodeI32(int32_t value) {
    size_t needed = mik__kv_encode_i32(value, nullptr, 0);
    std::vector<uint8_t> out(needed);
    CHECK(mik__kv_encode_i32(value, out.data(), out.size()) == needed);
    return out;
}

}  // namespace

TEST_SUITE("sys codec") {

TEST_CASE("encodes a text string as a bare CBOR tstr") {
    // 0x63 = major type 3, length 3.
    CHECK(EncodeStr("abc") == std::vector<uint8_t>{0x63, 'a', 'b', 'c'});
    CHECK(EncodeStr("") == std::vector<uint8_t>{0x60});
}

TEST_CASE("encodes integers in CBOR's compact forms") {
    CHECK(EncodeI32(0) == std::vector<uint8_t>{0x00});
    CHECK(EncodeI32(1) == std::vector<uint8_t>{0x01});
    // 23 is the last value that fits in the initial byte; 24 needs one more.
    CHECK(EncodeI32(23) == std::vector<uint8_t>{0x17});
    CHECK(EncodeI32(24) == std::vector<uint8_t>{0x18, 0x18});
    CHECK(EncodeI32(1000) == std::vector<uint8_t>{0x19, 0x03, 0xe8});
    // Negative integers are major type 1, encoded as -1-n.
    CHECK(EncodeI32(-1) == std::vector<uint8_t>{0x20});
    CHECK(EncodeI32(-500) == std::vector<uint8_t>{0x39, 0x01, 0xf3});
}

TEST_CASE("round-trips the values the OTA policy store keeps") {
    for (const char* value : {"", "a", "https://reg.example/builds/app-2.tgz",
                              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}) {
        std::vector<uint8_t> bytes = EncodeStr(value);
        char out[128] = {};
        REQUIRE(mik__kv_decode_str(bytes.data(), bytes.size(), out, sizeof(out)));
        CHECK(std::string(out) == value);
    }
    for (int32_t value : {0, 1, 3, 23, 24, 255, 65535, 1 << 20, -1, -500}) {
        std::vector<uint8_t> bytes = EncodeI32(value);
        int32_t out = 12345;
        REQUIRE(mik__kv_decode_i32(bytes.data(), bytes.size(), &out));
        CHECK(out == value);
    }
}

TEST_CASE("measures before writing so callers can size the buffer") {
    CHECK(mik__kv_encode_str("abcd", nullptr, 0) == 5);
    uint8_t small[2] = {0xff, 0xff};
    // Too small: reports the requirement and writes nothing.
    CHECK(mik__kv_encode_str("abcd", small, sizeof(small)) == 5);
    CHECK(small[0] == 0xff);
    CHECK(mik__kv_encode_i32(1000, nullptr, 0) == 3);
}

TEST_CASE("rejects a value of the wrong shape rather than inventing one") {
    char out[16] = {};
    int32_t number = 0;
    std::vector<uint8_t> a_number = EncodeI32(7);
    CHECK(!mik__kv_decode_str(a_number.data(), a_number.size(), out, sizeof(out)));
    std::vector<uint8_t> a_string = EncodeStr("7");
    CHECK(!mik__kv_decode_i32(a_string.data(), a_string.size(), &number));
    // Empty and truncated inputs are not values.
    CHECK(!mik__kv_decode_str(nullptr, 0, out, sizeof(out)));
    CHECK(!mik__kv_decode_i32(a_string.data(), 0, &number));
    std::vector<uint8_t> truncated = {0x63, 'a'};
    CHECK(!mik__kv_decode_str(truncated.data(), truncated.size(), out, sizeof(out)));
}

TEST_CASE("refuses to overflow the caller's buffer") {
    std::vector<uint8_t> bytes = EncodeStr("abcdef");
    char small[4] = {};
    CHECK(!mik__kv_decode_str(bytes.data(), bytes.size(), small, sizeof(small)));
    // Exactly enough room for the six bytes plus the terminator.
    char exact[7] = {};
    CHECK(mik__kv_decode_str(bytes.data(), bytes.size(), exact, sizeof(exact)));
    CHECK(std::string(exact) == "abcdef");
}

TEST_CASE("agrees byte for byte with the encoder sysSet writes through") {
    // The claim the OTA policy store rests on: a value this codec writes is the
    // value mik__cbor_encode_value would have written for the equivalent JS
    // value, so `ota.tries` means the same thing to both implementations.
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    auto encoded_by_js = [ctx](JSValue value) {
        /* Non-null measuring base: the empty string appends zero bytes. */
        static uint8_t measure_base;
        nanocbor_encoder_t enc;
        nanocbor_encoder_init(&enc, &measure_base, 0);
        REQUIRE(mik__cbor_encode_value(ctx, &enc, value, 0) >= 0);
        std::vector<uint8_t> out(nanocbor_encoded_len(&enc));
        nanocbor_encoder_init(&enc, out.data(), out.size());
        mik__cbor_encode_value(ctx, &enc, value, 0);
        JS_FreeValue(ctx, value);
        return out;
    };

    for (const char* value : {"", "duk_secret", "https://reg.example"}) {
        CHECK(encoded_by_js(JS_NewString(ctx, value)) == EncodeStr(value));
    }
    for (int32_t value : {0, 1, 3, 23, 24, 1000}) {
        CHECK(encoded_by_js(JS_NewInt32(ctx, value)) == EncodeI32(value));
    }

    MIK_FreeRuntime(rt);
}

// ── device name pair ────────────────────────────────────────────────────────

TEST_CASE("parses the stored name pair") {
    int rev = -1;
    char name[64] = {};

    REQUIRE(mik__device_name_parse("[12,\"kitchen\"]", &rev, name, sizeof(name)));
    CHECK(rev == 12);
    CHECK(std::string(name) == "kitchen");

    // [rev] alone is a cleared name, not a missing pair.
    REQUIRE(mik__device_name_parse("[3]", &rev, name, sizeof(name)));
    CHECK(rev == 3);
    CHECK(name[0] == '\0');

    // Never named.
    REQUIRE(mik__device_name_parse("[0]", &rev, name, sizeof(name)));
    CHECK(rev == 0);

    // An explicit null name, and incidental whitespace.
    REQUIRE(mik__device_name_parse("[ 4 , null ]", &rev, name, sizeof(name)));
    CHECK(rev == 4);
    CHECK(name[0] == '\0');
    REQUIRE(mik__device_name_parse(" [ 5 , \"shed\" ] ", &rev, name, sizeof(name)));
    CHECK(rev == 5);
    CHECK(std::string(name) == "shed");
}

TEST_CASE("reads a malformed pair as no pair at all") {
    int rev = 99;
    char name[64] = {};
    // Each of these must fail rather than yield a half-parsed name: the caller
    // treats false as "never named" and falls back to the device id.
    for (const char* json : {"", "kitchen", "{}", "[]", "[-1]", "[1.5]", "[\"a\"]", "[1,2]",
                             "[1,\"unterminated", "[1,\"a\"", "[1,\"a\",2", "[1,\"a\\q\"]"}) {
        CHECK_FALSE(mik__device_name_parse(json, &rev, name, sizeof(name)));
    }
    CHECK_FALSE(mik__device_name_parse(nullptr, &rev, name, sizeof(name)));
}

TEST_CASE("decodes the escapes JSON.stringify emits") {
    // The writer is JSON.stringify, so a name typed into a dashboard can arrive
    // carrying any of these. A half-decoded name is worse than a rejected one.
    int rev = 0;
    char name[32] = {};
    struct {
        const char* json;
        const char* expected;
    } cases[] = {
        {"[1,\"a\\nb\"]", "a\nb"},   {"[1,\"a\\tb\"]", "a\tb"},
        {"[1,\"a\\rb\"]", "a\rb"},   {"[1,\"a\\bb\"]", "a\bb"},
        {"[1,\"a\\fb\"]", "a\fb"},   {"[1,\"a\\/b\"]", "a/b"},
        {"[1,\"a\\\"b\"]", "a\"b"}, {"[1,\"a\\\\b\"]", "a\\b"},
    };
    for (const auto& c : cases) {
        REQUIRE(mik__device_name_parse(c.json, &rev, name, sizeof(name)));
        CHECK(std::string(name) == c.expected);
    }
}

TEST_CASE("refuses a name longer than the caller's buffer") {
    int rev = 0;
    char small[4] = {};
    CHECK_FALSE(mik__device_name_parse("[1,\"kitchen\"]", &rev, small, sizeof(small)));
    char exact[4] = {};
    REQUIRE(mik__device_name_parse("[1,\"abc\"]", &rev, exact, sizeof(exact)));
    CHECK(std::string(exact) == "abc");
}

TEST_CASE("formats a pair the JS reader accepts") {
    char out[64] = {};
    CHECK(mik__device_name_format(12, "kitchen", out, sizeof(out)) == 14);
    CHECK(std::string(out) == "[12,\"kitchen\"]");
    CHECK(mik__device_name_format(3, nullptr, out, sizeof(out)) == 3);
    CHECK(std::string(out) == "[3]");
    // An empty name is the clear, same as no name.
    mik__device_name_format(3, "", out, sizeof(out));
    CHECK(std::string(out) == "[3]");
    // Quotes and backslashes are escaped so the text stays parseable.
    mik__device_name_format(1, "a\"b\\c", out, sizeof(out));
    CHECK(std::string(out) == "[1,\"a\\\"b\\\\c\"]");
    // Measures without writing.
    CHECK(mik__device_name_format(7, "ab", nullptr, 0) == 8);
}

TEST_CASE("round-trips every pair through both directions") {
    for (const char* name : {"", "shed", "kitchen light", "a\"b", "back\\slash"}) {
        char text[128] = {};
        mik__device_name_format(9, name, text, sizeof(text));
        int rev = -1;
        char parsed[128] = {};
        REQUIRE(mik__device_name_parse(text, &rev, parsed, sizeof(parsed)));
        CHECK(rev == 9);
        CHECK(std::string(parsed) == name);
    }
}

}  // TEST_SUITE

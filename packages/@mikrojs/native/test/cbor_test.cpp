#include <cstring>

#include <nanocbor/nanocbor.h>
#include <quickjs.h>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>

#include <doctest.h>

/* ── Helper: encode a JS value through native:mikro/cbor.encode ─────────── */
/* Since native:mikro/cbor is a module requiring import(), we test the nanocbor
 * C API directly for encode/decode round-trips, and use the mock REPL
 * protocol to verify the protocol-level CBOR payloads. */

/* ── nanocbor encode/decode round-trip tests ─────────────────────── */

TEST_CASE("CBOR round-trip: positive integer" * doctest::test_suite("cbor")) {
    uint8_t buf[16];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_uint(&enc, 42);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    uint32_t val = 0;
    CHECK(nanocbor_get_uint32(&dec, &val) >= 0);
    CHECK_EQ((uint32_t)42, val);
}

TEST_CASE("CBOR round-trip: negative integer" * doctest::test_suite("cbor")) {
    uint8_t buf[16];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_int(&enc, -7);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    int32_t val = 0;
    CHECK(nanocbor_get_int32(&dec, &val) >= 0);
    CHECK_EQ(-7, val);
}

TEST_CASE("CBOR round-trip: text string" * doctest::test_suite("cbor")) {
    uint8_t buf[64];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_put_tstr(&enc, "hello");
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    const uint8_t* str = nullptr;
    size_t str_len = 0;
    CHECK(nanocbor_get_tstr(&dec, &str, &str_len) >= 0);
    CHECK_EQ(5, str_len);
    CHECK(memcmp("hello", str, 5) == 0);
}

TEST_CASE("CBOR round-trip: byte string" * doctest::test_suite("cbor")) {
    uint8_t buf[64];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    const uint8_t data[] = {0xDE, 0xAD, 0xBE, 0xEF};
    nanocbor_put_bstr(&enc, data, sizeof(data));
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    const uint8_t* out = nullptr;
    size_t out_len = 0;
    CHECK(nanocbor_get_bstr(&dec, &out, &out_len) >= 0);
    CHECK_EQ(4, out_len);
    CHECK(memcmp(data, out, 4) == 0);
}

TEST_CASE("CBOR round-trip: boolean true/false" * doctest::test_suite("cbor")) {
    uint8_t buf[16];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_bool(&enc, true);
    nanocbor_fmt_bool(&enc, false);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    bool val = false;
    CHECK(nanocbor_get_bool(&dec, &val) >= 0);
    CHECK(val);
    CHECK(nanocbor_get_bool(&dec, &val) >= 0);
    CHECK_FALSE(val);
}

TEST_CASE("CBOR round-trip: null" * doctest::test_suite("cbor")) {
    uint8_t buf[4];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_null(&enc);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    CHECK(nanocbor_get_null(&dec) >= 0);
}

TEST_CASE("CBOR round-trip: undefined" * doctest::test_suite("cbor")) {
    uint8_t buf[4];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_undefined(&enc);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    CHECK(nanocbor_get_undefined(&dec) >= 0);
}

TEST_CASE("CBOR round-trip: float64" * doctest::test_suite("cbor")) {
    uint8_t buf[16];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_double(&enc, 3.14);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    double val = 0;
    CHECK(nanocbor_get_double(&dec, &val) >= 0);
    CHECK(val == doctest::Approx(3.14).epsilon(0.001));
}

TEST_CASE("CBOR round-trip: array of integers" * doctest::test_suite("cbor")) {
    uint8_t buf[32];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_array(&enc, 3);
    nanocbor_fmt_uint(&enc, 1);
    nanocbor_fmt_uint(&enc, 2);
    nanocbor_fmt_uint(&enc, 3);
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    nanocbor_value_t arr;
    CHECK(nanocbor_enter_array(&dec, &arr) >= 0);
    uint32_t v;
    nanocbor_get_uint32(&arr, &v); CHECK_EQ((uint32_t)1, v);
    nanocbor_get_uint32(&arr, &v); CHECK_EQ((uint32_t)2, v);
    nanocbor_get_uint32(&arr, &v); CHECK_EQ((uint32_t)3, v);
    CHECK(nanocbor_at_end(&arr));
}

TEST_CASE("CBOR round-trip: map with string keys" * doctest::test_suite("cbor")) {
    uint8_t buf[64];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_map(&enc, 2);
    nanocbor_put_tstr(&enc, "chip");
    nanocbor_put_tstr(&enc, "ESP32");
    nanocbor_put_tstr(&enc, "id");
    nanocbor_put_tstr(&enc, "abc123");
    size_t len = nanocbor_encoded_len(&enc);

    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    nanocbor_value_t map;
    CHECK(nanocbor_enter_map(&dec, &map) >= 0);

    const uint8_t* key; size_t key_len;
    const uint8_t* val; size_t val_len;

    nanocbor_get_tstr(&map, &key, &key_len);
    CHECK(memcmp("chip", key, key_len) == 0);
    nanocbor_get_tstr(&map, &val, &val_len);
    CHECK(memcmp("ESP32", val, val_len) == 0);

    nanocbor_get_tstr(&map, &key, &key_len);
    CHECK(memcmp("id", key, key_len) == 0);
    nanocbor_get_tstr(&map, &val, &val_len);
    CHECK(memcmp("abc123", val, val_len) == 0);

    CHECK(nanocbor_at_end(&map));
}

TEST_CASE("CBOR two-pass encode matches single-pass" * doctest::test_suite("cbor")) {
    /* Verify the two-pass pattern (NULL buffer for size, then real buffer) */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    nanocbor_fmt_map(&enc, 1);
    nanocbor_put_tstr(&enc, "key");
    nanocbor_fmt_uint(&enc, 99);
    size_t needed = nanocbor_encoded_len(&enc);
    CHECK(needed >= 0);

    uint8_t buf[64];
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_map(&enc, 1);
    nanocbor_put_tstr(&enc, "key");
    nanocbor_fmt_uint(&enc, 99);
    CHECK_EQ(needed, nanocbor_encoded_len(&enc));

    /* Decode and verify */
    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, needed);
    nanocbor_value_t map;
    nanocbor_enter_map(&dec, &map);
    const uint8_t* k; size_t k_len;
    nanocbor_get_tstr(&map, &k, &k_len);
    CHECK(memcmp("key", k, 3) == 0);
    uint32_t v;
    nanocbor_get_uint32(&map, &v);
    CHECK_EQ((uint32_t)99, v);
}

/* ── Protocol CBOR payload tests ─────────────────────────────────── */
/* Verify that the completions format matches what the TS side expects */

TEST_CASE("CBOR completions format: empty items" * doctest::test_suite("cbor")) {
    uint8_t buf[64];
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, buf, sizeof(buf));
    nanocbor_fmt_map(&enc, 2);
    nanocbor_put_tstr(&enc, "prefix");
    nanocbor_put_tstr(&enc, "con");
    nanocbor_put_tstr(&enc, "items");
    nanocbor_fmt_array(&enc, 0);
    size_t len = nanocbor_encoded_len(&enc);

    /* Decode and verify structure */
    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, len);
    nanocbor_value_t map;
    nanocbor_enter_map(&dec, &map);

    nanocbor_value_t prefix_val;
    CHECK(nanocbor_get_key_tstr(&map, "prefix", &prefix_val) >= 0);
    const uint8_t* prefix; size_t prefix_len;
    nanocbor_get_tstr(&prefix_val, &prefix, &prefix_len);
    CHECK(memcmp("con", prefix, prefix_len) == 0);
}

TEST_CASE("CBOR truncated input returns error" * doctest::test_suite("cbor")) {
    /* Just the start of a map header, truncated */
    uint8_t buf[] = {0xA2};  /* map(2) with no content */
    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, buf, sizeof(buf));
    nanocbor_value_t map;
    int rc = nanocbor_enter_map(&dec, &map);
    CHECK(rc >= 0);
    /* But trying to read from it should fail since there's no data */
    const uint8_t* k; size_t k_len;
    CHECK((nanocbor_at_end(&map) || nanocbor_get_tstr(&map, &k, &k_len) < 0));
}

TEST_CASE("CBOR empty buffer" * doctest::test_suite("cbor")) {
    nanocbor_value_t dec;
    nanocbor_decoder_init(&dec, nullptr, 0);
    CHECK(nanocbor_at_end(&dec));
    CHECK_EQ(NANOCBOR_ERR_END, nanocbor_get_type(&dec));
}

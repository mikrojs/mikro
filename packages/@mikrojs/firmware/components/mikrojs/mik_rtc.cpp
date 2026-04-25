#include <cstring>

#include <nanocbor/nanocbor.h>

#include "esp_attr.h"
#include "esp_rom_crc.h"
#include "mikrojs/cbor_helpers.h"
#include "mikrojs/errors.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_RTC_TAG "native:rtc"
#define MIK_RTC_STORE_SIZE 2048
#define MIK_RTC_MAGIC 0x4D524A53 /* "MRJS" */
#define MIK_RTC_MAX_KEY_LEN 255
#define MIK_RTC_MAX_VAL_LEN 65535

/* ── RTC store layout ────────────────────────────────────────────── */
/* [4B magic] [4B crc32] [2B entry_count] [2B data_len]              */
/* [entries: key_len(1) + key + val_len(2) + value ...]              */

struct __attribute__((packed)) RtcHeader {
    uint32_t magic;
    uint32_t crc;
    uint16_t entry_count;
    uint16_t data_len;
};

static_assert(sizeof(RtcHeader) == 12, "RtcHeader must be 12 bytes");

#define MIK_RTC_DATA_OFFSET sizeof(RtcHeader)
#define MIK_RTC_DATA_CAPACITY (MIK_RTC_STORE_SIZE - MIK_RTC_DATA_OFFSET)

RTC_NOINIT_ATTR static uint8_t s_rtc_store[MIK_RTC_STORE_SIZE];

/* ── CRC / validation helpers ────────────────────────────────────── */

static uint32_t mik__rtc_compute_crc() {
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    return esp_rom_crc32_le(0, s_rtc_store + MIK_RTC_DATA_OFFSET, hdr->data_len);
}

static bool mik__rtc_is_valid() {
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    if (hdr->magic != MIK_RTC_MAGIC) return false;
    if (hdr->data_len > MIK_RTC_DATA_CAPACITY) return false;
    return hdr->crc == mik__rtc_compute_crc();
}

static void mik__rtc_clear() {
    memset(s_rtc_store, 0, MIK_RTC_STORE_SIZE);
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    hdr->magic = MIK_RTC_MAGIC;
    hdr->crc = mik__rtc_compute_crc();
}

static void mik__rtc_ensure_valid() {
    if (!mik__rtc_is_valid()) {
        mik__rtc_clear();
    }
}

static void mik__rtc_update_crc() {
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    hdr->crc = mik__rtc_compute_crc();
}

/* ── Entry iteration helpers ─────────────────────────────────────── */

static uint8_t* mik__rtc_data() {
    return s_rtc_store + MIK_RTC_DATA_OFFSET;
}

/* Returns pointer to entry start, sets out_key_len, out_key, out_val_len, out_val.
 * Returns NULL if no more entries. */
static uint8_t* mik__rtc_next_entry(uint8_t* pos, uint8_t* end, uint8_t* out_key_len,
                                     const char** out_key, uint16_t* out_val_len,
                                     const char** out_val) {
    if (pos >= end) return nullptr;
    if (pos + 1 > end) return nullptr;

    *out_key_len = pos[0];
    if (pos + 1 + *out_key_len + 2 > end) return nullptr;

    *out_key = reinterpret_cast<const char*>(pos + 1);

    uint8_t* vl = pos + 1 + *out_key_len;
    *out_val_len = static_cast<uint16_t>(vl[0]) | (static_cast<uint16_t>(vl[1]) << 8);

    if (vl + 2 + *out_val_len > end) return nullptr;

    *out_val = reinterpret_cast<const char*>(vl + 2);
    return vl + 2 + *out_val_len;
}

/* Find an entry by key. Returns pointer to its start, or NULL. */
static uint8_t* mik__rtc_find(const char* key, uint8_t key_len, uint8_t** out_next) {
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    uint8_t* data = mik__rtc_data();
    uint8_t* end = data + hdr->data_len;
    uint8_t* pos = data;

    while (pos < end) {
        uint8_t ek_len;
        const char* ek;
        uint16_t ev_len;
        const char* ev;
        uint8_t* entry_start = pos;
        uint8_t* next = mik__rtc_next_entry(pos, end, &ek_len, &ek, &ev_len, &ev);
        if (!next) break;

        if (ek_len == key_len && memcmp(ek, key, key_len) == 0) {
            if (out_next) *out_next = next;
            return entry_start;
        }
        pos = next;
    }

    if (out_next) *out_next = nullptr;
    return nullptr;
}

static size_t mik__rtc_entry_size(uint8_t key_len, uint16_t val_len) {
    return 1 + key_len + 2 + val_len;
}

/* ── JS functions ────────────────────────────────────────────────── */

static JSValue mik__rtc_set(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    mik__rtc_ensure_valid();

    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t key_len = strlen(key);

    if (key_len == 0 || key_len > MIK_RTC_MAX_KEY_LEN) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_INVALID_KEY, 0,
                               "RTC key length must be 1-%d bytes", MIK_RTC_MAX_KEY_LEN);
    }

    /* CBOR-encode the value (two-pass: measure then encode) */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    if (mik__cbor_encode_value(ctx, &enc, argv[1], 0) < 0) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_ENCODE, 0, "RTC value is not CBOR-encodable");
    }
    size_t val_len = nanocbor_encoded_len(&enc);

    if (val_len > MIK_RTC_MAX_VAL_LEN) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_TOO_LARGE, 0,
                               "RTC value length exceeds %d bytes", MIK_RTC_MAX_VAL_LEN);
    }

    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    uint8_t* data = mik__rtc_data();

    /* Remove existing entry if present */
    uint8_t* next = nullptr;
    uint8_t* found = mik__rtc_find(key, static_cast<uint8_t>(key_len), &next);
    if (found && next) {
        uint8_t* end = data + hdr->data_len;
        size_t tail = end - next;
        memmove(found, next, tail);
        hdr->data_len -= static_cast<uint16_t>(next - found);
        hdr->entry_count--;
    }

    /* Check space */
    size_t needed = mik__rtc_entry_size(static_cast<uint8_t>(key_len), static_cast<uint16_t>(val_len));
    if (hdr->data_len + needed > MIK_RTC_DATA_CAPACITY) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_STORAGE_FULL, 0,
                               "RTC memory full (need %zu bytes, %zu available)", needed,
                               MIK_RTC_DATA_CAPACITY - hdr->data_len);
    }

    /* Append new entry: encode CBOR directly into the RTC store */
    uint8_t* write_pos = data + hdr->data_len;
    write_pos[0] = static_cast<uint8_t>(key_len);
    memcpy(write_pos + 1, key, key_len);
    write_pos[1 + key_len] = static_cast<uint8_t>(val_len & 0xFF);
    write_pos[1 + key_len + 1] = static_cast<uint8_t>((val_len >> 8) & 0xFF);

    nanocbor_encoder_init(&enc, write_pos + 1 + key_len + 2, val_len);
    mik__cbor_encode_value(ctx, &enc, argv[1], 0);

    hdr->data_len += static_cast<uint16_t>(needed);
    hdr->entry_count++;
    mik__rtc_update_crc();

    JS_FreeCString(ctx, key);
    return mik__result_ok_void(ctx);
}

static JSValue mik__rtc_get(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    mik__rtc_ensure_valid();

    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t key_len = strlen(key);

    if (key_len == 0 || key_len > MIK_RTC_MAX_KEY_LEN) {
        JS_FreeCString(ctx, key);
        return JS_UNDEFINED;
    }

    uint8_t* found = mik__rtc_find(key, static_cast<uint8_t>(key_len), nullptr);
    JS_FreeCString(ctx, key);

    if (!found) return JS_UNDEFINED;

    /* Parse the entry to extract the CBOR value */
    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    uint8_t* data = mik__rtc_data();
    uint8_t* end = data + hdr->data_len;

    uint8_t ek_len;
    const char* ek;
    uint16_t ev_len;
    const char* ev;
    mik__rtc_next_entry(found, end, &ek_len, &ek, &ev_len, &ev);

    /* Decode CBOR bytes back into a JS value */
    nanocbor_value_t decoder;
    nanocbor_decoder_init(&decoder, reinterpret_cast<const uint8_t*>(ev), ev_len);
    JSValue result = mik__cbor_decode_value(ctx, &decoder, 0);
    if (JS_IsException(result)) return JS_UNDEFINED;
    return result;
}

static JSValue mik__rtc_remove(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    mik__rtc_ensure_valid();

    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t key_len = strlen(key);

    if (key_len == 0 || key_len > MIK_RTC_MAX_KEY_LEN) {
        JS_FreeCString(ctx, key);
        return JS_NewBool(ctx, false);
    }

    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    uint8_t* data = mik__rtc_data();

    uint8_t* next = nullptr;
    uint8_t* found = mik__rtc_find(key, static_cast<uint8_t>(key_len), &next);
    JS_FreeCString(ctx, key);

    if (!found || !next) return JS_NewBool(ctx, false);

    uint8_t* end = data + hdr->data_len;
    size_t tail = end - next;
    memmove(found, next, tail);
    hdr->data_len -= static_cast<uint16_t>(next - found);
    hdr->entry_count--;
    mik__rtc_update_crc();

    return JS_NewBool(ctx, true);
}

static JSValue mik__rtc_js_clear(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    mik__rtc_clear();
    return JS_UNDEFINED;
}

static JSValue mik__rtc_info(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    mik__rtc_ensure_valid();

    auto* hdr = reinterpret_cast<RtcHeader*>(s_rtc_store);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "used", JS_NewInt32(ctx, hdr->data_len));
    JS_SetPropertyStr(ctx, obj, "total", JS_NewInt32(ctx, MIK_RTC_DATA_CAPACITY));
    JS_SetPropertyStr(ctx, obj, "entries", JS_NewInt32(ctx, hdr->entry_count));
    return obj;
}

/* ── Module init ─────────────────────────────────────────────────── */

static int mik__rtc_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "set", JS_NewCFunction(ctx, mik__rtc_set, "set", 2));
    JS_SetModuleExport(ctx, m, "get", JS_NewCFunction(ctx, mik__rtc_get, "get", 1));
    JS_SetModuleExport(ctx, m, "remove", JS_NewCFunction(ctx, mik__rtc_remove, "remove", 1));
    JS_SetModuleExport(ctx, m, "clear", JS_NewCFunction(ctx, mik__rtc_js_clear, "clear", 0));
    JS_SetModuleExport(ctx, m, "info", JS_NewCFunction(ctx, mik__rtc_info, "info", 0));
    return 0;
}

/* ── Public API ──────────────────────────────────────────────────── */

static JSModuleDef* mik__rtc_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:rtc", mik__rtc_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "set");
    JS_AddModuleExport(ctx, m, "get");
    JS_AddModuleExport(ctx, m, "remove");
    JS_AddModuleExport(ctx, m, "clear");
    JS_AddModuleExport(ctx, m, "info");
    return m;
}

MIK_REGISTER_MODULE(rtc, "native:rtc", mik__rtc_init, nullptr, nullptr)

#include "mikrojs/ota_slots.h"

#include <nanocbor/nanocbor.h>

#include <cstring>
#include <string>

#include "mikrojs/cbor_helpers.h"

namespace mikrojs {

namespace {

const char* slot_key(MIKOtaConfigSlot slot) {
    switch (slot) {
        case MIK_OTA_CFG_CURRENT:
            return "ota.cfg";
        case MIK_OTA_CFG_NEXT:
            return "ota.cfgNext";
        case MIK_OTA_CFG_PREV:
            return "ota.cfgPrev";
    }
    return "ota.cfg";
}

const char* kTrialKey = "ota.cfgTrial";
const char* kErrorKey = "ota.cfgErr";

/* Read a whole blob, distinguishing absent from failed. */
MIKOtaKvStatus kv_read(const MIKOtaEnv* env, const char* key, std::vector<uint8_t>* out) {
    if (!env || !env->kv_get_blob) return MIK_OTA_KV_ABSENT;
    size_t len = 0;
    MIKOtaKvStatus status = env->kv_get_blob(env->opaque, key, nullptr, &len);
    if (status != MIK_OTA_KV_OK) return status;
    if (len == 0) return MIK_OTA_KV_ABSENT;
    out->resize(len);
    status = env->kv_get_blob(env->opaque, key, out->data(), &len);
    if (status != MIK_OTA_KV_OK) return status;
    out->resize(len);
    return MIK_OTA_KV_OK;
}

bool take_str(nanocbor_value_t* it, char* out, size_t out_len) {
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(it, &ptr, &len) < 0) return false;
    snprintf(out, out_len, "%.*s", static_cast<int>(len), reinterpret_cast<const char*>(ptr));
    return true;
}

bool take_key(nanocbor_value_t* map, std::string* out) {
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(map, &ptr, &len) < 0) return false;
    out->assign(reinterpret_cast<const char*>(ptr), len);
    return true;
}

template <typename Fn>
std::vector<uint8_t> encode_to_vector(Fn&& encode) {
    /* The measuring pass needs a non-null base: zero-length appends (an empty
     * string, an empty document) still reach memcpy. */
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    encode(&enc);
    std::vector<uint8_t> out(nanocbor_encoded_len(&enc));
    nanocbor_encoder_init(&enc, out.data(), out.size());
    encode(&enc);
    return out;
}

/* Append pre-encoded CBOR verbatim. A stored document keeps the exact bytes the
 * registry sent, so the JS reader decodes the same value the app would have
 * seen; re-encoding would mean carrying a value model for no reason. */
void put_raw(nanocbor_encoder_t* enc, const uint8_t* data, size_t len) {
    enc->len += len;
    if (enc->fits(enc, enc->context, len)) {
        enc->append(enc, enc->context, data, len);
    }
}

}  // namespace

/* The slot holds the CBOR map the registry path wrote; anything else reads as
 * absent. */
MIKOtaLoadedConfig mik__ota_load_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot) {
    MIKOtaLoadedConfig out;
    MIKOtaKvStatus status = kv_read(env, slot_key(slot), &out.bytes);
    if (status == MIK_OTA_KV_ERROR) {
        out.failed = true;
        return out;
    }
    if (status != MIK_OTA_KV_OK) return out;

    nanocbor_value_t val;
    nanocbor_decoder_init(&val, out.bytes.data(), out.bytes.size());
    nanocbor_value_t map;
    if (nanocbor_get_type(&val) != NANOCBOR_TYPE_MAP || nanocbor_enter_map(&val, &map) < 0) {
        return out;
    }

    while (!nanocbor_at_end(&map)) {
        std::string key;
        if (!take_key(&map, &key)) break;
        if (key == "version") {
            if (!take_str(&map, out.cfg.version, sizeof(out.cfg.version))) {
                mik__cbor_skip_value(&map);
            }
        } else if (key == "rev") {
            if (!take_str(&map, out.cfg.rev, sizeof(out.cfg.rev))) mik__cbor_skip_value(&map);
        } else if (key == "doc") {
            const uint8_t* start = map.cur;
            if (nanocbor_get_null(&map) >= 0) continue;  // null normalises to absent
            if (mik__cbor_skip_value(&map) < 0) break;
            out.cfg.doc_cbor = const_cast<uint8_t*>(start);
            out.cfg.doc_cbor_len = static_cast<size_t>(map.cur - start);
        } else {
            mik__cbor_skip_value(&map);
        }
    }
    out.present = out.cfg.version[0] != '\0';
    return out;
}

void mik__ota_store_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot,
                         const MIKOtaStoredConfig& cfg) {
    if (!env || !env->kv_set_blob) return;
    size_t map_size = 1;  // version
    if (cfg.rev[0]) map_size++;
    if (cfg.doc_cbor && cfg.doc_cbor_len > 0) map_size++;

    std::vector<uint8_t> buf = encode_to_vector([&](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, map_size);
        nanocbor_put_tstr(enc, "version");
        nanocbor_put_tstr(enc, cfg.version);
        if (cfg.rev[0]) {
            nanocbor_put_tstr(enc, "rev");
            nanocbor_put_tstr(enc, cfg.rev);
        }
        if (cfg.doc_cbor && cfg.doc_cbor_len > 0) {
            nanocbor_put_tstr(enc, "doc");
            put_raw(enc, cfg.doc_cbor, cfg.doc_cbor_len);
        }
    });
    env->kv_set_blob(env->opaque, slot_key(slot), buf.data(), buf.size());
}

void mik__ota_clear_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot) {
    if (env && env->kv_remove) env->kv_remove(env->opaque, slot_key(slot));
}

MIKOtaKvStatus mik__ota_load_trial(const MIKOtaEnv* env, MIKOtaConfigTrial* out) {
    std::vector<uint8_t> bytes;
    MIKOtaKvStatus status = kv_read(env, kTrialKey, &bytes);
    if (status != MIK_OTA_KV_OK) return status;
    nanocbor_value_t val;
    nanocbor_decoder_init(&val, bytes.data(), bytes.size());
    nanocbor_value_t map;
    if (nanocbor_get_type(&val) != NANOCBOR_TYPE_MAP || nanocbor_enter_map(&val, &map) < 0) {
        return MIK_OTA_KV_ABSENT;
    }
    bool has_left = false;
    bool has_read = false;
    while (!nanocbor_at_end(&map)) {
        std::string key;
        if (!take_key(&map, &key)) break;
        if (key == "left") {
            int32_t left = 0;
            if (nanocbor_get_int32(&map, &left) >= 0) {
                out->left = left;
                has_left = true;
            } else {
                mik__cbor_skip_value(&map);
            }
        } else if (key == "read") {
            bool read = false;
            if (nanocbor_get_bool(&map, &read) >= 0) {
                out->read = read;
                has_read = true;
            } else {
                mik__cbor_skip_value(&map);
            }
        } else {
            mik__cbor_skip_value(&map);
        }
    }
    return (has_left && has_read) ? MIK_OTA_KV_OK : MIK_OTA_KV_ABSENT;
}

void mik__ota_store_trial(const MIKOtaEnv* env, const MIKOtaConfigTrial& trial) {
    if (!env || !env->kv_set_blob) return;
    std::vector<uint8_t> buf = encode_to_vector([&](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 2);
        nanocbor_put_tstr(enc, "left");
        nanocbor_fmt_int(enc, trial.left);
        nanocbor_put_tstr(enc, "read");
        nanocbor_fmt_bool(enc, trial.read);
    });
    env->kv_set_blob(env->opaque, kTrialKey, buf.data(), buf.size());
}

void mik__ota_clear_trial(const MIKOtaEnv* env) {
    if (env && env->kv_remove) env->kv_remove(env->opaque, kTrialKey);
}

bool mik__ota_load_config_error(const MIKOtaEnv* env, MIKOtaConfigErrorReport* out) {
    std::vector<uint8_t> bytes;
    if (kv_read(env, kErrorKey, &bytes) != MIK_OTA_KV_OK) return false;
    nanocbor_value_t val;
    nanocbor_decoder_init(&val, bytes.data(), bytes.size());
    nanocbor_value_t map;
    if (nanocbor_get_type(&val) != NANOCBOR_TYPE_MAP || nanocbor_enter_map(&val, &map) < 0) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    bool has_message = false;
    while (!nanocbor_at_end(&map)) {
        std::string key;
        if (!take_key(&map, &key)) break;
        if (key == "rev") {
            if (!take_str(&map, out->rev, sizeof(out->rev))) mik__cbor_skip_value(&map);
        } else if (key == "message") {
            has_message = take_str(&map, out->message, sizeof(out->message));
            if (!has_message) mik__cbor_skip_value(&map);
        } else {
            mik__cbor_skip_value(&map);
        }
    }
    return out->rev[0] != '\0' && has_message;
}

void mik__ota_store_config_error(const MIKOtaEnv* env, const MIKOtaConfigErrorReport& report) {
    if (!env || !env->kv_set_blob) return;
    std::vector<uint8_t> buf = encode_to_vector([&](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 2);
        nanocbor_put_tstr(enc, "rev");
        nanocbor_put_tstr(enc, report.rev);
        nanocbor_put_tstr(enc, "message");
        nanocbor_put_tstr(enc, report.message);
    });
    env->kv_set_blob(env->opaque, kErrorKey, buf.data(), buf.size());
}

void mik__ota_clear_config_error(const MIKOtaEnv* env) {
    if (env && env->kv_remove) env->kv_remove(env->opaque, kErrorKey);
}

}  // namespace mikrojs

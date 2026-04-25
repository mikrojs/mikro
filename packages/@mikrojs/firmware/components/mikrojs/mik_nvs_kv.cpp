/**
 * native:nvs_kv — NVS-backed key-value storage native module.
 *
 * Values are CBOR-encoded and stored as NVS blobs in the "mik.kv" namespace.
 * Survives power cycles. NVS keys are limited to 15 characters.
 */

#include <cstring>

#include <nanocbor/nanocbor.h>
#include <nvs.h>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/errors.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_NVS_KV_NS "mik.kv"
#define MIK_NVS_MAX_KEY_LEN 15
#define MIK_NVS_MAX_VAL_LEN (16 * 1024)

/* ── JS functions ────────────────────────────────────────────────── */

static JSValue mik__nvs_kv_set(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t key_len = strlen(key);

    if (key_len == 0 || key_len > MIK_NVS_MAX_KEY_LEN) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_INVALID_KEY, 0,
                               "NVS key length must be 1-%d bytes", MIK_NVS_MAX_KEY_LEN);
    }

    /* CBOR-encode the value (two-pass: measure then encode) */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    if (mik__cbor_encode_value(ctx, &enc, argv[1], 0) < 0) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_ENCODE, 0, "NVS value is not CBOR-encodable");
    }
    size_t val_len = nanocbor_encoded_len(&enc);

    if (val_len > MIK_NVS_MAX_VAL_LEN) {
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_TOO_LARGE, 0,
                               "NVS value exceeds %d bytes", MIK_NVS_MAX_VAL_LEN);
    }

    /* Encode into buffer */
    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, val_len > 0 ? val_len : 1));
    if (!buf) {
        JS_FreeCString(ctx, key);
        return JS_EXCEPTION;
    }
    nanocbor_encoder_init(&enc, buf, val_len);
    mik__cbor_encode_value(ctx, &enc, argv[1], 0);

    /* Write to NVS */
    nvs_handle_t handle;
    esp_err_t err = nvs_open(MIK_NVS_KV_NS, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        js_free(ctx, buf);
        JS_FreeCString(ctx, key);
        return mik__result_err(ctx, MIK_ERR_KV_WRITE, err,
                               "NVS open failed: %s", esp_err_to_name(err));
    }

    err = nvs_set_blob(handle, key, buf, val_len);
    js_free(ctx, buf);
    JS_FreeCString(ctx, key);

    if (err != ESP_OK) {
        nvs_close(handle);
        return mik__result_err(ctx, MIK_ERR_KV_WRITE, err,
                               "NVS set failed: %s", esp_err_to_name(err));
    }

    err = nvs_commit(handle);
    nvs_close(handle);

    if (err != ESP_OK) {
        return mik__result_err(ctx, MIK_ERR_KV_WRITE, err,
                               "NVS commit failed: %s", esp_err_to_name(err));
    }

    return mik__result_ok_void(ctx);
}

static JSValue mik__nvs_kv_get(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;
    size_t key_len = strlen(key);

    if (key_len == 0 || key_len > MIK_NVS_MAX_KEY_LEN) {
        JS_FreeCString(ctx, key);
        return JS_UNDEFINED;
    }

    nvs_handle_t handle;
    if (nvs_open(MIK_NVS_KV_NS, NVS_READONLY, &handle) != ESP_OK) {
        JS_FreeCString(ctx, key);
        return JS_UNDEFINED;
    }

    /* Query size first */
    size_t len = 0;
    esp_err_t err = nvs_get_blob(handle, key, nullptr, &len);
    if (err != ESP_OK || len == 0) {
        JS_FreeCString(ctx, key);
        nvs_close(handle);
        return JS_UNDEFINED;
    }

    /* Read blob */
    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, len));
    if (!buf) {
        JS_FreeCString(ctx, key);
        nvs_close(handle);
        return JS_EXCEPTION;
    }

    err = nvs_get_blob(handle, key, buf, &len);
    JS_FreeCString(ctx, key);
    nvs_close(handle);

    if (err != ESP_OK) {
        js_free(ctx, buf);
        return JS_UNDEFINED;
    }

    /* Decode CBOR */
    nanocbor_value_t decoder;
    nanocbor_decoder_init(&decoder, buf, len);
    JSValue result = mik__cbor_decode_value(ctx, &decoder, 0);
    js_free(ctx, buf);

    if (JS_IsException(result)) return JS_UNDEFINED;
    return result;
}

static JSValue mik__nvs_kv_remove(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* key = JS_ToCString(ctx, argv[0]);
    if (!key) return JS_EXCEPTION;

    nvs_handle_t handle;
    if (nvs_open(MIK_NVS_KV_NS, NVS_READWRITE, &handle) != ESP_OK) {
        JS_FreeCString(ctx, key);
        return JS_NewBool(ctx, false);
    }

    esp_err_t err = nvs_erase_key(handle, key);
    JS_FreeCString(ctx, key);

    if (err != ESP_OK) {
        nvs_close(handle);
        return JS_NewBool(ctx, false);
    }

    nvs_commit(handle);
    nvs_close(handle);
    return JS_NewBool(ctx, true);
}

static JSValue mik__nvs_kv_clear(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    nvs_handle_t handle;
    if (nvs_open(MIK_NVS_KV_NS, NVS_READWRITE, &handle) != ESP_OK) {
        return JS_UNDEFINED;
    }

    nvs_erase_all(handle);
    nvs_commit(handle);
    nvs_close(handle);
    return JS_UNDEFINED;
}

static JSValue mik__nvs_kv_info(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    /* Partition-level stats (shared across all namespaces) */
    nvs_stats_t stats = {};
    nvs_get_stats(nullptr, &stats);

    nvs_handle_t handle;
    size_t used_count = 0;
    if (nvs_open(MIK_NVS_KV_NS, NVS_READONLY, &handle) == ESP_OK) {
        nvs_get_used_entry_count(handle, &used_count);
        nvs_close(handle);
    }

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "entries", JS_NewInt32(ctx, static_cast<int32_t>(used_count)));
    JS_SetPropertyStr(ctx, obj, "used", JS_NewInt32(ctx, static_cast<int32_t>(stats.used_entries)));
    JS_SetPropertyStr(ctx, obj, "total", JS_NewInt32(ctx, static_cast<int32_t>(stats.total_entries)));
    JS_SetPropertyStr(ctx, obj, "free", JS_NewInt32(ctx, static_cast<int32_t>(stats.free_entries)));
    return obj;
}

/* ── Module init ─────────────────────────────────────────────────── */

static int mik__nvs_kv_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "set", JS_NewCFunction(ctx, mik__nvs_kv_set, "set", 2));
    JS_SetModuleExport(ctx, m, "get", JS_NewCFunction(ctx, mik__nvs_kv_get, "get", 1));
    JS_SetModuleExport(ctx, m, "remove", JS_NewCFunction(ctx, mik__nvs_kv_remove, "remove", 1));
    JS_SetModuleExport(ctx, m, "clear", JS_NewCFunction(ctx, mik__nvs_kv_clear, "clear", 0));
    JS_SetModuleExport(ctx, m, "info", JS_NewCFunction(ctx, mik__nvs_kv_info, "info", 0));
    return 0;
}

static JSModuleDef* mik__nvs_kv_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:nvs_kv", mik__nvs_kv_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "set");
    JS_AddModuleExport(ctx, m, "get");
    JS_AddModuleExport(ctx, m, "remove");
    JS_AddModuleExport(ctx, m, "clear");
    JS_AddModuleExport(ctx, m, "info");
    return m;
}

MIK_REGISTER_MODULE(nvs_kv, "native:nvs_kv", mik__nvs_kv_init, nullptr, nullptr)

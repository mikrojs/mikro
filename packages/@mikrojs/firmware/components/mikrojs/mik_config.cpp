#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <string>
#include <vector>

#include <nanocbor/nanocbor.h>

#include "nvs.h"
#include "nvs_flash.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs_esp32.h"

/* ── Unified protocol config handler ────────────────────────────── */

/** Collected config entry for CBOR encoding */
struct config_entry_t {
    std::string key;
    std::string value;
    bool secret;
};

/** Encode a single config entry into a CBOR encoder */
static void encode_config_entry(nanocbor_encoder_t* enc, const config_entry_t& entry) {
    nanocbor_fmt_map(enc, 3);
    nanocbor_put_tstr(enc, "key");
    nanocbor_put_tstrn(enc, entry.key.c_str(), entry.key.size());
    nanocbor_put_tstr(enc, "value");
    nanocbor_put_tstrn(enc, entry.value.c_str(), entry.value.size());
    nanocbor_put_tstr(enc, "secret");
    nanocbor_fmt_bool(enc, entry.secret);
}

/** Build CBOR array of env entries for MSG_CONFIG_ENTRIES */
static std::vector<uint8_t> build_config_entries_cbor() {
    std::vector<config_entry_t> entries;

    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_ENV, NVS_READONLY, &handle) == ESP_OK) {
        nvs_iterator_t it = NULL;
        esp_err_t err = nvs_entry_find_in_handle(handle, NVS_TYPE_STR, &it);
        while (err == ESP_OK && it != NULL) {
            nvs_entry_info_t info;
            nvs_entry_info(it, &info);

            config_entry_t entry;
            entry.key = info.key;
            entry.secret = mik__nvs_is_secret(info.key);

            if (!entry.secret) {
                size_t val_len = 0;
                nvs_get_str(handle, info.key, NULL, &val_len);
                char buf[512];
                if (val_len > 0 && val_len <= sizeof(buf)) {
                    nvs_get_str(handle, info.key, buf, &val_len);
                    entry.value.assign(buf, val_len > 0 ? val_len - 1 : 0);
                }
            }

            entries.push_back(std::move(entry));
            err = nvs_entry_next(&it);
        }
        nvs_release_iterator(it);
        nvs_close(handle);
    }

    /* Two-pass CBOR encode */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    nanocbor_fmt_array(&enc, entries.size());
    for (const auto& e : entries) {
        encode_config_entry(&enc, e);
    }
    size_t needed = nanocbor_encoded_len(&enc);

    std::vector<uint8_t> buf(needed);
    nanocbor_encoder_init(&enc, buf.data(), needed);
    nanocbor_fmt_array(&enc, entries.size());
    for (const auto& e : entries) {
        encode_config_entry(&enc, e);
    }
    return buf;
}

bool mik__handle_config_command(MIKReplTransport* transport, uint8_t cmd_type,
                                uint32_t payload_len) {
    switch (cmd_type) {
        case MIK_CMD_CONFIG_LIST: {
            mik__proto_drain(transport, payload_len);
            auto cbor = build_config_entries_cbor();
            mik__proto_send(transport, MIK_MSG_CONFIG_ENTRIES, cbor.data(), cbor.size());
            return true;
        }

        case MIK_CMD_CONFIG_SET: {
            /* Payload: u8 flags | u16le key_len | key | u16le val_len | value */
            if (payload_len < 3) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "config header too short");
                return true;
            }
            uint8_t flags;
            if (!mik__proto_read_exact(transport, &flags, 1)) return false;

            uint8_t kl[2];
            if (!mik__proto_read_exact(transport, kl, 2)) return false;
            uint16_t key_len = kl[0] | (kl[1] << 8);

            char key[64];
            if (key_len >= sizeof(key) || (uint32_t)key_len + 3 > payload_len) {
                mik__proto_drain(transport, payload_len - 3);
                mik__proto_send_err(transport, "key too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, key, key_len)) return false;
            key[key_len] = '\0';
            uint32_t consumed = 3 + (uint32_t)key_len;

            if (consumed + 2 > payload_len) {
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "config value header truncated");
                return true;
            }
            uint8_t vl[2];
            if (!mik__proto_read_exact(transport, vl, 2)) return false;
            uint16_t val_len = vl[0] | (vl[1] << 8);
            consumed += 2;

            char value[512];
            if (val_len >= sizeof(value) || consumed + (uint32_t)val_len > payload_len) {
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "value too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, value, val_len)) return false;
            value[val_len] = '\0';
            consumed += val_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            if (key_len > 15) {
                mik__proto_send_err(transport, "key exceeds NVS 15-char limit");
                return true;
            }

            bool changed = false;
            if (mik__nvs_env_set(key, value, flags & MIK_ENV_FLAG_SECRET, &changed)) {
                uint8_t byte = changed ? 1 : 0;
                mik__proto_send(transport, MIK_MSG_OK, &byte, 1);
            } else {
                mik__proto_send_err(transport, "nvs write failed");
            }
            return true;
        }

        case MIK_CMD_CONFIG_DELETE: {
            /* Payload: u16le key_len | key */
            if (payload_len < 2) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "config header too short");
                return true;
            }
            uint8_t kl[2];
            if (!mik__proto_read_exact(transport, kl, 2)) return false;
            uint16_t key_len = kl[0] | (kl[1] << 8);

            char key[64];
            if (key_len >= sizeof(key) || (uint32_t)key_len + 2 > payload_len) {
                mik__proto_drain(transport, payload_len - 2);
                mik__proto_send_err(transport, "key too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, key, key_len)) return false;
            key[key_len] = '\0';
            uint32_t consumed = 2 + (uint32_t)key_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            uint8_t byte = mik__nvs_env_delete(key) ? 1 : 0;
            mik__proto_send(transport, MIK_MSG_OK, &byte, 1);
            return true;
        }

        case MIK_CMD_KV_SET: {
            /* Payload: u8 ns | u16le key_len | key | u16le val_len | value.
             * ns selects the namespace (0 = mik.kv, 1 = mik.sys). The value is
             * stored as a CBOR text-string blob, matching what `mikro/kv/nvs`
             * writes, so JS reads it back as a plain string. */
            if (payload_len < 3) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "kv header too short");
                return true;
            }
            uint8_t ns;
            if (!mik__proto_read_exact(transport, &ns, 1)) return false;
            if (ns > 1) {
                mik__proto_drain(transport, payload_len - 1);
                mik__proto_send_err(transport, "unknown kv namespace");
                return true;
            }

            uint8_t kl[2];
            if (!mik__proto_read_exact(transport, kl, 2)) return false;
            uint16_t key_len = kl[0] | (kl[1] << 8);

            char key[64];
            if (key_len >= sizeof(key) || (uint32_t)key_len + 3 > payload_len) {
                mik__proto_drain(transport, payload_len - 3);
                mik__proto_send_err(transport, "key too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, key, key_len)) return false;
            key[key_len] = '\0';
            uint32_t consumed = 3 + (uint32_t)key_len;

            if (consumed + 2 > payload_len) {
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "kv value header truncated");
                return true;
            }
            uint8_t vl[2];
            if (!mik__proto_read_exact(transport, vl, 2)) return false;
            uint16_t val_len = vl[0] | (vl[1] << 8);
            consumed += 2;

            char value[512];
            if (val_len >= sizeof(value) || consumed + (uint32_t)val_len > payload_len) {
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "value too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, value, val_len)) return false;
            value[val_len] = '\0';
            consumed += val_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            if (key_len == 0 || key_len > 15) {
                mik__proto_send_err(transport, "key exceeds NVS 15-char limit");
                return true;
            }

            nanocbor_encoder_t enc;
            uint8_t blob[sizeof(value) + 4];
            nanocbor_encoder_init(&enc, blob, sizeof(blob));
            if (nanocbor_put_tstrn(&enc, value, val_len) < 0) {
                mik__proto_send_err(transport, "cbor encode failed");
                return true;
            }
            size_t blob_len = nanocbor_encoded_len(&enc);

            nvs_handle_t handle;
            esp_err_t err = nvs_open(ns == 1 ? "mik.sys" : "mik.kv", NVS_READWRITE, &handle);
            if (err == ESP_OK) {
                err = nvs_set_blob(handle, key, blob, blob_len);
                if (err == ESP_OK) err = nvs_commit(handle);
                nvs_close(handle);
            }
            if (err == ESP_OK) {
                mik__proto_send_ok(transport);
            } else {
                mik__proto_send_err(transport, "nvs write failed");
            }
            return true;
        }

        case MIK_CMD_KV_DELETE: {
            /* Payload: u8 ns | u16le key_len | key */
            if (payload_len < 3) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "kv header too short");
                return true;
            }
            uint8_t ns;
            if (!mik__proto_read_exact(transport, &ns, 1)) return false;
            if (ns > 1) {
                mik__proto_drain(transport, payload_len - 1);
                mik__proto_send_err(transport, "unknown kv namespace");
                return true;
            }

            uint8_t kl[2];
            if (!mik__proto_read_exact(transport, kl, 2)) return false;
            uint16_t key_len = kl[0] | (kl[1] << 8);

            char key[64];
            if (key_len >= sizeof(key) || (uint32_t)key_len + 3 > payload_len) {
                mik__proto_drain(transport, payload_len - 3);
                mik__proto_send_err(transport, "key too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, key, key_len)) return false;
            key[key_len] = '\0';
            uint32_t consumed = 3 + (uint32_t)key_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            bool existed = false;
            esp_err_t err = ESP_FAIL;
            nvs_handle_t handle;
            if (nvs_open(ns == 1 ? "mik.sys" : "mik.kv", NVS_READWRITE, &handle) == ESP_OK) {
                size_t len = 0;
                existed = nvs_get_blob(handle, key, nullptr, &len) == ESP_OK;
                err = nvs_erase_key(handle, key);
                /* Deleting a key that was never there is a successful no-op. */
                if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
                if (err == ESP_OK) err = nvs_commit(handle);
                nvs_close(handle);
            }
            if (err != ESP_OK) {
                mik__proto_send_err(transport, "nvs delete failed");
                return true;
            }
            uint8_t byte = existed ? 1 : 0;
            mik__proto_send(transport, MIK_MSG_OK, &byte, 1);
            return true;
        }

        default:
            mik__proto_drain(transport, payload_len);
            return false;
    }
}

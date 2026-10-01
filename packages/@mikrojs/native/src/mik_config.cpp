#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <string>
#include <vector>

#include <nanocbor/nanocbor.h>

#include "mikrojs/device_store.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"

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
    /* Header only for an empty value: in the sizing pass the encoder has no
     * buffer, and nanocbor would memcpy zero bytes to NULL. */
    if (entry.value.empty()) {
        nanocbor_fmt_tstr(enc, 0);
    } else {
        nanocbor_put_tstrn(enc, entry.value.c_str(), entry.value.size());
    }
    nanocbor_put_tstr(enc, "secret");
    nanocbor_fmt_bool(enc, entry.secret);
}

/** Build CBOR array of env entries for MSG_CONFIG_ENTRIES */
static std::vector<uint8_t> build_config_entries_cbor() {
    std::vector<config_entry_t> entries;

    const MIKDeviceStore* store = mik__device_store();
    if (store && store->env_each) {
        store->env_each(
            [](const char* key, const char* value, bool secret, void* ud) {
                config_entry_t entry;
                entry.key = key;
                entry.secret = secret;
                /* Secret values never leave the device. */
                if (!secret && value) entry.value = value;
                static_cast<std::vector<config_entry_t>*>(ud)->push_back(std::move(entry));
            },
            &entries);
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

bool MIK_HandleConfigCommand(MIKReplTransport* transport, uint8_t cmd_type, uint32_t payload_len) {
    const MIKDeviceStore* store = mik__device_store();
    if (!store) {
        mik__proto_drain(transport, payload_len);
        mik__proto_send_err(transport, "no key store on this device");
        return true;
    }
    /* A store may leave out the hooks it cannot back. */
    if ((cmd_type == MIK_CMD_CONFIG_SET && !store->env_set) ||
        (cmd_type == MIK_CMD_CONFIG_DELETE && !store->env_delete) ||
        (cmd_type == MIK_CMD_KV_SET && !store->kv_set) ||
        (cmd_type == MIK_CMD_KV_DELETE && !store->kv_delete)) {
        mik__proto_drain(transport, payload_len);
        mik__proto_send_err(transport, "not supported on this device");
        return true;
    }
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
            if (store->env_set(key, value, flags & MIK_ENV_FLAG_SECRET, &changed)) {
                uint8_t byte = changed ? 1 : 0;
                mik__proto_send(transport, MIK_MSG_OK, &byte, 1);
            } else {
                mik__proto_send_err(transport, "env write failed");
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

            uint8_t byte = store->env_delete(key) ? 1 : 0;
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

            /* Sized to carry a 4 KiB config document plus its {version, doc}
             * envelope (a config seed is the largest value this path sees);
             * mirrored as KV_VALUE_MAX_BYTES in the CLI/sim protocol — keep
             * the two in sync. Heap, not stack: the value and its CBOR blob
             * together would not fit a task stack. */
            constexpr uint32_t kValueMax = 4608;
            if (val_len >= kValueMax || consumed + (uint32_t)val_len > payload_len) {
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "value too long");
                return true;
            }
            char* value = (char*)malloc((size_t)val_len + 1);
            uint8_t* blob = (uint8_t*)malloc((size_t)val_len + 8);
            if (value == NULL || blob == NULL) {
                free(value);
                free(blob);
                mik__proto_drain(transport, payload_len - consumed);
                mik__proto_send_err(transport, "out of memory");
                return true;
            }
            if (!mik__proto_read_exact(transport, value, val_len)) {
                free(value);
                free(blob);
                return false;
            }
            value[val_len] = '\0';
            consumed += val_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            if (key_len == 0 || key_len > 15) {
                free(value);
                free(blob);
                mik__proto_send_err(transport, "key exceeds NVS 15-char limit");
                return true;
            }

            nanocbor_encoder_t enc;
            nanocbor_encoder_init(&enc, blob, (size_t)val_len + 8);
            if (nanocbor_put_tstrn(&enc, value, val_len) < 0) {
                free(value);
                free(blob);
                mik__proto_send_err(transport, "cbor encode failed");
                return true;
            }
            size_t blob_len = nanocbor_encoded_len(&enc);

            bool ok = store->kv_set(ns == 1 ? "mik.sys" : "mik.kv", key, blob, blob_len);
            free(value);
            free(blob);
            if (ok) {
                mik__proto_send_ok(transport);
            } else {
                mik__proto_send_err(transport, "kv write failed");
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

            int existed = store->kv_delete(ns == 1 ? "mik.sys" : "mik.kv", key);
            if (existed < 0) {
                mik__proto_send_err(transport, "kv delete failed");
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

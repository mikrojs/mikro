#include <stdio.h>

#include <esp_app_desc.h>

#include "mikrojs/device_store.h"
#include "mikrojs_esp32.h"
#include "nvs.h"

/* The deploy and config handlers' storage on the ESP32: LittleFS at /appfs,
 * env vars and kv seeds in NVS. */

static const char* esp_firmware_hash(void) {
    static char hash[65];
    if (hash[0] == '\0') {
        const esp_app_desc_t* desc = esp_app_get_description();
        for (int i = 0; i < 32; i++) {
            snprintf(hash + i * 2, 3, "%02x", desc->app_elf_sha256[i]);
        }
    }
    return hash;
}

static void esp_env_each(MIKEnvEachFn fn, void* ud) {
    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_ENV, NVS_READONLY, &handle) != ESP_OK) return;
    nvs_iterator_t it = NULL;
    esp_err_t err = nvs_entry_find_in_handle(handle, NVS_TYPE_STR, &it);
    while (err == ESP_OK && it != NULL) {
        nvs_entry_info_t info;
        nvs_entry_info(it, &info);
        /* A secret's value is not read: it never leaves the device. */
        bool secret = mik__nvs_is_secret(info.key);
        char buf[512];
        size_t len = sizeof(buf);
        bool have = !secret && nvs_get_str(handle, info.key, buf, &len) == ESP_OK;
        fn(info.key, have ? buf : nullptr, secret, ud);
        err = nvs_entry_next(&it);
    }
    nvs_release_iterator(it);
    nvs_close(handle);
}

static bool esp_kv_set(const char* ns, const char* key, const uint8_t* blob, size_t len) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_set_blob(handle, key, blob, len);
        if (err == ESP_OK) err = nvs_commit(handle);
        nvs_close(handle);
    }
    return err == ESP_OK;
}

static int esp_kv_delete(const char* ns, const char* key) {
    bool existed = false;
    esp_err_t err = ESP_FAIL;
    nvs_handle_t handle;
    if (nvs_open(ns, NVS_READWRITE, &handle) == ESP_OK) {
        size_t len = 0;
        existed = nvs_get_blob(handle, key, nullptr, &len) == ESP_OK;
        err = nvs_erase_key(handle, key);
        /* Deleting a key that was never there is a successful no-op. */
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
        if (err == ESP_OK) err = nvs_commit(handle);
        nvs_close(handle);
    }
    if (err != ESP_OK) return -1;
    return existed ? 1 : 0;
}

/* Absence is the only silent outcome: a missing namespace (nothing ever stored)
 * or a missing key reads as absent. Every other failure is an error, so a read
 * starved by heap pressure (nvs_open allocates its handle) is never mistaken
 * for "not stored". Same rule as native:mikro/nvs_kv's get. */
static MIKOtaKvStatus esp_kv_get(const char* ns, const char* key, uint8_t* out, size_t* inout_len) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(ns, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) return MIK_OTA_KV_ABSENT;
    if (err != ESP_OK) return MIK_OTA_KV_ERROR;

    size_t len = 0;
    err = nvs_get_blob(h, key, nullptr, &len);
    if (err == ESP_ERR_NVS_NOT_FOUND || (err == ESP_OK && len == 0)) {
        nvs_close(h);
        return MIK_OTA_KV_ABSENT;
    }
    if (err != ESP_OK) {
        nvs_close(h);
        return MIK_OTA_KV_ERROR;
    }
    if (!out) {
        *inout_len = len;
        nvs_close(h);
        return MIK_OTA_KV_OK;
    }
    if (*inout_len < len) {
        nvs_close(h);
        return MIK_OTA_KV_ERROR;
    }
    err = nvs_get_blob(h, key, out, &len);
    nvs_close(h);
    if (err != ESP_OK) return MIK_OTA_KV_ERROR;
    *inout_len = len;
    return MIK_OTA_KV_OK;
}

/* OTA install state: the mik.ota namespace with NVS's own types, which is how
 * devices in the field already store it. The handle is offset by one so it is
 * never NULL, which state_open returns for failure. */
static constexpr const char* kOtaNs = "mik.ota";

static nvs_handle_t ota_handle(void* h) {
    return static_cast<nvs_handle_t>(reinterpret_cast<uintptr_t>(h) - 1);
}

static void* esp_state_open(bool writable) {
    nvs_handle_t h;
    if (nvs_open(kOtaNs, writable ? NVS_READWRITE : NVS_READONLY, &h) != ESP_OK) return nullptr;
    return reinterpret_cast<void*>(static_cast<uintptr_t>(h) + 1);
}

static void esp_state_close(void* h) { nvs_close(ota_handle(h)); }
static bool esp_state_commit(void* h) { return nvs_commit(ota_handle(h)) == ESP_OK; }

static bool esp_state_get_u8(void* h, const char* key, uint8_t* out) {
    return nvs_get_u8(ota_handle(h), key, out) == ESP_OK;
}

static bool esp_state_set_u8(void* h, const char* key, uint8_t value) {
    return nvs_set_u8(ota_handle(h), key, value) == ESP_OK;
}

static bool esp_state_get_u32(void* h, const char* key, uint32_t* out) {
    return nvs_get_u32(ota_handle(h), key, out) == ESP_OK;
}

static bool esp_state_set_u32(void* h, const char* key, uint32_t value) {
    return nvs_set_u32(ota_handle(h), key, value) == ESP_OK;
}

static bool esp_state_get_str(void* h, const char* key, char* out, size_t cap) {
    size_t len = cap;
    if (nvs_get_str(ota_handle(h), key, out, &len) != ESP_OK || len == 0) {
        out[0] = '\0';
        return false;
    }
    return out[0] != '\0';
}

static bool esp_state_set_str(void* h, const char* key, const char* value) {
    return nvs_set_str(ota_handle(h), key, value) == ESP_OK;
}

static void esp_state_erase(void* h, const char* key) { nvs_erase_key(ota_handle(h), key); }

const MIKDeviceStore MIK_Esp32DeviceStore = {
    .fs_base = "/appfs",
    .firmware_hash = esp_firmware_hash,
    .stage_build = MIK_OtaStageAdopt,
    .env_each = esp_env_each,
    .env_set = mik__nvs_env_set,
    .env_delete = mik__nvs_env_delete,
    .kv_set = esp_kv_set,
    .kv_delete = esp_kv_delete,
    .kv_get = esp_kv_get,
    .state_open = esp_state_open,
    .state_close = esp_state_close,
    .state_commit = esp_state_commit,
    .state_get_u8 = esp_state_get_u8,
    .state_set_u8 = esp_state_set_u8,
    .state_get_u32 = esp_state_get_u32,
    .state_set_u32 = esp_state_set_u32,
    .state_get_str = esp_state_get_str,
    .state_set_str = esp_state_set_str,
    .state_erase = esp_state_erase,
};

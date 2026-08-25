/**
 * MIKOtaEnv for ESP-IDF: the platform side of the native OTA client.
 *
 * Every seam here is deliberately thin. The parts that are easy to get subtly
 * wrong — how a mik.sys value is encoded, how the device-name pair is spelled —
 * live in the portable library behind host tests (mikrojs/sys_codec.h), because
 * getting them wrong means the C and JS implementations disagree about live
 * device state in a way no compile catches.
 */

#include <esp_app_desc.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <nvs.h>

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "mik_http_internal.h"
#include "mik_ota_native.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/platform.h"
#include "mikrojs/sys_codec.h"

#define MIK_OTA_ENV_TAG "native:mikro/ota_client"
#define MIK_OTA_SYS_NS "mik.sys"

namespace {

/* One env per runtime. The OTA client is a singleton within a runtime (one
 * check-in loop per device), so a file-scope record is the whole lifetime story. */
struct EnvState {
    MIKOtaEnv env;
    MIKRuntime* rt;
    int bytecode_version;
    /* The device id string the platform owns; copied so identity() can hand back
     * a fixed-size field without worrying about the platform's lifetime. */
    char device_id[64];
};

EnvState g_state = {};

// ── kv (mik.sys) ─────────────────────────────────────────────────────────────
// Values are the CBOR encoding of the value itself, exactly as
// native:mikro/nvs_kv writes them, so `ota.tries` means the same thing whether
// the C policy or the JS one reads it.

/* Absence is the only silent outcome: a missing namespace (nothing ever stored)
 * or a missing key reads as absent. Every other failure is an error, so a read
 * starved by heap pressure — nvs_open allocates its handle — is never mistaken
 * for "not stored". Same rule as native:mikro/nvs_kv's get. */
MIKOtaKvStatus kv_read_blob(const char* key, uint8_t* out, size_t* inout_len) {
    nvs_handle_t h;
    esp_err_t err = nvs_open(MIK_OTA_SYS_NS, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) return MIK_OTA_KV_ABSENT;
    if (err != ESP_OK) return MIK_OTA_KV_ERROR;

    size_t len = 0;
    err = nvs_get_blob(h, key, nullptr, &len);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(h);
        return MIK_OTA_KV_ABSENT;
    }
    if (err != ESP_OK) {
        nvs_close(h);
        return MIK_OTA_KV_ERROR;
    }
    if (len == 0) {
        nvs_close(h);
        return MIK_OTA_KV_ABSENT;
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

bool kv_write_blob(const char* key, const uint8_t* data, size_t len) {
    nvs_handle_t h;
    if (nvs_open(MIK_OTA_SYS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_set_blob(h, key, data, len);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK;
}

MIKOtaKvStatus env_kv_get_blob(void*, const char* key, uint8_t* out, size_t* inout_len) {
    return kv_read_blob(key, out, inout_len);
}

bool env_kv_set_blob(void*, const char* key, const uint8_t* data, size_t len) {
    return kv_write_blob(key, data, len);
}

bool env_kv_get_str(void*, const char* key, char* out, size_t max_len) {
    uint8_t buf[320];
    size_t len = sizeof(buf);
    if (kv_read_blob(key, buf, &len) != MIK_OTA_KV_OK) return false;
    return mik__kv_decode_str(buf, len, out, max_len);
}

bool env_kv_set_str(void*, const char* key, const char* value) {
    uint8_t buf[320];
    size_t needed = mik__kv_encode_str(value, buf, sizeof(buf));
    if (needed > sizeof(buf)) return false;
    return kv_write_blob(key, buf, needed);
}

bool env_kv_get_i32(void*, const char* key, int32_t* out) {
    uint8_t buf[16];
    size_t len = sizeof(buf);
    if (kv_read_blob(key, buf, &len) != MIK_OTA_KV_OK) return false;
    return mik__kv_decode_i32(buf, len, out);
}

bool env_kv_set_i32(void*, const char* key, int32_t value) {
    uint8_t buf[16];
    size_t needed = mik__kv_encode_i32(value, buf, sizeof(buf));
    if (needed > sizeof(buf)) return false;
    return kv_write_blob(key, buf, needed);
}

bool env_kv_remove(void*, const char* key) {
    nvs_handle_t h;
    if (nvs_open(MIK_OTA_SYS_NS, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_erase_key(h, key);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    /* A key that was never there is not a failure: the client removes slots
     * unconditionally. */
    return err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
// Borrowed from native:mikro/http: its task, TLS setup, inflight ceiling and
// chunk budget. A second esp_http_client path would double the handshake heap
// spike this device has the least of.

void* env_http_request(void* opaque, const MIKOtaHttpRequest* req,
                       const MIKOtaHttpCallbacks* cbs) {
    auto* state = static_cast<EnvState*>(opaque);
    MIKHttpNativeRequest spec = {};
    spec.url = req->url;
    spec.method = req->method;
    spec.header_keys = req->header_keys;
    spec.header_values = req->header_values;
    spec.header_count = req->header_count;
    spec.body = req->body;
    spec.body_len = req->body_len;
    spec.timeout_ms = req->timeout_ms;

    MIKHttpNativeSink sink = {};
    sink.headers = cbs->headers;
    sink.data = cbs->data;
    sink.done = cbs->done;
    sink.user_data = cbs->user_data;

    uint32_t id = mik__http_start_native(state->rt, &spec, &sink);
    if (id == 0) return nullptr;
    /* The handle is the id, offset so it is never NULL for id 0's sake. */
    return reinterpret_cast<void*>(static_cast<uintptr_t>(id));
}

void env_http_cancel(void* opaque, void* handle) {
    auto* state = static_cast<EnvState*>(opaque);
    mik__http_cancel_native(state->rt, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(handle)));
}

// ── identity and system ──────────────────────────────────────────────────────

bool env_identity(void* opaque, MIKDeviceIdentity* out) {
    auto* state = static_cast<EnvState*>(opaque);
    if (!out) return false;
    *out = {};
    snprintf(out->device_id, sizeof(out->device_id), "%s", state->device_id);
#ifdef MIK_FW_VERSION
    snprintf(out->firmware_version, sizeof(out->firmware_version), "%s", MIK_FW_VERSION);
#else
    snprintf(out->firmware_version, sizeof(out->firmware_version), "0.0.0-dev");
#endif
    const esp_app_desc_t* desc = esp_app_get_description();
    for (int i = 0; i < 32; i++) {
        snprintf(out->firmware_hash + i * 2, 3, "%02x", desc->app_elf_sha256[i]);
    }
    out->bytecode_version = state->bytecode_version;
    return true;
}

bool env_storage_free(void*, size_t* out) {
    const MIKPlatform* platform = MIK_GetPlatform();
    size_t total = 0;
    size_t used = 0;
    if (!platform->get_fs_info || !platform->get_fs_info("user", &total, &used)) return false;
    if (out) *out = total > used ? total - used : 0;
    return true;
}

bool env_get_device_name(void*, int* out_rev, char* out_name, size_t name_len) {
    const MIKPlatform* platform = MIK_GetPlatform();
    const char* stored = platform->get_device_name ? platform->get_device_name() : nullptr;
    if (!stored) return false;
    /* A pair that will not parse reads as never named, matching the JS reader. */
    return mik__device_name_parse(stored, out_rev, out_name, name_len);
}

void env_set_device_name(void*, int rev, const char* name) {
    const MIKPlatform* platform = MIK_GetPlatform();
    if (!platform->set_device_name) return;
    char text[160];
    size_t needed = mik__device_name_format(rev, name, text, sizeof(text));
    if (needed >= sizeof(text)) return;  /* an absurd name: leave the pair alone */
    platform->set_device_name(text);
}

void env_restart(void*) {
    const MIKPlatform* platform = MIK_GetPlatform();
    if (platform->restart) platform->restart();
}

int64_t env_monotonic_ms(void*) { return esp_timer_get_time() / 1000; }

double env_random_fraction(void*) {
    /* esp_random is uniform over the full 32-bit range; scale to [0, 1). */
    return static_cast<double>(esp_random()) / 4294967296.0;
}

void env_log(void*, int level, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    char buf[320];
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    switch (level) {
        case MIK_LOG_ERROR:
            ESP_LOGE(MIK_OTA_ENV_TAG, "%s", buf);
            break;
        case MIK_LOG_WARN:
            ESP_LOGW(MIK_OTA_ENV_TAG, "%s", buf);
            break;
        case MIK_LOG_DEBUG:
            ESP_LOGD(MIK_OTA_ENV_TAG, "%s", buf);
            break;
        default:
            ESP_LOGI(MIK_OTA_ENV_TAG, "%s", buf);
            break;
    }
}

/* Join a JS-level app path onto the runtime's fs base, the way the fs layer
 * does for `readFile('/app/...')`. */
void resolve_app_path(EnvState* state, const char* leaf, char* out, size_t out_len) {
    const char* root = state && state->rt
                           ? (state->rt->fs_root ? state->rt->fs_root : state->rt->fs_base_path)
                           : nullptr;
    snprintf(out, out_len, "%s%s", root ? root : "", leaf);
}

char* env_read_manifest(void* opaque) {
    auto* state = static_cast<EnvState*>(opaque);
    char path[128];
    resolve_app_path(state, "/app/mikro.app.json", path, sizeof(path));
    FILE* f = fopen(path, "r");
    if (!f) return nullptr;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    /* A manifest is a few hundred bytes of metadata plus whatever configDefaults
     * carries. The bound is generous but present: this is read into RAM. */
    if (size <= 0 || size > 8192) {
        fclose(f);
        return nullptr;
    }
    rewind(f);
    char* text = static_cast<char*>(malloc(static_cast<size_t>(size) + 1));
    if (!text) {
        fclose(f);
        return nullptr;
    }
    size_t read = fread(text, 1, static_cast<size_t>(size), f);
    fclose(f);
    text[read] = '\0';
    return text;
}

bool env_read_app_version(void* opaque, char* out, size_t out_len) {
    auto* state = static_cast<EnvState*>(opaque);
    /* The live app version, the same file `ota.ts` reads as /app/package.json.
     * That is a JS-level path: the fs layer joins it onto the runtime's base
     * path, so reaching it from C means joining it here too. Read with stdio
     * rather than through the JS fs layer, because the client runs from C and
     * must not need a JSContext for a report field. */
    char path[128];
    resolve_app_path(state, "/app/package.json", path, sizeof(path));
    FILE* f = fopen(path, "r");
    if (!f) return false;
    /* First 511 bytes only: enough for the small package.json a packed app
     * carries. A "version" key past that, or a nested one before the top-level
     * key, misreports; keep version near the top of package.json. */
    char buf[512];
    size_t read = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[read] = '\0';

    /* Minimal scan for the top-level "version" string. A full JSON parse would
     * mean pulling one in for a single field. */
    const char* key = strstr(buf, "\"version\"");
    if (!key) return false;
    const char* colon = strchr(key, ':');
    if (!colon) return false;
    const char* quote = strchr(colon, '"');
    if (!quote) return false;
    const char* end = strchr(quote + 1, '"');
    if (!end) return false;
    size_t len = static_cast<size_t>(end - quote - 1);
    if (len == 0 || len + 1 > out_len) return false;
    memcpy(out, quote + 1, len);
    out[len] = '\0';
    return true;
}

}  // namespace

const MIKOtaEnv* mik__ota_env_for(MIKRuntime* rt, int bytecode_version) {
    g_state.rt = rt;
    g_state.bytecode_version = bytecode_version;
    const MIKPlatform* platform = MIK_GetPlatform();
    const char* id = platform->get_device_id ? platform->get_device_id() : nullptr;
    snprintf(g_state.device_id, sizeof(g_state.device_id), "%s", id ? id : "");

    MIKOtaEnv& env = g_state.env;
    env = {};
    env.opaque = &g_state;

    env.http_request = env_http_request;
    env.http_cancel = env_http_cancel;

    env.kv_get_blob = env_kv_get_blob;
    env.kv_set_blob = env_kv_set_blob;
    env.kv_get_str = env_kv_get_str;
    env.kv_set_str = env_kv_set_str;
    env.kv_get_i32 = env_kv_get_i32;
    env.kv_set_i32 = env_kv_set_i32;
    env.kv_remove = env_kv_remove;

    mik__ota_fill_install_ops(&env);

    env.identity = env_identity;
    env.storage_free = env_storage_free;
    env.get_device_name = env_get_device_name;
    env.set_device_name = env_set_device_name;
    env.restart = env_restart;
    env.monotonic_ms = env_monotonic_ms;
    env.random_fraction = env_random_fraction;
    env.log = env_log;
    env.read_app_version = env_read_app_version;
    env.read_manifest = env_read_manifest;
    return &env;
}

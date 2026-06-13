#include <cstring>
#include <vector>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "nvs_flash.h"
#include "mikrojs/platform.h"
#include "private.h"
#include "utils.h"

/* Dynamic module data slot, allocated on first import */
static int mik__wifi_slot = -1;

/* Helper to access WiFi state from runtime module_data slot */
static inline MIKWifiState*& mik__wifi_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKWifiState*&>(rt->module_data[mik__wifi_slot]);
}

#define MIK_WIFI_TAG "native:mikro/wifi"
#define MIK_WIFI_MAX_SCAN_RESULTS 20
#define MIK_WIFI_MAX_AP_STATIONS 4

// Create a JS string from raw SSID bytes, replacing invalid UTF-8 sequences with U+FFFD.
// SSIDs are up to 32 bytes of arbitrary data per IEEE 802.11; they are not required to be UTF-8.
static JSValue mik__new_string_from_ssid(JSContext* ctx, const uint8_t* ssid, size_t max_len) {
    size_t len = strnlen(reinterpret_cast<const char*>(ssid), max_len);
    // Worst case: every byte is invalid and replaced with 3-byte U+FFFD
    char buf[32 * 3 + 1];
    size_t out = 0;

    for (size_t i = 0; i < len;) {
        uint8_t b = ssid[i];
        size_t seq_len = 0;

        if (b < 0x80) {
            seq_len = 1;
        } else if ((b & 0xE0) == 0xC0) {
            seq_len = 2;
        } else if ((b & 0xF0) == 0xE0) {
            seq_len = 3;
        } else if ((b & 0xF8) == 0xF0) {
            seq_len = 4;
        }

        bool valid = seq_len > 0 && i + seq_len <= len;
        if (valid) {
            // Verify continuation bytes
            for (size_t j = 1; j < seq_len; j++) {
                if ((ssid[i + j] & 0xC0) != 0x80) {
                    valid = false;
                    break;
                }
            }
        }
        // Reject overlong encodings and surrogates
        if (valid && seq_len == 2 && b < 0xC2) valid = false;
        if (valid && seq_len == 3) {
            uint32_t cp = ((b & 0x0F) << 12) | ((ssid[i + 1] & 0x3F) << 6) | (ssid[i + 2] & 0x3F);
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) valid = false;
        }
        if (valid && seq_len == 4) {
            uint32_t cp = ((b & 0x07) << 18) | ((ssid[i + 1] & 0x3F) << 12) |
                          ((ssid[i + 2] & 0x3F) << 6) | (ssid[i + 3] & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) valid = false;
        }

        if (valid) {
            memcpy(buf + out, ssid + i, seq_len);
            out += seq_len;
            i += seq_len;
        } else {
            // U+FFFD replacement character (0xEF 0xBF 0xBD)
            buf[out++] = '\xEF';
            buf[out++] = '\xBF';
            buf[out++] = '\xBD';
            i++;
        }
    }

    return JS_NewStringLen(ctx, buf, out);
}

/* ── WiFi status codes (must match JS WifiStatusCodes) ─────────────── */
enum MIKWifiStatus : uint8_t {
    MIK_WIFI_IDLE = 0,
    MIK_WIFI_NO_SSID_AVAIL = 1,
    MIK_WIFI_SCAN_COMPLETED = 2,
    MIK_WIFI_CONNECTED = 3,
    MIK_WIFI_CONNECT_FAILED = 4,
    MIK_WIFI_CONNECTION_LOST = 5,
    MIK_WIFI_DISCONNECTED = 6,
    MIK_WIFI_STOPPED = 254,
};

/* ── WiFi event types for the FreeRTOS queue ───────────────────────── */
enum MIKWifiEventType : uint8_t {
    MIK_WIFI_EVT_STATUS_CHANGE = 0,
    MIK_WIFI_EVT_GOT_IP = 1,
    MIK_WIFI_EVT_SCAN_DONE = 2,
    MIK_WIFI_EVT_AP_STA_CONNECTED = 3,
    MIK_WIFI_EVT_AP_STA_DISCONNECTED = 4,
    MIK_WIFI_EVT_RSSI_LOW = 5,
};

struct MIKWifiEvent {
    MIKWifiEventType type;
    MIKWifiStatus status;
    union {
        esp_netif_ip_info_t ip_info;        // GOT_IP
        uint8_t mac[6];                      // AP_STA_CONNECTED / AP_STA_DISCONNECTED
        int32_t rssi;                        // RSSI_LOW
    };
};

/* ── WiFi state (attached to MIKRuntime) ───────────────────────────── */

struct MIKWifiState {
    QueueHandle_t event_queue;
    MIKPromise connect_promise;
    bool connect_pending;
    MIKPromise scan_promise;
    bool scan_pending;
    // JS event listeners
    std::vector<JSValue> on_connect;
    std::vector<JSValue> on_disconnect;
    std::vector<JSValue> on_ap_sta_connect;
    std::vector<JSValue> on_ap_sta_disconnect;
    std::vector<JSValue> on_rssi_low;
    int32_t rssi_threshold;
};

/* ── Global WiFi state (singleton — only one STA on ESP32) ─────────── */

static bool s_wifi_initialized = false;
static bool s_wifi_started = false;
static bool s_country_configured = false;
static esp_netif_t* s_sta_netif = nullptr;
static esp_netif_t* s_ap_netif = nullptr;
static volatile MIKWifiStatus s_wifi_status = MIK_WIFI_STOPPED;
static QueueHandle_t s_event_queue = nullptr;

static void mik__format_mac(char* buf, size_t buf_len, const uint8_t* mac) {
    snprintf(buf, buf_len, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4],
             mac[5]);
}

static bool mik__parse_mac(const char* str, uint8_t* mac) {
    unsigned int m[6];
    if (sscanf(str, "%02X:%02X:%02X:%02X:%02X:%02X", &m[0], &m[1], &m[2], &m[3], &m[4], &m[5]) !=
        6) {
        return false;
    }
    for (int i = 0; i < 6; i++) {
        mac[i] = static_cast<uint8_t>(m[i]);
    }
    return true;
}

static void mik__wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id,
                                    void* event_data) {
    MIKWifiEvent evt = {};

    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                s_wifi_status = MIK_WIFI_IDLE;
                evt.type = MIK_WIFI_EVT_STATUS_CHANGE;
                evt.status = MIK_WIFI_IDLE;
                break;
            case WIFI_EVENT_STA_STOP:
                s_wifi_status = MIK_WIFI_STOPPED;
                evt.type = MIK_WIFI_EVT_STATUS_CHANGE;
                evt.status = MIK_WIFI_STOPPED;
                break;
            case WIFI_EVENT_STA_CONNECTED:
                s_wifi_status = MIK_WIFI_CONNECTED;
                evt.type = MIK_WIFI_EVT_STATUS_CHANGE;
                evt.status = MIK_WIFI_CONNECTED;
                break;
            case WIFI_EVENT_STA_DISCONNECTED: {
                auto* info = static_cast<wifi_event_sta_disconnected_t*>(event_data);
                evt.type = MIK_WIFI_EVT_STATUS_CHANGE;
                switch (info->reason) {
                    case WIFI_REASON_NO_AP_FOUND:
                    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
                    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
                        s_wifi_status = MIK_WIFI_NO_SSID_AVAIL;
                        evt.status = MIK_WIFI_NO_SSID_AVAIL;
                        break;
                    case WIFI_REASON_AUTH_FAIL:
                    case WIFI_REASON_HANDSHAKE_TIMEOUT:
                    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
                    case WIFI_REASON_CONNECTION_FAIL:
                        s_wifi_status = MIK_WIFI_CONNECT_FAILED;
                        evt.status = MIK_WIFI_CONNECT_FAILED;
                        break;
                    case WIFI_REASON_ASSOC_LEAVE:
                    case WIFI_REASON_BEACON_TIMEOUT:
                        s_wifi_status = MIK_WIFI_CONNECTION_LOST;
                        evt.status = MIK_WIFI_CONNECTION_LOST;
                        break;
                    default:
                        s_wifi_status = MIK_WIFI_DISCONNECTED;
                        evt.status = MIK_WIFI_DISCONNECTED;
                        break;
                }
                break;
            }
            case WIFI_EVENT_SCAN_DONE:
                s_wifi_status = MIK_WIFI_SCAN_COMPLETED;
                evt.type = MIK_WIFI_EVT_SCAN_DONE;
                evt.status = MIK_WIFI_SCAN_COMPLETED;
                break;
            case WIFI_EVENT_AP_STACONNECTED: {
                auto* info = static_cast<wifi_event_ap_staconnected_t*>(event_data);
                evt.type = MIK_WIFI_EVT_AP_STA_CONNECTED;
                memcpy(evt.mac, info->mac, 6);
                break;
            }
            case WIFI_EVENT_AP_STADISCONNECTED: {
                auto* info = static_cast<wifi_event_ap_stadisconnected_t*>(event_data);
                evt.type = MIK_WIFI_EVT_AP_STA_DISCONNECTED;
                memcpy(evt.mac, info->mac, 6);
                break;
            }
            case WIFI_EVENT_STA_BSS_RSSI_LOW: {
                auto* info = static_cast<wifi_event_bss_rssi_low_t*>(event_data);
                evt.type = MIK_WIFI_EVT_RSSI_LOW;
                evt.rssi = info->rssi;
                break;
            }
            default:
                return;  // no event to post
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        s_wifi_status = MIK_WIFI_CONNECTED;
        evt.type = MIK_WIFI_EVT_GOT_IP;
        evt.status = MIK_WIFI_CONNECTED;
        auto* ip_event = static_cast<ip_event_got_ip_t*>(event_data);
        evt.ip_info = ip_event->ip_info;
    } else {
        return;
    }

    if (s_event_queue) {
        xQueueSend(s_event_queue, &evt, 0);
    }
}

/* Pick the DHCP hostname for the STA netif: configured `wifi.hostname` from
 * mikro.config.json takes priority; otherwise default to `mikrojs-<device-id>`.
 * Returns true if a hostname was applied. */
static bool mik__wifi_apply_hostname(JSContext* ctx) {
    if (!s_sta_netif) return false;
    char buf[64];
    const char* hostname = nullptr;
    if (ctx) {
        MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
        if (mik_rt && mik_rt->config.wifi_hostname[0] != '\0') {
            hostname = mik_rt->config.wifi_hostname;
        }
    }
    if (!hostname) {
        const char* dev_id = MIK_GetPlatform()->get_device_id();
        if (!dev_id || !dev_id[0]) return false;
        snprintf(buf, sizeof(buf), "mikrojs-%s", dev_id);
        hostname = buf;
    }
    return esp_netif_set_hostname(s_sta_netif, hostname) == ESP_OK;
}

esp_err_t mik__wifi_ensure_initialized(JSContext* ctx) {
    if (s_wifi_initialized) return ESP_OK;

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) return err;

    err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    /* If a previous attempt created the netif but later steps failed,
     * reuse the existing one instead of creating a second default and
     * asserting in esp_netif_create_default_wifi_sta. */
    if (!s_sta_netif) {
        s_sta_netif = esp_netif_create_default_wifi_sta();
        if (s_sta_netif) mik__wifi_apply_hostname(ctx);
    }
    if (!s_sta_netif) return ESP_FAIL;

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) {
        /* Undo the netif creation so the next retry starts from a clean
         * state (or a subsequent destroy can clean up predictably). */
        esp_netif_destroy_default_wifi(s_sta_netif);
        s_sta_netif = nullptr;
        return err;
    }

    err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                              mik__wifi_event_handler, nullptr, nullptr);
    if (err != ESP_OK) goto fail_after_init;

    err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                              mik__wifi_event_handler, nullptr, nullptr);
    if (err != ESP_OK) goto fail_after_init;

    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) goto fail_after_init;

    s_wifi_initialized = true;
    return ESP_OK;

fail_after_init:
    esp_event_handler_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, mik__wifi_event_handler);
    esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, mik__wifi_event_handler);
    esp_wifi_deinit();
    esp_netif_destroy_default_wifi(s_sta_netif);
    s_sta_netif = nullptr;
    return err;
}

/* Minimum free internal (DMA-capable) RAM required before bringing up the
 * radio. esp_wifi_start() enables the PHY, which calloc()s its RF
 * calibration data from internal RAM and calls abort() on failure
 * (esp_phy/src/phy_init.c: "failed to allocate memory for RF calibration
 * data"). That hard-abort reboots the device instead of surfacing a
 * catchable error, so we pre-flight the heap here and refuse gracefully
 * when it's too low. The figure covers the PHY cal buffers plus the WiFi
 * driver's start-time internal allocations with margin; it is a heuristic,
 * not an exact bound. Tune if a healthy device ever trips it. */
static constexpr size_t MIK_WIFI_MIN_INTERNAL_HEAP = 40 * 1024;

/* Start the WiFi radio.  Deferred from init so the radio is not active
 * until connect() or scan() is actually called. */
static esp_err_t mik__wifi_ensure_started(JSContext* ctx) {
    esp_err_t err = mik__wifi_ensure_initialized(ctx);
    if (err != ESP_OK) return err;
    if (s_wifi_started) return ESP_OK;

    /* Refuse to start under low internal RAM rather than let the PHY init
     * abort() the whole device. The caller turns ESP_ERR_NO_MEM into a
     * catchable StartFailed result. */
    if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL) < MIK_WIFI_MIN_INTERNAL_HEAP) {
        return ESP_ERR_NO_MEM;
    }

    err = esp_wifi_start();
    if (err != ESP_OK) return err;

    s_wifi_started = true;
    return ESP_OK;
}

/* ── Auth mode mapping ─────────────────────────────────────────────── */

static const char* mik__authmode_str(wifi_auth_mode_t mode) {
    switch (mode) {
        case WIFI_AUTH_OPEN:
            return "open";
        case WIFI_AUTH_WPA2_PSK:
            return "wpa2-psk";
        case WIFI_AUTH_WPA3_PSK:
            return "wpa3-psk";
        case WIFI_AUTH_WPA2_WPA3_PSK:
            return "wpa2-wpa3-psk";
        default:
            return "unknown";
    }
}

static wifi_auth_mode_t mik__authmode_from_str(const char* str) {
    if (!str || strcmp(str, "open") == 0) return WIFI_AUTH_OPEN;
    if (strcmp(str, "wpa2-psk") == 0) return WIFI_AUTH_WPA2_PSK;
    if (strcmp(str, "wpa3-psk") == 0) return WIFI_AUTH_WPA3_PSK;
    if (strcmp(str, "wpa2-wpa3-psk") == 0) return WIFI_AUTH_WPA2_WPA3_PSK;
    return WIFI_AUTH_WPA2_PSK;  // safe default
}

/* Try to auto-configure the WiFi country from mikro.config.json.
 * Returns true if country is configured (either already set or
 * successfully auto-configured from config). */
static bool mik__wifi_try_auto_country(JSContext* ctx) {
    if (s_country_configured) return true;

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik_rt || mik_rt->config.wifi_country[0] == '\0') return false;

    if (esp_wifi_set_country_code(mik_rt->config.wifi_country, true) != ESP_OK) return false;
    s_country_configured = true;
    return true;
}

/* ── JS class ──────────────────────────────────────────────────────── */

static JSClassID mik_wifi_class_id;

static JSClassDef mik_wifi_classdef = {
    .class_name = "Wifi",
    .finalizer = nullptr,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

static JSValue mik__wifi_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    esp_err_t err = mik__wifi_ensure_initialized(ctx);
    if (err != ESP_OK) {
        return JS_ThrowInternalError(ctx, "WiFi init failed: %s", esp_err_to_name(err));
    }
    return JS_NewObjectClass(ctx, mik_wifi_class_id);
}

static JSValue mik__wifi_connect(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!mik__wifi_try_auto_country(ctx)) {
        return mik__result_err_tag(ctx, "CountryNotSet");
    }

    esp_err_t start_err = mik__wifi_ensure_started(ctx);
    if (start_err != ESP_OK) {
        return mik__result_err_named(ctx, "StartFailed",
                               "Failed to start WiFi radio: %s", esp_err_to_name(start_err));
    }

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));

    if (mik__wifi_st(mik_rt)->connect_pending) {
        return mik__result_err_tag(ctx, "ConnectInProgress");
    }

    const char* ssid = JS_ToCString(ctx, argv[0]);
    if (!ssid) return JS_EXCEPTION;
    const char* pass = JS_ToCString(ctx, argv[1]);
    if (!pass) {
        JS_FreeCString(ctx, ssid);
        return JS_EXCEPTION;
    }

    wifi_config_t wifi_config = {};
    strncpy(reinterpret_cast<char*>(wifi_config.sta.ssid), ssid, sizeof(wifi_config.sta.ssid) - 1);
    strncpy(reinterpret_cast<char*>(wifi_config.sta.password), pass,
            sizeof(wifi_config.sta.password) - 1);

    JS_FreeCString(ctx, ssid);
    JS_FreeCString(ctx, pass);

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ConfigFailed",
                               "Failed to set WiFi STA config: %s", esp_err_to_name(err));
    }

    err = esp_wifi_connect();
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ConnectFailed",
                               "Failed to initiate WiFi connection: %s", esp_err_to_name(err));
    }

    // Create promise that will be resolved when GOT_IP or resolved with error on failure
    JSValue promise = MIK_InitPromise(ctx, &mik__wifi_st(mik_rt)->connect_promise);
    mik__wifi_st(mik_rt)->connect_pending = true;
    return mik__result_ok(ctx, promise);
}

static JSValue mik__wifi_disconnect(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    esp_err_t err = esp_wifi_disconnect();
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "DisconnectFailed",
                               "Failed to disconnect from WiFi: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__wifi_rssi(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    wifi_ap_record_t ap_info;
    esp_err_t err = esp_wifi_sta_get_ap_info(&ap_info);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get AP info for RSSI: %s", esp_err_to_name(err));
    }
    return mik__result_ok(ctx, JS_NewInt32(ctx, ap_info.rssi));
}

static JSValue mik__wifi_ip(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!s_sta_netif) {
        return JS_NewString(ctx, "0.0.0.0");
    }

    esp_netif_ip_info_t ip_info;
    esp_err_t err = esp_netif_get_ip_info(s_sta_netif, &ip_info);
    if (err != ESP_OK || ip_info.ip.addr == 0) {
        return JS_NewString(ctx, "0.0.0.0");
    }

    char ip_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&ip_info.ip));
    return JS_NewString(ctx, ip_str);
}

static JSValue mik__wifi_status(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    return JS_NewInt32(ctx, s_wifi_status);
}

static JSValue mik__wifi_scan(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!mik__wifi_try_auto_country(ctx)) {
        return mik__result_err_tag(ctx, "CountryNotSet");
    }

    esp_err_t start_err = mik__wifi_ensure_started(ctx);
    if (start_err != ESP_OK) {
        return mik__result_err_named(ctx, "StartFailed",
                               "Failed to start WiFi radio: %s", esp_err_to_name(start_err));
    }

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));

    if (mik__wifi_st(mik_rt)->scan_pending) {
        return mik__result_err_tag(ctx, "ScanInProgress");
    }

    wifi_scan_config_t scan_config = {};
    scan_config.show_hidden = true;

    // Parse optional scan filter options
    uint8_t ssid_buf[33] = {};
    if (argc > 0 && JS_IsObject(argv[0])) {
        JSValue opts = argv[0];

        JSValue ssid_val = JS_GetPropertyStr(ctx, opts, "ssid");
        if (JS_IsString(ssid_val)) {
            const char* ssid_str = JS_ToCString(ctx, ssid_val);
            if (ssid_str) {
                strncpy(reinterpret_cast<char*>(ssid_buf), ssid_str, sizeof(ssid_buf) - 1);
                scan_config.ssid = ssid_buf;
                JS_FreeCString(ctx, ssid_str);
            }
        }
        JS_FreeValue(ctx, ssid_val);

        JSValue ch_val = JS_GetPropertyStr(ctx, opts, "channel");
        if (JS_IsNumber(ch_val)) {
            int32_t ch;
            JS_ToInt32(ctx, &ch, ch_val);
            scan_config.channel = ch;
        }
        JS_FreeValue(ctx, ch_val);

        JSValue passive_val = JS_GetPropertyStr(ctx, opts, "passive");
        if (JS_ToBool(ctx, passive_val)) {
            scan_config.scan_type = WIFI_SCAN_TYPE_PASSIVE;
        }
        JS_FreeValue(ctx, passive_val);
    }

    esp_err_t err = esp_wifi_scan_start(&scan_config, false);  // non-blocking
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ScanFailed",
                               "Failed to start WiFi scan: %s", esp_err_to_name(err));
    }

    JSValue promise = MIK_InitPromise(ctx, &mik__wifi_st(mik_rt)->scan_promise);
    mik__wifi_st(mik_rt)->scan_pending = true;
    return mik__result_ok(ctx, promise);
}

static JSValue mik__wifi_on(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));

    const char* event_name = JS_ToCString(ctx, argv[0]);
    if (!event_name) return JS_EXCEPTION;

    JSValue func = argv[1];
    if (!JS_IsFunction(ctx, func)) {
        JS_FreeCString(ctx, event_name);
        return JS_ThrowTypeError(ctx, "expected argument 2 to be a function");
    }

    if (strcmp(event_name, "connect") == 0) {
        mik__wifi_st(mik_rt)->on_connect.push_back(JS_DupValue(ctx, func));
    } else if (strcmp(event_name, "disconnect") == 0) {
        mik__wifi_st(mik_rt)->on_disconnect.push_back(JS_DupValue(ctx, func));
    } else if (strcmp(event_name, "station-connect") == 0) {
        mik__wifi_st(mik_rt)->on_ap_sta_connect.push_back(JS_DupValue(ctx, func));
    } else if (strcmp(event_name, "station-disconnect") == 0) {
        mik__wifi_st(mik_rt)->on_ap_sta_disconnect.push_back(JS_DupValue(ctx, func));
    } else if (strcmp(event_name, "rssi-low") == 0) {
        mik__wifi_st(mik_rt)->on_rssi_low.push_back(JS_DupValue(ctx, func));
    }

    JS_FreeCString(ctx, event_name);
    return JS_UNDEFINED;
}

static JSValue mik__wifi_off(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));

    const char* event_name = JS_ToCString(ctx, argv[0]);
    if (!event_name) return JS_EXCEPTION;

    JSValue func = argv[1];
    std::vector<JSValue>* listeners = nullptr;

    if (strcmp(event_name, "connect") == 0) {
        listeners = &mik__wifi_st(mik_rt)->on_connect;
    } else if (strcmp(event_name, "disconnect") == 0) {
        listeners = &mik__wifi_st(mik_rt)->on_disconnect;
    } else if (strcmp(event_name, "station-connect") == 0) {
        listeners = &mik__wifi_st(mik_rt)->on_ap_sta_connect;
    } else if (strcmp(event_name, "station-disconnect") == 0) {
        listeners = &mik__wifi_st(mik_rt)->on_ap_sta_disconnect;
    } else if (strcmp(event_name, "rssi-low") == 0) {
        listeners = &mik__wifi_st(mik_rt)->on_rssi_low;
    }

    JS_FreeCString(ctx, event_name);

    if (listeners) {
        for (auto it = listeners->begin(); it != listeners->end(); ++it) {
            if (JS_IsSameValue(ctx, *it, func)) {
                JS_FreeValue(ctx, *it);
                listeners->erase(it);
                break;
            }
        }
    }

    return JS_UNDEFINED;
}

/* ── Phase 4: Network configuration ───────────────────────────────── */

static JSValue mik__wifi_mac(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    uint8_t mac[6];
    esp_err_t err = esp_wifi_get_mac(WIFI_IF_STA, mac);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get WiFi MAC address: %s", esp_err_to_name(err));
    }
    char mac_str[18];
    mik__format_mac(mac_str, sizeof(mac_str), mac);
    return mik__result_ok(ctx, JS_NewString(ctx, mac_str));
}

static JSValue mik__wifi_get_hostname(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!s_sta_netif) {
        return JS_UNDEFINED;
    }
    const char* hostname = nullptr;
    esp_err_t err = esp_netif_get_hostname(s_sta_netif, &hostname);
    if (err != ESP_OK || !hostname) {
        return JS_UNDEFINED;
    }
    return JS_NewString(ctx, hostname);
}

static JSValue mik__wifi_get_ip_config(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!s_sta_netif) {
        return JS_UNDEFINED;
    }

    esp_netif_ip_info_t ip_info;
    esp_err_t err = esp_netif_get_ip_info(s_sta_netif, &ip_info);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get IP configuration: %s", esp_err_to_name(err));
    }

    esp_netif_dns_info_t dns_info;
    esp_netif_get_dns_info(s_sta_netif, ESP_NETIF_DNS_MAIN, &dns_info);

    char ip_str[16], netmask_str[16], gw_str[16], dns_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&ip_info.ip));
    snprintf(netmask_str, sizeof(netmask_str), IPSTR, IP2STR(&ip_info.netmask));
    snprintf(gw_str, sizeof(gw_str), IPSTR, IP2STR(&ip_info.gw));
    snprintf(dns_str, sizeof(dns_str), IPSTR, IP2STR(&dns_info.ip.u_addr.ip4));

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "ip", JS_NewString(ctx, ip_str));
    JS_SetPropertyStr(ctx, obj, "netmask", JS_NewString(ctx, netmask_str));
    JS_SetPropertyStr(ctx, obj, "gateway", JS_NewString(ctx, gw_str));
    JS_SetPropertyStr(ctx, obj, "dns", JS_NewString(ctx, dns_str));
    return mik__result_ok(ctx, obj);
}

static JSValue mik__wifi_set_ip_config(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!s_sta_netif) {
        return mik__result_err_tag(ctx, "NotInitialized");
    }

    JSValue opts = argv[0];

    // Check for dhcp: true
    JSValue dhcp_val = JS_GetPropertyStr(ctx, opts, "dhcp");
    if (JS_ToBool(ctx, dhcp_val)) {
        JS_FreeValue(ctx, dhcp_val);
        esp_netif_dhcpc_start(s_sta_netif);
        return mik__result_ok_void(ctx);
    }
    JS_FreeValue(ctx, dhcp_val);

    // Stop DHCP before setting static IP
    esp_netif_dhcpc_stop(s_sta_netif);

    esp_netif_ip_info_t ip_info = {};

    JSValue ip_val = JS_GetPropertyStr(ctx, opts, "ip");
    JSValue netmask_val = JS_GetPropertyStr(ctx, opts, "netmask");
    JSValue gw_val = JS_GetPropertyStr(ctx, opts, "gateway");

    const char* ip_str = JS_ToCString(ctx, ip_val);
    const char* netmask_str = JS_ToCString(ctx, netmask_val);
    const char* gw_str = JS_ToCString(ctx, gw_val);

    if (ip_str) esp_netif_str_to_ip4(ip_str, &ip_info.ip);
    if (netmask_str) esp_netif_str_to_ip4(netmask_str, &ip_info.netmask);
    if (gw_str) esp_netif_str_to_ip4(gw_str, &ip_info.gw);

    if (ip_str) JS_FreeCString(ctx, ip_str);
    if (netmask_str) JS_FreeCString(ctx, netmask_str);
    if (gw_str) JS_FreeCString(ctx, gw_str);
    JS_FreeValue(ctx, ip_val);
    JS_FreeValue(ctx, netmask_val);
    JS_FreeValue(ctx, gw_val);

    esp_err_t err = esp_netif_set_ip_info(s_sta_netif, &ip_info);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set static IP configuration: %s", esp_err_to_name(err));
    }

    // Set DNS if provided
    JSValue dns_val = JS_GetPropertyStr(ctx, opts, "dns");
    if (JS_IsString(dns_val)) {
        const char* dns_str = JS_ToCString(ctx, dns_val);
        if (dns_str) {
            esp_netif_dns_info_t dns_info = {};
            esp_netif_str_to_ip4(dns_str, &dns_info.ip.u_addr.ip4);
            dns_info.ip.type = ESP_IPADDR_TYPE_V4;
            esp_netif_set_dns_info(s_sta_netif, ESP_NETIF_DNS_MAIN, &dns_info);
            JS_FreeCString(ctx, dns_str);
        }
    }
    JS_FreeValue(ctx, dns_val);

    return mik__result_ok_void(ctx);
}

/* ── Phase 5: Access Point mode ────────────────────────────────────── */

static JSValue mik__wifi_ap_start(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!mik__wifi_try_auto_country(ctx)) {
        return mik__result_err_tag(ctx, "CountryNotSet");
    }

    esp_err_t err = mik__wifi_ensure_started(ctx);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "StartFailed",
                               "Failed to start WiFi radio: %s", esp_err_to_name(err));
    }

    // Create AP netif if not already
    if (!s_ap_netif) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
        if (!s_ap_netif) {
            return mik__result_err_named(ctx, "ApStartFailed",
                                   "Failed to create AP network interface");
        }
    }

    // Switch to APSTA mode
    err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ApStartFailed",
                               "Failed to set APSTA mode: %s", esp_err_to_name(err));
    }

    JSValue opts = argv[0];
    wifi_config_t ap_config = {};

    // SSID (required)
    JSValue ssid_val = JS_GetPropertyStr(ctx, opts, "ssid");
    const char* ssid = JS_ToCString(ctx, ssid_val);
    if (!ssid) {
        JS_FreeValue(ctx, ssid_val);
        return JS_EXCEPTION;
    }
    strncpy(reinterpret_cast<char*>(ap_config.ap.ssid), ssid, sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(ssid);
    JS_FreeCString(ctx, ssid);
    JS_FreeValue(ctx, ssid_val);

    // Passphrase (optional — omit for open network)
    JSValue pass_val = JS_GetPropertyStr(ctx, opts, "passphrase");
    if (JS_IsString(pass_val)) {
        const char* pass = JS_ToCString(ctx, pass_val);
        if (pass && strlen(pass) > 0) {
            strncpy(reinterpret_cast<char*>(ap_config.ap.password), pass,
                    sizeof(ap_config.ap.password) - 1);
            ap_config.ap.authmode = WIFI_AUTH_WPA2_PSK;
        }
        if (pass) JS_FreeCString(ctx, pass);
    }
    JS_FreeValue(ctx, pass_val);

    // authMode override (optional)
    JSValue auth_val = JS_GetPropertyStr(ctx, opts, "authMode");
    if (JS_IsString(auth_val)) {
        const char* auth_str = JS_ToCString(ctx, auth_val);
        if (auth_str) {
            ap_config.ap.authmode = mik__authmode_from_str(auth_str);
            JS_FreeCString(ctx, auth_str);
        }
    }
    JS_FreeValue(ctx, auth_val);

    // Channel (optional, default 1)
    JSValue ch_val = JS_GetPropertyStr(ctx, opts, "channel");
    if (JS_IsNumber(ch_val)) {
        int32_t ch;
        JS_ToInt32(ctx, &ch, ch_val);
        ap_config.ap.channel = ch;
    } else {
        ap_config.ap.channel = 1;
    }
    JS_FreeValue(ctx, ch_val);

    // Hidden (optional)
    JSValue hidden_val = JS_GetPropertyStr(ctx, opts, "hidden");
    ap_config.ap.ssid_hidden = JS_ToBool(ctx, hidden_val);
    JS_FreeValue(ctx, hidden_val);

    // Max connections (optional, default 4)
    JSValue max_val = JS_GetPropertyStr(ctx, opts, "maxConnections");
    if (JS_IsNumber(max_val)) {
        int32_t max_conn;
        JS_ToInt32(ctx, &max_conn, max_val);
        ap_config.ap.max_connection = max_conn;
    } else {
        ap_config.ap.max_connection = MIK_WIFI_MAX_AP_STATIONS;
    }
    JS_FreeValue(ctx, max_val);

    err = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ConfigFailed",
                               "Failed to set WiFi AP config: %s", esp_err_to_name(err));
    }

    return mik__result_ok_void(ctx);
}

static JSValue mik__wifi_ap_stop(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    // Switch back to STA-only mode
    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "ApStopFailed",
                               "Failed to stop AP mode: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__wifi_ap_is_active(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    wifi_mode_t mode;
    esp_err_t err = esp_wifi_get_mode(&mode);
    if (err != ESP_OK) {
        return JS_FALSE;
    }
    return JS_NewBool(ctx, mode == WIFI_MODE_AP || mode == WIFI_MODE_APSTA);
}

static JSValue mik__wifi_ap_ip(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!s_ap_netif) {
        return JS_UNDEFINED;
    }

    esp_netif_ip_info_t ip_info;
    esp_err_t err = esp_netif_get_ip_info(s_ap_netif, &ip_info);
    if (err != ESP_OK || ip_info.ip.addr == 0) {
        return JS_UNDEFINED;
    }

    char ip_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&ip_info.ip));
    return JS_NewString(ctx, ip_str);
}

static JSValue mik__wifi_ap_stations(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    wifi_sta_list_t sta_list;
    esp_err_t err = esp_wifi_ap_get_sta_list(&sta_list);
    if (err != ESP_OK) {
        return JS_NewArray(ctx);
    }

    JSValue arr = JS_NewArray(ctx);
    for (int i = 0; i < sta_list.num; i++) {
        JSValue obj = JS_NewObject(ctx);
        char mac_str[18];
        mik__format_mac(mac_str, sizeof(mac_str), sta_list.sta[i].mac);
        JS_SetPropertyStr(ctx, obj, "mac", JS_NewString(ctx, mac_str));
        JS_SetPropertyStr(ctx, obj, "rssi", JS_NewInt32(ctx, sta_list.sta[i].rssi));
        JS_SetPropertyUint32(ctx, arr, i, obj);
    }
    return arr;
}

/* ── Phase 6: Power management & misc ──────────────────────────────── */

static JSValue mik__wifi_get_power_save(JSContext* ctx, JSValue this_val, int argc,
                                        JSValue* argv) {
    wifi_ps_type_t ps;
    esp_err_t err = esp_wifi_get_ps(&ps);
    if (err != ESP_OK) {
        return JS_NewString(ctx, "none");
    }
    switch (ps) {
        case WIFI_PS_NONE:
            return JS_NewString(ctx, "none");
        case WIFI_PS_MIN_MODEM:
            return JS_NewString(ctx, "min");
        case WIFI_PS_MAX_MODEM:
            return JS_NewString(ctx, "max");
        default:
            return JS_NewString(ctx, "none");
    }
}

static JSValue mik__wifi_set_power_save(JSContext* ctx, JSValue this_val, int argc,
                                        JSValue* argv) {
    const char* mode = JS_ToCString(ctx, argv[0]);
    if (!mode) return JS_EXCEPTION;

    wifi_ps_type_t ps = WIFI_PS_NONE;
    if (strcmp(mode, "min") == 0) {
        ps = WIFI_PS_MIN_MODEM;
    } else if (strcmp(mode, "max") == 0) {
        ps = WIFI_PS_MAX_MODEM;
    }
    JS_FreeCString(ctx, mode);

    esp_err_t err = esp_wifi_set_ps(ps);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set power save mode: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__wifi_get_country(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    /* esp_wifi_get_country_code writes "CCO\0" (country + operating class +
     * null) — 4 bytes. A 3-byte buffer overflows and leaks adjacent stack
     * into the JS string ("US B" instead of "US"). Return just the 2-char
     * country code; callers that want the operating class can add an API. */
    char cc[4] = {};
    esp_err_t err = esp_wifi_get_country_code(cc);
    if (err != ESP_OK) {
        return JS_UNDEFINED;
    }
    return JS_NewStringLen(ctx, cc, 2);
}

/* ── TX power ──────────────────────────────────────────────────────── */

static JSValue mik__wifi_get_tx_power(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    /* esp_wifi_get_max_tx_power requires the radio to be started. */
    esp_err_t start_err = mik__wifi_ensure_started(ctx);
    if (start_err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get TX power: %s", esp_err_to_name(start_err));
    }
    int8_t power;
    esp_err_t err = esp_wifi_get_max_tx_power(&power);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get TX power: %s", esp_err_to_name(err));
    }
    return mik__result_ok(ctx, JS_NewFloat64(ctx, power * 0.25));
}

static JSValue mik__wifi_set_tx_power(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    double dbm;
    if (JS_ToFloat64(ctx, &dbm, argv[0])) return JS_EXCEPTION;
    esp_err_t start_err = mik__wifi_ensure_started(ctx);
    if (start_err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set TX power: %s", esp_err_to_name(start_err));
    }
    auto power = static_cast<int8_t>(dbm * 4.0);
    esp_err_t err = esp_wifi_set_max_tx_power(power);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set TX power: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

/* ── RSSI threshold ───────────────────────────────────────────────── */

static JSValue mik__wifi_set_rssi_threshold(JSContext* ctx, JSValue this_val, int argc,
                                             JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));

    int32_t threshold;
    if (JS_ToInt32(ctx, &threshold, argv[0])) return JS_EXCEPTION;

    esp_err_t err = esp_wifi_set_rssi_threshold(threshold);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set RSSI threshold: %s", esp_err_to_name(err));
    }
    mik__wifi_st(mik_rt)->rssi_threshold = threshold;
    return mik__result_ok_void(ctx);
}

static JSValue mik__wifi_get_rssi_threshold(JSContext* ctx, JSValue this_val, int argc,
                                             JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__wifi_st(mik_rt));
    return JS_NewInt32(ctx, mik__wifi_st(mik_rt)->rssi_threshold);
}

/* ── AP deauth station ────────────────────────────────────────────── */

static JSValue mik__wifi_ap_deauth_station(JSContext* ctx, JSValue this_val, int argc,
                                            JSValue* argv) {
    const char* mac_str = JS_ToCString(ctx, argv[0]);
    if (!mac_str) return JS_EXCEPTION;

    uint8_t mac[6];
    if (!mik__parse_mac(mac_str, mac)) {
        JS_FreeCString(ctx, mac_str);
        return JS_ThrowTypeError(ctx, "Invalid MAC address format; expected XX:XX:XX:XX:XX:XX");
    }
    JS_FreeCString(ctx, mac_str);

    uint16_t aid = 0;
    esp_err_t err = esp_wifi_ap_get_sta_aid(mac, &aid);
    if (err != ESP_OK || aid == 0) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to find station AID for deauth: %s", esp_err_to_name(err));
    }

    err = esp_wifi_deauth_sta(aid);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to deauthenticate station: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

/* ── AP inactive timeout ──────────────────────────────────────────── */

static JSValue mik__wifi_ap_get_inactive_timeout(JSContext* ctx, JSValue this_val, int argc,
                                                  JSValue* argv) {
    uint16_t sec;
    esp_err_t err = esp_wifi_get_inactive_time(WIFI_IF_AP, &sec);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "Failed to get AP inactive timeout: %s", esp_err_to_name(err));
    }
    return mik__result_ok(ctx, JS_NewInt32(ctx, sec));
}

static JSValue mik__wifi_ap_set_inactive_timeout(JSContext* ctx, JSValue this_val, int argc,
                                                  JSValue* argv) {
    int32_t sec;
    if (JS_ToInt32(ctx, &sec, argv[0])) return JS_EXCEPTION;
    esp_err_t err = esp_wifi_set_inactive_time(WIFI_IF_AP, static_cast<uint16_t>(sec));
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "SetFailed",
                               "Failed to set AP inactive timeout: %s", esp_err_to_name(err));
    }
    return mik__result_ok_void(ctx);
}

/* ── Function table ────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik__wifi_proto_funcs[] = {
    MIK_CFUNC_DEF("connect", 2, mik__wifi_connect),
    MIK_CFUNC_DEF("disconnect", 0, mik__wifi_disconnect),
    MIK_CFUNC_DEF("rssi", 0, mik__wifi_rssi),
    MIK_CFUNC_DEF("ip", 0, mik__wifi_ip),
    MIK_CFUNC_DEF("status", 0, mik__wifi_status),
    MIK_CFUNC_DEF("scan", 1, mik__wifi_scan),
    MIK_CFUNC_DEF("on", 2, mik__wifi_on),
    MIK_CFUNC_DEF("off", 2, mik__wifi_off),
    MIK_CFUNC_DEF("mac", 0, mik__wifi_mac),
    MIK_CFUNC_DEF("getHostname", 0, mik__wifi_get_hostname),
    MIK_CFUNC_DEF("getIpConfig", 0, mik__wifi_get_ip_config),
    MIK_CFUNC_DEF("setIpConfig", 1, mik__wifi_set_ip_config),
    MIK_CFUNC_DEF("apStart", 1, mik__wifi_ap_start),
    MIK_CFUNC_DEF("apStop", 0, mik__wifi_ap_stop),
    MIK_CFUNC_DEF("apIsActive", 0, mik__wifi_ap_is_active),
    MIK_CFUNC_DEF("apIp", 0, mik__wifi_ap_ip),
    MIK_CFUNC_DEF("apStations", 0, mik__wifi_ap_stations),
    MIK_CFUNC_DEF("getPowerSave", 0, mik__wifi_get_power_save),
    MIK_CFUNC_DEF("setPowerSave", 1, mik__wifi_set_power_save),
    MIK_CFUNC_DEF("getCountry", 0, mik__wifi_get_country),
    MIK_CFUNC_DEF("getTxPower", 0, mik__wifi_get_tx_power),
    MIK_CFUNC_DEF("setTxPower", 1, mik__wifi_set_tx_power),
    MIK_CFUNC_DEF("getRssiThreshold", 0, mik__wifi_get_rssi_threshold),
    MIK_CFUNC_DEF("setRssiThreshold", 1, mik__wifi_set_rssi_threshold),
    MIK_CFUNC_DEF("apDeauthStation", 1, mik__wifi_ap_deauth_station),
    MIK_CFUNC_DEF("apGetInactiveTimeout", 0, mik__wifi_ap_get_inactive_timeout),
    MIK_CFUNC_DEF("apSetInactiveTimeout", 1, mik__wifi_ap_set_inactive_timeout),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__wifi_module_init(JSContext* ctx, JSModuleDef* m) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &mik_wifi_class_id);
    JS_NewClass(rt, mik_wifi_class_id, &mik_wifi_classdef);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik__wifi_proto_funcs, countof(mik__wifi_proto_funcs));
    JS_SetClassProto(ctx, mik_wifi_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, mik__wifi_constructor, "Wifi", 0,
                                    JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "Wifi", ctor);
    return 0;
}

static JSModuleDef* mik__wifi_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    mik__wifi_slot = MIK_AllocModuleSlot(mik_rt);

    auto* state = new MIKWifiState();
    state->event_queue = xQueueCreate(8, sizeof(MIKWifiEvent));
    CHECK_NOT_NULL(state->event_queue);
    state->connect_pending = false;
    state->scan_pending = false;
    state->on_connect.reserve(4);
    state->on_disconnect.reserve(4);
    state->on_ap_sta_connect.reserve(4);
    state->on_ap_sta_disconnect.reserve(4);
    state->on_rssi_low.reserve(4);
    s_event_queue = state->event_queue;
    mik__wifi_st(mik_rt) = state;

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/wifi", mik__wifi_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Wifi");
    return m;
}

/* ── Event loop consumption ────────────────────────────────────────── */

static const char* mik__disconnect_reason_str(MIKWifiStatus status) {
    switch (status) {
        case MIK_WIFI_NO_SSID_AVAIL:
            return "no-ssid";
        case MIK_WIFI_CONNECT_FAILED:
            return "auth-failed";
        case MIK_WIFI_CONNECTION_LOST:
            return "connection-lost";
        default:
            return "disconnected";
    }
}

static void mik__wifi_dispatch_connect(JSContext* ctx, MIKWifiState* state,
                                       esp_netif_ip_info_t* ip_info) {
    char ip_str[16], netmask_str[16], gw_str[16];
    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&ip_info->ip));
    snprintf(netmask_str, sizeof(netmask_str), IPSTR, IP2STR(&ip_info->netmask));
    snprintf(gw_str, sizeof(gw_str), IPSTR, IP2STR(&ip_info->gw));

    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "ip", JS_NewString(ctx, ip_str));
    JS_SetPropertyStr(ctx, info, "netmask", JS_NewString(ctx, netmask_str));
    JS_SetPropertyStr(ctx, info, "gateway", JS_NewString(ctx, gw_str));

    for (auto& listener : state->on_connect) {
        mik_call_handler(ctx, listener, 1, &info);
    }

    JS_FreeValue(ctx, info);
}

static void mik__wifi_dispatch_disconnect(JSContext* ctx, MIKWifiState* state,
                                          MIKWifiStatus status) {
    const char* reason = mik__disconnect_reason_str(status);
    JSValue reason_val = JS_NewString(ctx, reason);

    for (auto& listener : state->on_disconnect) {
        mik_call_handler(ctx, listener, 1, &reason_val);
    }

    JS_FreeValue(ctx, reason_val);
}

static void mik__wifi_dispatch_ap_sta(JSContext* ctx, std::vector<JSValue>& listeners,
                                      const uint8_t* mac) {
    char mac_str[18];
    mik__format_mac(mac_str, sizeof(mac_str), mac);

    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "mac", JS_NewString(ctx, mac_str));

    for (auto& listener : listeners) {
        mik_call_handler(ctx, listener, 1, &info);
    }

    JS_FreeValue(ctx, info);
}

static void mik__wifi_resolve_scan(JSContext* ctx, MIKWifiState* state) {
    uint16_t ap_count = 0;
    esp_wifi_scan_get_ap_num(&ap_count);

    if (ap_count > MIK_WIFI_MAX_SCAN_RESULTS) {
        ap_count = MIK_WIFI_MAX_SCAN_RESULTS;
    }

    if (ap_count == 0) {
        JSValue arr = JS_NewArray(ctx);
        JSValue result = mik__result_ok(ctx, arr);
        MIK_ResolvePromise(ctx, &state->scan_promise, 1, &result);
        state->scan_pending = false;
        return;
    }

    auto* ap_records = static_cast<wifi_ap_record_t*>(calloc(ap_count, sizeof(wifi_ap_record_t)));
    if (!ap_records) {
        esp_wifi_clear_ap_list();
        JSValue result = mik__result_err_named(ctx, "ScanFailed",
                                         "Failed to allocate memory for scan results");
        MIK_ResolvePromise(ctx, &state->scan_promise, 1, &result);
        state->scan_pending = false;
        return;
    }

    esp_wifi_scan_get_ap_records(&ap_count, ap_records);

    JSValue arr = JS_NewArray(ctx);
    for (uint16_t i = 0; i < ap_count; i++) {
        JSValue obj = JS_NewObject(ctx);
        JS_SetPropertyStr(
            ctx, obj, "ssid",
            mik__new_string_from_ssid(ctx, ap_records[i].ssid, sizeof(ap_records[i].ssid)));

        char bssid_str[18];
        mik__format_mac(bssid_str, sizeof(bssid_str), ap_records[i].bssid);
        JS_SetPropertyStr(ctx, obj, "bssid", JS_NewString(ctx, bssid_str));

        JS_SetPropertyStr(ctx, obj, "channel", JS_NewInt32(ctx, ap_records[i].primary));
        JS_SetPropertyStr(ctx, obj, "rssi", JS_NewInt32(ctx, ap_records[i].rssi));
        JS_SetPropertyStr(ctx, obj, "authMode",
                          JS_NewString(ctx, mik__authmode_str(ap_records[i].authmode)));
        JS_SetPropertyStr(ctx, obj, "hidden",
                          JS_NewBool(ctx, ap_records[i].ssid[0] == '\0'));

        JS_SetPropertyUint32(ctx, arr, i, obj);
    }

    free(ap_records);

    JSValue result = mik__result_ok(ctx, arr);
    MIK_ResolvePromise(ctx, &state->scan_promise, 1, &result);
    state->scan_pending = false;
}

void mik__wifi_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__wifi_st(mik_rt)) return;

    MIKWifiState* state = mik__wifi_st(mik_rt);
    MIKWifiEvent evt;

    while (xQueueReceive(state->event_queue, &evt, 0) == pdTRUE) {
        switch (evt.type) {
            case MIK_WIFI_EVT_GOT_IP: {
                // Resolve connect promise
                if (state->connect_pending) {
                    char ip_str[16], netmask_str[16], gw_str[16];
                    snprintf(ip_str, sizeof(ip_str), IPSTR, IP2STR(&evt.ip_info.ip));
                    snprintf(netmask_str, sizeof(netmask_str), IPSTR,
                             IP2STR(&evt.ip_info.netmask));
                    snprintf(gw_str, sizeof(gw_str), IPSTR, IP2STR(&evt.ip_info.gw));

                    JSValue info = JS_NewObject(ctx);
                    JS_SetPropertyStr(ctx, info, "ip", JS_NewString(ctx, ip_str));
                    JS_SetPropertyStr(ctx, info, "netmask", JS_NewString(ctx, netmask_str));
                    JS_SetPropertyStr(ctx, info, "gateway", JS_NewString(ctx, gw_str));

                    JSValue result = mik__result_ok(ctx, info);
                    MIK_ResolvePromise(ctx, &state->connect_promise, 1, &result);
                    state->connect_pending = false;
                }
                // Dispatch connect event listeners
                mik__wifi_dispatch_connect(ctx, state, &evt.ip_info);
                break;
            }
            case MIK_WIFI_EVT_STATUS_CHANGE: {
                // Check if this is a connect failure
                if (state->connect_pending) {
                    if (evt.status == MIK_WIFI_NO_SSID_AVAIL ||
                        evt.status == MIK_WIFI_CONNECT_FAILED ||
                        evt.status == MIK_WIFI_DISCONNECTED) {
                        JSValue result = mik__result_err_named(ctx, "ConnectFailed",
                                                        "WiFi connection failed: %s",
                                                        mik__disconnect_reason_str(evt.status));
                        MIK_ResolvePromise(ctx, &state->connect_promise, 1, &result);
                        state->connect_pending = false;
                    }
                }

                // Dispatch disconnect event listeners
                if (evt.status == MIK_WIFI_NO_SSID_AVAIL ||
                    evt.status == MIK_WIFI_CONNECT_FAILED ||
                    evt.status == MIK_WIFI_CONNECTION_LOST ||
                    evt.status == MIK_WIFI_DISCONNECTED) {
                    mik__wifi_dispatch_disconnect(ctx, state, evt.status);
                }
                break;
            }
            case MIK_WIFI_EVT_SCAN_DONE: {
                if (state->scan_pending) {
                    mik__wifi_resolve_scan(ctx, state);
                }
                break;
            }
            case MIK_WIFI_EVT_AP_STA_CONNECTED: {
                mik__wifi_dispatch_ap_sta(ctx, state->on_ap_sta_connect, evt.mac);
                break;
            }
            case MIK_WIFI_EVT_AP_STA_DISCONNECTED: {
                mik__wifi_dispatch_ap_sta(ctx, state->on_ap_sta_disconnect, evt.mac);
                break;
            }
            case MIK_WIFI_EVT_RSSI_LOW: {
                JSValue rssi_val = JS_NewInt32(ctx, evt.rssi);
                for (auto& listener : state->on_rssi_low) {
                    mik_call_handler(ctx, listener, 1, &rssi_val);
                }
                JS_FreeValue(ctx, rssi_val);
                break;
            }
        }
    }
}

void mik__wifi_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__wifi_st(mik_rt)) return;

    MIKWifiState* state = mik__wifi_st(mik_rt);

    // Free pending promises
    if (state->connect_pending) {
        MIK_FreePromise(ctx, &state->connect_promise);
    }
    if (state->scan_pending) {
        MIK_FreePromise(ctx, &state->scan_promise);
    }

    // Free event listeners
    for (auto& v : state->on_connect) {
        JS_FreeValue(ctx, v);
    }
    for (auto& v : state->on_disconnect) {
        JS_FreeValue(ctx, v);
    }
    for (auto& v : state->on_ap_sta_connect) {
        JS_FreeValue(ctx, v);
    }
    for (auto& v : state->on_ap_sta_disconnect) {
        JS_FreeValue(ctx, v);
    }
    for (auto& v : state->on_rssi_low) {
        JS_FreeValue(ctx, v);
    }

    // Drain queue
    MIKWifiEvent evt;
    while (xQueueReceive(state->event_queue, &evt, 0) == pdTRUE) {
    }

    s_event_queue = nullptr;
    vQueueDelete(state->event_queue);
    delete state;
    mik__wifi_st(mik_rt) = nullptr;

    /* Fully tear down the WiFi driver so the heap used by the radio stack,
     * beacon offsets, event handlers, and netif interfaces is returned to
     * the pool. Without this, repeated runtime lifecycles (e.g. on-device
     * test suites that create + destroy a runtime per test) eventually hit
     * `alloc pm_beacon_offset fail` when the heap is too fragmented for
     * even small internal allocations. */
    if (s_wifi_initialized) {
        if (s_wifi_started) {
            esp_wifi_stop();
            s_wifi_started = false;
        }
        /* ensure_initialized registered these via esp_event_handler_instance_register
         * with a nullptr context out-param, so we can't use instance_unregister.
         * esp_event_handler_unregister matches on (base, id, handler fn) instead. */
        esp_event_handler_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                     mik__wifi_event_handler);
        esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                     mik__wifi_event_handler);
        esp_wifi_deinit();
        if (s_sta_netif) {
            esp_netif_destroy_default_wifi(s_sta_netif);
            s_sta_netif = nullptr;
        }
        if (s_ap_netif) {
            esp_netif_destroy_default_wifi(s_ap_netif);
            s_ap_netif = nullptr;
        }
        s_wifi_initialized = false;
    }
}

MIK_REGISTER_MODULE(wifi, "native:mikro/wifi", mik__wifi_init, mik__wifi_consume, mik__wifi_destroy)

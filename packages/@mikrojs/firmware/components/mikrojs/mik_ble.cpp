#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "mik_ble_c_shim.h"
#include "mikrojs/errors.h"
#include "private.h"
#include "utils.h"

/* Internal helpers below return `MIK_ERR_BLE_*` int codes. This converter
 * maps those codes to the JS-side variant names used by mikrojs/ble, so
 * the public JS-bound functions can emit `{name, message}` errors directly
 * via mik__result_err_named without a JS-side mapError switch. */
static const char* mik__ble_code_to_name(int code) {
    switch (code) {
        case MIK_ERR_BLE_STACK_INIT_FAILED:
            return "StackInitFailed";
        case MIK_ERR_BLE_CONTROLLER_INIT_FAILED:
            return "ControllerInitFailed";
        case MIK_ERR_BLE_GATT_REGISTRATION_FAILED:
            return "GattRegistrationFailed";
        case MIK_ERR_BLE_GATT_ALREADY_REGISTERED:
            return "GattAlreadyRegistered";
        case MIK_ERR_BLE_INVALID_UUID:
            return "InvalidUuid";
        default:
            return "StackInitFailed";  /* safest fallback */
    }
}

/* Dynamic module data slot, allocated on first import */
static int mik__ble_slot = -1;

/* Per-runtime state. NimBLE is a single-instance stack with one global radio,
 * so per-runtime state is just a lifecycle hook. */
struct MIKBleState {
    uint8_t _unused;
};

static inline MIKBleState*& mik__ble_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKBleState*&>(rt->module_data[mik__ble_slot]);
}

#define MIK_BLE_TAG "native:mikro/ble"

/* Max advertising payload (31 bytes) minus mandatory flags overhead (3 bytes). */
#define MIK_BLE_NAME_MAX_LEN 29

/* Characteristic property bitmask — must match the PROP_* constants in ble.ts. */
enum MIKBleProp : uint8_t {
    MIK_BLE_PROP_READ = 0x01,
    MIK_BLE_PROP_WRITE = 0x02,
    MIK_BLE_PROP_WRITE_WITHOUT_RESP = 0x04,
    MIK_BLE_PROP_NOTIFY = 0x08,
    MIK_BLE_PROP_INDICATE = 0x10,
};

/* Event queue event types. BLE GAP and GATT events fire on the NimBLE host
 * task; we convert them into MIKBleEvent records, post to a FreeRTOS queue,
 * and drain on the JS loop thread via mik__ble_consume. */
enum MIKBleEventType : uint8_t {
    MIK_BLE_EVT_CONNECT = 0,
    MIK_BLE_EVT_DISCONNECT = 1,
    MIK_BLE_EVT_MTU = 2,
    MIK_BLE_EVT_WRITE = 3,
};

struct MIKBleEvent {
    MIKBleEventType type;
    uint16_t conn_handle;
    uint16_t mtu;              /* CONNECT, DISCONNECT, MTU */
    uint8_t peer_addr[6];      /* CONNECT, DISCONNECT (zero for MTU) */
    uint8_t disconnect_reason; /* DISCONNECT */
    uint16_t attr_handle;      /* WRITE */
    uint8_t* write_data;       /* WRITE: points into the write pool */
    uint16_t write_data_len;   /* WRITE */
};

/* Write payload pool. The NimBLE host task grabs a buffer in the write
 * access callback; the JS loop thread returns it after dispatching. Fixed
 * size avoids heap fragmentation on the hot path. Drop-on-exhaustion. */
#define MIK_BLE_WRITE_POOL_SIZE 8
#define MIK_BLE_WRITE_POOL_BUF_SIZE 256

/* Event queue depth. BLE events can burst (connect then MTU then first write
 * within milliseconds); 16 is roughly double what wifi uses. */
#define MIK_BLE_EVENT_QUEUE_DEPTH 16

/* Per-connection tracking. NimBLE's default max connections is usually 3–4;
 * a fixed array of 4 slots matches the common case and avoids allocation
 * on connect. */
#define MIK_BLE_MAX_CONNECTIONS 4

/* Maximum characteristics per registered GATT table, bounded by the uint32
 * subscription bitmap width. 32 chars is plenty for typical peripherals. */
#define MIK_BLE_MAX_CHARS 32

/* ── GATT table data structures ────────────────────────────────────── */

struct MIKBleChar {
    ble_uuid_any_t uuid;
    std::string uuid_str;     /* for deep-equal comparison and error messages */
    uint8_t properties;       /* MIK_BLE_PROP_* bitmask */
    uint8_t global_idx;       /* 0..MIK_BLE_MAX_CHARS-1, bit index for subs bitmap */
    std::vector<uint8_t> value;
    uint16_t val_handle;      /* filled in by NimBLE at ble_gatts_add_svcs() */
    JSValue on_write;         /* strong ref to the JS onWrite handler, or JS_UNDEFINED */
};

struct MIKBleService {
    ble_uuid_any_t uuid;
    std::string uuid_str;
    std::vector<MIKBleChar> chars;
    /* NimBLE's chr_def array for this service. Must outlive NimBLE's use of
     * the pointers it holds. One entry per char + a zero terminator. */
    std::vector<ble_gatt_chr_def> chr_defs;
};

struct MIKBleGattTable {
    std::vector<MIKBleService> services;
    /* NimBLE's svc_def array. One entry per service + a zero terminator. */
    std::vector<ble_gatt_svc_def> svc_defs;
    /* Shared mutex for characteristic value reads/writes, held briefly during
     * access_cb (NimBLE host task) and setValue (JS loop thread). */
    SemaphoreHandle_t value_mutex;
};

/* ── Single-instance BLE stack state ───────────────────────────────── */

static bool s_nimble_initialized = false;
static bool s_nimble_sync_done = false;
static bool s_advertising = false;
static uint8_t s_own_addr_type = 0;
static SemaphoreHandle_t s_sync_sem = nullptr;
static char s_device_name[MIK_BLE_NAME_MAX_LEN + 1] = {};
static MIKBleGattTable* s_gatt_table = nullptr;

/* Event queue, shared between NimBLE host task (producers) and the JS
 * loop thread (consumer). */
static QueueHandle_t s_ble_event_queue = nullptr;

/* Write payload pool. The mux guards both the data slots and the usage
 * bitmap; critical sections are microseconds long. The data/usage buffers
 * are heap-allocated lazily in mik__ble_ensure_initialized so builds that
 * never activate BLE don't pay for ~2 KB of .bss. */
static uint8_t (*s_write_pool_data)[MIK_BLE_WRITE_POOL_BUF_SIZE] = nullptr;
static bool* s_write_pool_used = nullptr;
static portMUX_TYPE s_write_pool_mux = portMUX_INITIALIZER_UNLOCKED;

/* JS event listeners. BLE state is global (single stack), so these live
 * outside the MIKBleState struct. Accessed only from the JS loop thread. */
static std::vector<JSValue> s_on_connect;
static std::vector<JSValue> s_on_disconnect;
static std::vector<JSValue> s_on_mtu;

/* Per-connection tracking. Updated from the NimBLE host task in the GAP
 * event callback; read from the JS loop thread in the notify method. The
 * small critical section protects concurrent access — a spinlock is plenty
 * for this scale. */
struct MIKBleConnection {
    bool active;
    uint16_t handle;
    uint8_t peer_addr[6];
    uint16_t mtu;
    uint32_t notify_subs;   /* bit i = subscribed to notify on char with idx i */
    uint32_t indicate_subs; /* bit i = subscribed to indicate on char with idx i */
};

/* Heap-allocated in mik__ble_ensure_initialized alongside the write pool. */
static MIKBleConnection* s_connections = nullptr;
static portMUX_TYPE s_connections_mux = portMUX_INITIALIZER_UNLOCKED;

/* Forward declarations */
static void mik__ble_host_task(void* param);
static void mik__ble_on_sync(void);
static void mik__ble_on_reset(int reason);
static int mik__ble_gatt_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                   struct ble_gatt_access_ctxt* ctxt, void* arg);
static int mik__ble_gap_event_cb(struct ble_gap_event* event, void* arg);
static MIKBleChar* mik__ble_find_char_by_handle(uint16_t attr_handle);

/* ── Write pool ─────────────────────────────────────────────────────── */

static uint8_t* mik__ble_pool_alloc(void) {
    portENTER_CRITICAL(&s_write_pool_mux);
    for (int i = 0; i < MIK_BLE_WRITE_POOL_SIZE; i++) {
        if (!s_write_pool_used[i]) {
            s_write_pool_used[i] = true;
            portEXIT_CRITICAL(&s_write_pool_mux);
            return s_write_pool_data[i];
        }
    }
    portEXIT_CRITICAL(&s_write_pool_mux);
    return nullptr;
}

static void mik__ble_pool_free(uint8_t* buf) {
    if (!buf) return;
    portENTER_CRITICAL(&s_write_pool_mux);
    for (int i = 0; i < MIK_BLE_WRITE_POOL_SIZE; i++) {
        if (s_write_pool_data[i] == buf) {
            s_write_pool_used[i] = false;
            break;
        }
    }
    portEXIT_CRITICAL(&s_write_pool_mux);
}

/* ── Per-connection tracking ───────────────────────────────────────── */

/* Find or allocate a connection slot by conn_handle. Returns nullptr if
 * all slots are full. Must be called with s_connections_mux held. */
static MIKBleConnection* mik__ble_conn_find_or_alloc_locked(uint16_t handle) {
    for (int i = 0; i < MIK_BLE_MAX_CONNECTIONS; i++) {
        if (s_connections[i].active && s_connections[i].handle == handle) {
            return &s_connections[i];
        }
    }
    for (int i = 0; i < MIK_BLE_MAX_CONNECTIONS; i++) {
        if (!s_connections[i].active) {
            s_connections[i] = {};
            s_connections[i].active = true;
            s_connections[i].handle = handle;
            return &s_connections[i];
        }
    }
    return nullptr;
}

static MIKBleConnection* mik__ble_conn_find_locked(uint16_t handle) {
    for (int i = 0; i < MIK_BLE_MAX_CONNECTIONS; i++) {
        if (s_connections[i].active && s_connections[i].handle == handle) {
            return &s_connections[i];
        }
    }
    return nullptr;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

static void mik__ble_set_default_name(void) {
    if (s_device_name[0] != '\0') return;
    uint8_t mac[6] = {};
    esp_err_t err = esp_read_mac(mac, ESP_MAC_BT);
    if (err == ESP_OK) {
        snprintf(s_device_name, sizeof(s_device_name), "mikrojs-%02x%02x%02x", mac[3], mac[4],
                 mac[5]);
    } else {
        snprintf(s_device_name, sizeof(s_device_name), "mikrojs");
    }
}

/* Parse a UUID string into a ble_uuid_any_t. Accepts 4-char 16-bit form
 * (e.g. "180f") or the 36-char canonical 128-bit form with dashes. The JS
 * wrapper does stricter validation; this parser trusts well-formed input
 * and returns -1 only for shapes it cannot handle. */
static int mik__ble_parse_uuid(const char* str, ble_uuid_any_t* out) {
    if (!str) return -1;
    size_t len = strlen(str);

    if (len == 4) {
        for (size_t i = 0; i < 4; i++) {
            if (!isxdigit(static_cast<unsigned char>(str[i]))) return -1;
        }
        uint16_t val = static_cast<uint16_t>(strtoul(str, nullptr, 16));
        out->u16.u.type = BLE_UUID_TYPE_16;
        out->u16.value = val;
        return 0;
    }

    if (len == 36 && str[8] == '-' && str[13] == '-' && str[18] == '-' && str[23] == '-') {
        /* Parse into a network-order (big-endian) byte buffer first. */
        uint8_t bytes[16] = {};
        const char* p = str;
        for (int i = 0; i < 16; i++) {
            if (*p == '-') p++;
            if (!isxdigit(static_cast<unsigned char>(p[0])) ||
                !isxdigit(static_cast<unsigned char>(p[1]))) {
                return -1;
            }
            char pair[3] = {p[0], p[1], 0};
            bytes[i] = static_cast<uint8_t>(strtoul(pair, nullptr, 16));
            p += 2;
        }
        /* NimBLE stores 128-bit UUIDs in little-endian — reverse the string's
         * byte order when populating ble_uuid128_t.value. */
        out->u128.u.type = BLE_UUID_TYPE_128;
        for (int i = 0; i < 16; i++) {
            out->u128.value[i] = bytes[15 - i];
        }
        return 0;
    }

    return -1;
}

/* Map our property bitmask to NimBLE's ble_gatt_chr_flags. */
static ble_gatt_chr_flags mik__ble_translate_properties(uint8_t props) {
    ble_gatt_chr_flags flags = 0;
    if (props & MIK_BLE_PROP_READ) flags |= BLE_GATT_CHR_F_READ;
    if (props & MIK_BLE_PROP_WRITE) flags |= BLE_GATT_CHR_F_WRITE;
    if (props & MIK_BLE_PROP_WRITE_WITHOUT_RESP) flags |= BLE_GATT_CHR_F_WRITE_NO_RSP;
    if (props & MIK_BLE_PROP_NOTIFY) flags |= BLE_GATT_CHR_F_NOTIFY;
    if (props & MIK_BLE_PROP_INDICATE) flags |= BLE_GATT_CHR_F_INDICATE;
    return flags;
}

/* Deep-equal comparison of two GATT tables by UUID strings and property
 * bitmasks. Used to reject advertise() calls that try to register a
 * different service set without a prior ble.stop(). */
static bool mik__ble_tables_match(const MIKBleGattTable* a, const MIKBleGattTable* b) {
    if (a->services.size() != b->services.size()) return false;
    for (size_t i = 0; i < a->services.size(); i++) {
        const auto& sa = a->services[i];
        const auto& sb = b->services[i];
        if (sa.uuid_str != sb.uuid_str) return false;
        if (sa.chars.size() != sb.chars.size()) return false;
        for (size_t j = 0; j < sa.chars.size(); j++) {
            if (sa.chars[j].uuid_str != sb.chars[j].uuid_str) return false;
            if (sa.chars[j].properties != sb.chars[j].properties) return false;
        }
    }
    return true;
}

static void mik__ble_free_gatt_table(JSContext* ctx, MIKBleGattTable* table) {
    if (!table) return;
    if (ctx) {
        for (auto& svc : table->services) {
            for (auto& chr : svc.chars) {
                if (!JS_IsUndefined(chr.on_write)) {
                    JS_FreeValue(ctx, chr.on_write);
                    chr.on_write = JS_UNDEFINED;
                }
            }
        }
    }
    if (table->value_mutex) {
        vSemaphoreDelete(table->value_mutex);
    }
    delete table;
}

/* Build a GATT table from a JS services array. The JS wrapper has already
 * validated UUIDs, properties, and shape — this function trusts the input
 * and returns a MIK_ERR_BLE_* code only for edge cases like allocation
 * failures. On success, *out_table is populated and the caller owns it;
 * on failure, *out_table is nullptr.
 *
 * Returns 0 on success or a MIK_ERR_BLE_* code on failure. */
static int mik__ble_build_gatt_table(JSContext* ctx, JSValue services_val,
                                     MIKBleGattTable** out_table) {
    *out_table = nullptr;
    if (!JS_IsArray(services_val)) {
        return MIK_ERR_BLE_GATT_REGISTRATION_FAILED;
    }

    JSValue len_val = JS_GetPropertyStr(ctx, services_val, "length");
    uint32_t service_count = 0;
    JS_ToUint32(ctx, &service_count, len_val);
    JS_FreeValue(ctx, len_val);

    if (service_count == 0) {
        /* Empty services — treat as broadcaster mode, no GATT registration. */
        return 0;
    }

    auto* table = new MIKBleGattTable();
    table->services.reserve(service_count);
    table->svc_defs.reserve(service_count + 1);

    /* Running counter for the global characteristic index, used as the
     * bit position in per-connection subscription bitmaps. Capped at
     * MIK_BLE_MAX_CHARS; any overflow fails the entire registration. */
    uint8_t next_global_idx = 0;

    for (uint32_t i = 0; i < service_count; i++) {
        JSValue svc_val = JS_GetPropertyUint32(ctx, services_val, i);

        /* Service UUID */
        JSValue svc_uuid_val = JS_GetPropertyStr(ctx, svc_val, "uuid");
        const char* svc_uuid_cstr = JS_ToCString(ctx, svc_uuid_val);
        if (!svc_uuid_cstr) {
            JS_FreeValue(ctx, svc_uuid_val);
            JS_FreeValue(ctx, svc_val);
            mik__ble_free_gatt_table(ctx, table);
            return MIK_ERR_BLE_INVALID_UUID;
        }

        MIKBleService& service = table->services.emplace_back();
        service.uuid_str = svc_uuid_cstr;
        if (mik__ble_parse_uuid(svc_uuid_cstr, &service.uuid) != 0) {
            JS_FreeCString(ctx, svc_uuid_cstr);
            JS_FreeValue(ctx, svc_uuid_val);
            JS_FreeValue(ctx, svc_val);
            mik__ble_free_gatt_table(ctx, table);
            return MIK_ERR_BLE_INVALID_UUID;
        }
        JS_FreeCString(ctx, svc_uuid_cstr);
        JS_FreeValue(ctx, svc_uuid_val);

        /* Characteristics array */
        JSValue chars_val = JS_GetPropertyStr(ctx, svc_val, "characteristics");
        JSValue chars_len_val = JS_GetPropertyStr(ctx, chars_val, "length");
        uint32_t char_count = 0;
        JS_ToUint32(ctx, &char_count, chars_len_val);
        JS_FreeValue(ctx, chars_len_val);

        service.chars.reserve(char_count);
        service.chr_defs.reserve(char_count + 1);

        for (uint32_t j = 0; j < char_count; j++) {
            JSValue char_val = JS_GetPropertyUint32(ctx, chars_val, j);

            /* Char UUID */
            JSValue char_uuid_val = JS_GetPropertyStr(ctx, char_val, "uuid");
            const char* char_uuid_cstr = JS_ToCString(ctx, char_uuid_val);
            if (!char_uuid_cstr) {
                JS_FreeValue(ctx, char_uuid_val);
                JS_FreeValue(ctx, char_val);
                JS_FreeValue(ctx, chars_val);
                JS_FreeValue(ctx, svc_val);
                mik__ble_free_gatt_table(ctx, table);
                return MIK_ERR_BLE_INVALID_UUID;
            }

            if (next_global_idx >= MIK_BLE_MAX_CHARS) {
                JS_FreeValue(ctx, char_val);
                JS_FreeValue(ctx, chars_val);
                JS_FreeValue(ctx, svc_val);
                mik__ble_free_gatt_table(ctx, table);
                return MIK_ERR_BLE_GATT_REGISTRATION_FAILED;
            }

            MIKBleChar& chr = service.chars.emplace_back();
            chr.uuid_str = char_uuid_cstr;
            chr.val_handle = 0;
            chr.global_idx = next_global_idx++;
            chr.on_write = JS_UNDEFINED;

            if (mik__ble_parse_uuid(char_uuid_cstr, &chr.uuid) != 0) {
                JS_FreeCString(ctx, char_uuid_cstr);
                JS_FreeValue(ctx, char_uuid_val);
                JS_FreeValue(ctx, char_val);
                JS_FreeValue(ctx, chars_val);
                JS_FreeValue(ctx, svc_val);
                mik__ble_free_gatt_table(ctx, table);
                return MIK_ERR_BLE_INVALID_UUID;
            }
            JS_FreeCString(ctx, char_uuid_cstr);
            JS_FreeValue(ctx, char_uuid_val);

            /* Properties bitmask */
            JSValue props_val = JS_GetPropertyStr(ctx, char_val, "properties");
            uint32_t props = 0;
            JS_ToUint32(ctx, &props, props_val);
            chr.properties = static_cast<uint8_t>(props);
            JS_FreeValue(ctx, props_val);

            /* Initial value (optional) */
            JSValue value_val = JS_GetPropertyStr(ctx, char_val, "value");
            if (!JS_IsUndefined(value_val) && !JS_IsNull(value_val)) {
                size_t vlen = 0;
                const uint8_t* vbuf = JS_GetUint8Array(ctx, &vlen, value_val);
                if (vbuf && vlen > 0) {
                    chr.value.assign(vbuf, vbuf + vlen);
                }
            }
            JS_FreeValue(ctx, value_val);

            /* onWrite handler (optional). Dup so we can call it later
             * from the loop consumer. Freed in mik__ble_free_gatt_table. */
            JSValue on_write_val = JS_GetPropertyStr(ctx, char_val, "onWrite");
            if (JS_IsFunction(ctx, on_write_val)) {
                chr.on_write = JS_DupValue(ctx, on_write_val);
            }
            JS_FreeValue(ctx, on_write_val);

            JS_FreeValue(ctx, char_val);
        }

        /* Now build chr_defs pointing into service.chars. The chars vector
         * has its final size (we reserved upfront), so element addresses
         * are stable. */
        for (size_t j = 0; j < service.chars.size(); j++) {
            ble_gatt_chr_def chr_def = {};
            chr_def.uuid = &service.chars[j].uuid.u;
            chr_def.access_cb = mik__ble_gatt_access_cb;
            chr_def.arg = &service.chars[j];
            chr_def.flags = mik__ble_translate_properties(service.chars[j].properties);
            chr_def.val_handle = &service.chars[j].val_handle;
            service.chr_defs.push_back(chr_def);
        }
        service.chr_defs.push_back({}); /* zero terminator */

        ble_gatt_svc_def svc_def = {};
        svc_def.type = BLE_GATT_SVC_TYPE_PRIMARY;
        svc_def.uuid = &service.uuid.u;
        svc_def.characteristics = service.chr_defs.data();
        table->svc_defs.push_back(svc_def);

        JS_FreeValue(ctx, chars_val);
        JS_FreeValue(ctx, svc_val);
    }

    table->svc_defs.push_back({}); /* zero terminator */

    table->value_mutex = xSemaphoreCreateMutex();
    if (!table->value_mutex) {
        mik__ble_free_gatt_table(ctx, table);
        return MIK_ERR_BLE_GATT_REGISTRATION_FAILED;
    }

    *out_table = table;
    return 0;
}

/* ── GATT access callback (chunk 1 stub) ───────────────────────────── */

/* Runs on the NimBLE host task when a central reads or writes a
 * characteristic. Chunk 1: serves the cached value buffer on read, accepts
 * writes into the buffer without dispatching to JS. Chunks 2/3 will wire
 * up the event-queue dispatch for onWrite. */
static int mik__ble_gatt_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                   struct ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn_handle;
    (void)attr_handle;
    auto* chr = static_cast<MIKBleChar*>(arg);
    if (!chr || !s_gatt_table || !s_gatt_table->value_mutex) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        xSemaphoreTake(s_gatt_table->value_mutex, portMAX_DELAY);
        int rc = os_mbuf_append(ctxt->om, chr->value.data(), chr->value.size());
        xSemaphoreGive(s_gatt_table->value_mutex);
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }

    if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
        xSemaphoreTake(s_gatt_table->value_mutex, portMAX_DELAY);
        chr->value.resize(len);
        uint16_t copied = 0;
        int rc = ble_hs_mbuf_to_flat(ctxt->om, chr->value.data(), len, &copied);
        xSemaphoreGive(s_gatt_table->value_mutex);
        if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

        /* Post a WRITE event to the loop consumer so the JS onWrite handler
         * runs on the JS thread. Copy the bytes into a pool-allocated buffer
         * so the event struct can travel through the FreeRTOS queue. Drop
         * silently if the pool is exhausted or the data exceeds one buffer
         * (rare — pool bufs are 256 bytes, bigger than default MTU). */
        if (s_ble_event_queue && len > 0 && len <= MIK_BLE_WRITE_POOL_BUF_SIZE) {
            uint8_t* pool_buf = mik__ble_pool_alloc();
            if (pool_buf) {
                memcpy(pool_buf, chr->value.data(), len);
                MIKBleEvent evt = {};
                evt.type = MIK_BLE_EVT_WRITE;
                evt.conn_handle = conn_handle;
                evt.attr_handle = attr_handle;
                evt.write_data = pool_buf;
                evt.write_data_len = len;
                if (xQueueSend(s_ble_event_queue, &evt, 0) != pdTRUE) {
                    /* Queue full — return the buffer to the pool. */
                    mik__ble_pool_free(pool_buf);
                    ESP_LOGW(MIK_BLE_TAG, "event queue full, dropping write event");
                }
            } else {
                ESP_LOGW(MIK_BLE_TAG, "write pool exhausted, dropping write event");
            }
        }
        return 0;
    }

    return BLE_ATT_ERR_UNLIKELY;
}

/* ── GAP event callback ────────────────────────────────────────────── */

/* Runs on the NimBLE host task. Translates GAP events into MIKBleEvent
 * records and posts them to the event queue for the loop consumer.
 * Must not touch JS — all JS access happens in mik__ble_consume. */
static int mik__ble_gap_event_cb(struct ble_gap_event* event, void* arg) {
    (void)arg;
    MIKBleEvent evt = {};

    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT: {
            if (event->connect.status != 0) {
                /* Connection attempt failed. NimBLE will have already stopped
                 * advertising; user code should call advertise() again to
                 * become discoverable again. */
                s_advertising = false;
                return 0;
            }
            struct ble_gap_conn_desc desc = {};
            uint8_t peer_addr[6] = {};
            if (ble_gap_conn_find(event->connect.conn_handle, &desc) == 0) {
                memcpy(peer_addr, desc.peer_ota_addr.val, 6);
            }
            uint16_t mtu = ble_att_mtu(event->connect.conn_handle);

            /* Track the new connection. If all slots are full the connection
             * is still valid at the NimBLE layer, but we won't be able to
             * route notifications to it — log a warn and continue. */
            portENTER_CRITICAL(&s_connections_mux);
            MIKBleConnection* conn =
                mik__ble_conn_find_or_alloc_locked(event->connect.conn_handle);
            if (conn) {
                memcpy(conn->peer_addr, peer_addr, 6);
                conn->mtu = mtu;
                conn->notify_subs = 0;
                conn->indicate_subs = 0;
            }
            portEXIT_CRITICAL(&s_connections_mux);
            if (!conn) {
                ESP_LOGW(MIK_BLE_TAG, "connection slots full, untracked conn %u",
                         event->connect.conn_handle);
            }

            evt.type = MIK_BLE_EVT_CONNECT;
            evt.conn_handle = event->connect.conn_handle;
            memcpy(evt.peer_addr, peer_addr, 6);
            evt.mtu = mtu;
            /* Connection formed — NimBLE stopped advertising automatically. */
            s_advertising = false;
            if (s_ble_event_queue) xQueueSend(s_ble_event_queue, &evt, 0);
            return 0;
        }
        case BLE_GAP_EVENT_DISCONNECT: {
            /* Look up cached state BEFORE releasing the slot so the event
             * reports the last-known MTU instead of 0. NimBLE's ATT context
             * is already torn down by the time this fires, so
             * ble_att_mtu() returns 0 here — we rely on our cache. */
            uint16_t conn_handle = event->disconnect.conn.conn_handle;
            uint8_t peer_addr[6] = {};
            uint16_t cached_mtu = 0;

            portENTER_CRITICAL(&s_connections_mux);
            MIKBleConnection* conn = mik__ble_conn_find_locked(conn_handle);
            if (conn) {
                memcpy(peer_addr, conn->peer_addr, 6);
                cached_mtu = conn->mtu;
                conn->active = false;
            } else {
                memcpy(peer_addr, event->disconnect.conn.peer_ota_addr.val, 6);
            }
            portEXIT_CRITICAL(&s_connections_mux);

            evt.type = MIK_BLE_EVT_DISCONNECT;
            evt.conn_handle = conn_handle;
            memcpy(evt.peer_addr, peer_addr, 6);
            evt.mtu = cached_mtu;
            evt.disconnect_reason = static_cast<uint8_t>(event->disconnect.reason & 0xff);
            if (s_ble_event_queue) xQueueSend(s_ble_event_queue, &evt, 0);
            return 0;
        }
        case BLE_GAP_EVENT_MTU: {
            /* Update the cached MTU on the tracked connection so the
             * disconnect event later reflects the negotiated value, and so
             * notify payload validation uses the right ceiling. */
            portENTER_CRITICAL(&s_connections_mux);
            MIKBleConnection* conn = mik__ble_conn_find_locked(event->mtu.conn_handle);
            if (conn) conn->mtu = event->mtu.value;
            portEXIT_CRITICAL(&s_connections_mux);

            evt.type = MIK_BLE_EVT_MTU;
            evt.conn_handle = event->mtu.conn_handle;
            evt.mtu = event->mtu.value;
            if (s_ble_event_queue) xQueueSend(s_ble_event_queue, &evt, 0);
            return 0;
        }
        case BLE_GAP_EVENT_SUBSCRIBE: {
            /* Flip the subscription bits in the connection's notify/indicate
             * bitmaps. Used by mik__ble_notify to only send to subscribers. */
            MIKBleChar* chr = mik__ble_find_char_by_handle(event->subscribe.attr_handle);
            if (!chr) return 0;

            portENTER_CRITICAL(&s_connections_mux);
            MIKBleConnection* conn =
                mik__ble_conn_find_locked(event->subscribe.conn_handle);
            if (conn) {
                uint32_t bit = 1u << chr->global_idx;
                if (event->subscribe.cur_notify) {
                    conn->notify_subs |= bit;
                } else {
                    conn->notify_subs &= ~bit;
                }
                if (event->subscribe.cur_indicate) {
                    conn->indicate_subs |= bit;
                } else {
                    conn->indicate_subs &= ~bit;
                }
            }
            portEXIT_CRITICAL(&s_connections_mux);
            return 0;
        }
        default:
            return 0;
    }
}

/* ── NimBLE host task + callbacks ──────────────────────────────────── */

static void mik__ble_host_task(void* param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void mik__ble_on_sync(void) {
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) {
        rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    }
    if (rc != 0) {
        ESP_LOGW(MIK_BLE_TAG, "ble_hs_id_infer_auto failed: %d", rc);
    }

    s_nimble_sync_done = true;
    if (s_sync_sem) {
        xSemaphoreGive(s_sync_sem);
    }
}

static void mik__ble_on_reset(int reason) {
    ESP_LOGW(MIK_BLE_TAG, "NimBLE host reset (reason=%d)", reason);
    s_nimble_sync_done = false;
    s_advertising = false;
}

/* ── Lazy init and teardown ────────────────────────────────────────── */

/* Initializes the NimBLE stack on first use, optionally registering a GATT
 * table before the host task starts. Subsequent calls verify that any
 * provided new_table matches the already-registered set; mismatches return
 * MIK_ERR_BLE_GATT_ALREADY_REGISTERED.
 *
 * On success, ownership of new_table may transfer to s_gatt_table. The
 * caller should compare s_gatt_table == new_table to decide whether to
 * free the one it passed in.
 *
 * Returns 0 on success or a MIK_ERR_BLE_* code on failure. */
static int mik__ble_ensure_initialized(MIKBleGattTable* new_table) {
    if (s_nimble_initialized && s_nimble_sync_done) {
        if (new_table) {
            if (!s_gatt_table) {
                /* Stack came up without services, can't add them later. */
                return MIK_ERR_BLE_GATT_ALREADY_REGISTERED;
            }
            if (!mik__ble_tables_match(s_gatt_table, new_table)) {
                return MIK_ERR_BLE_GATT_ALREADY_REGISTERED;
            }
        }
        return 0;
    }

    if (!s_sync_sem) {
        s_sync_sem = xSemaphoreCreateBinary();
        if (!s_sync_sem) return MIK_ERR_BLE_STACK_INIT_FAILED;
    }

    if (!s_nimble_initialized) {
        /* Allocate write pool + connection table on first activation. Freed
         * in mik__ble_teardown. Any partial-failure path below must also
         * free these — teardown handles that unconditionally. */
        if (!s_write_pool_data) {
            s_write_pool_data = (uint8_t(*)[MIK_BLE_WRITE_POOL_BUF_SIZE])calloc(
                MIK_BLE_WRITE_POOL_SIZE, MIK_BLE_WRITE_POOL_BUF_SIZE);
            s_write_pool_used = (bool*)calloc(MIK_BLE_WRITE_POOL_SIZE, sizeof(bool));
            s_connections =
                (MIKBleConnection*)calloc(MIK_BLE_MAX_CONNECTIONS, sizeof(MIKBleConnection));
            if (!s_write_pool_data || !s_write_pool_used || !s_connections) {
                free(s_write_pool_data);
                s_write_pool_data = nullptr;
                free(s_write_pool_used);
                s_write_pool_used = nullptr;
                free(s_connections);
                s_connections = nullptr;
                return MIK_ERR_BLE_STACK_INIT_FAILED;
            }
        }

        esp_err_t err = nimble_port_init();
        if (err != ESP_OK) {
            ESP_LOGE(MIK_BLE_TAG, "nimble_port_init failed: %d", err);
            return MIK_ERR_BLE_STACK_INIT_FAILED;
        }

        ble_hs_cfg.sync_cb = mik__ble_on_sync;
        ble_hs_cfg.reset_cb = mik__ble_on_reset;

        ble_svc_gap_init();
        ble_svc_gatt_init();

        if (new_table && !new_table->svc_defs.empty()) {
            int rc = ble_gatts_count_cfg(new_table->svc_defs.data());
            if (rc != 0) {
                ESP_LOGE(MIK_BLE_TAG, "ble_gatts_count_cfg failed: %d", rc);
                return MIK_ERR_BLE_GATT_REGISTRATION_FAILED;
            }
            rc = ble_gatts_add_svcs(new_table->svc_defs.data());
            if (rc != 0) {
                ESP_LOGE(MIK_BLE_TAG, "ble_gatts_add_svcs failed: %d", rc);
                return MIK_ERR_BLE_GATT_REGISTRATION_FAILED;
            }
            s_gatt_table = new_table; /* take ownership */
        }

        mik__ble_set_default_name();
        ble_svc_gap_device_name_set(s_device_name);

        nimble_port_freertos_init(mik__ble_host_task);
        s_nimble_initialized = true;
    }

    if (!s_nimble_sync_done) {
        if (xSemaphoreTake(s_sync_sem, pdMS_TO_TICKS(5000)) != pdTRUE) {
            ESP_LOGE(MIK_BLE_TAG, "NimBLE sync timeout");
            return MIK_ERR_BLE_STACK_INIT_FAILED;
        }
    }

    return 0;
}

/* Free all JS event listeners and drain pending events from the queue.
 * Pool buffers attached to queued WRITE events are returned. */
static void mik__ble_cleanup_listeners_and_queue(JSContext* ctx) {
    if (ctx) {
        for (auto& v : s_on_connect) JS_FreeValue(ctx, v);
        s_on_connect.clear();
        for (auto& v : s_on_disconnect) JS_FreeValue(ctx, v);
        s_on_disconnect.clear();
        for (auto& v : s_on_mtu) JS_FreeValue(ctx, v);
        s_on_mtu.clear();
    }

    if (s_ble_event_queue) {
        MIKBleEvent evt;
        while (xQueueReceive(s_ble_event_queue, &evt, 0) == pdTRUE) {
            if (evt.type == MIK_BLE_EVT_WRITE && evt.write_data) {
                mik__ble_pool_free(evt.write_data);
            }
        }
    }
}

static esp_err_t mik__ble_teardown(JSContext* ctx) {
    if (!s_nimble_initialized) {
        if (s_gatt_table) {
            mik__ble_free_gatt_table(ctx, s_gatt_table);
            s_gatt_table = nullptr;
        }
        mik__ble_cleanup_listeners_and_queue(ctx);
        /* Release lazy-allocated buffers if init bailed partway. */
        free(s_write_pool_data);
        s_write_pool_data = nullptr;
        free(s_write_pool_used);
        s_write_pool_used = nullptr;
        free(s_connections);
        s_connections = nullptr;
        return ESP_OK;
    }

    if (s_advertising) {
        ble_gap_adv_stop();
        s_advertising = false;
    }

    int rc = nimble_port_stop();
    if (rc == 0) {
        nimble_port_deinit();
    } else {
        ESP_LOGW(MIK_BLE_TAG, "nimble_port_stop failed: %d", rc);
    }

    /* Disable + deinit the BT controller to reclaim RAM. These calls live
     * in mik_ble_c_shim.c because esp_bt.h cannot be included from C++. */
    mik_ble_controller_disable();
    mik_ble_controller_deinit();

    if (s_sync_sem) {
        vSemaphoreDelete(s_sync_sem);
        s_sync_sem = nullptr;
    }

    if (s_gatt_table) {
        mik__ble_free_gatt_table(ctx, s_gatt_table);
        s_gatt_table = nullptr;
    }

    mik__ble_cleanup_listeners_and_queue(ctx);

    /* Host task + GATT callbacks are gone after nimble_port_deinit, so
     * nothing else can touch these buffers. Free unconditionally — the
     * spinlock is unneeded once producers/consumers are torn down. */
    free(s_write_pool_data);
    s_write_pool_data = nullptr;
    free(s_write_pool_used);
    s_write_pool_used = nullptr;
    free(s_connections);
    s_connections = nullptr;

    s_nimble_initialized = false;
    s_nimble_sync_done = false;
    return ESP_OK;
}

/* ── Method implementations ────────────────────────────────────────── */

static JSValue mik__ble_get_name(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    if (s_device_name[0] == '\0') {
        mik__ble_set_default_name();
    }
    return JS_NewString(ctx, s_device_name);
}

static JSValue mik__ble_set_name(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 1) {
        return mik__result_err_named(ctx, "SetFailed", "missing name argument");
    }
    const char* name = JS_ToCString(ctx, argv[0]);
    if (!name) return JS_EXCEPTION;

    strncpy(s_device_name, name, sizeof(s_device_name) - 1);
    s_device_name[sizeof(s_device_name) - 1] = '\0';
    JS_FreeCString(ctx, name);

    if (s_nimble_initialized) {
        int rc = ble_svc_gap_device_name_set(s_device_name);
        if (rc != 0) {
            return mik__result_err_named(ctx, "SetFailed",
                                   "ble_svc_gap_device_name_set failed (rc=%d)", rc);
        }
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__ble_get_address(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    /* Read the BT MAC directly from efuse. This does not require the NimBLE
     * stack to be running — so callers can read the address without locking
     * themselves into broadcaster-only mode. */
    uint8_t addr[6] = {};
    esp_err_t err = esp_read_mac(addr, ESP_MAC_BT);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "GetFailed",
                               "failed to read BT MAC address (err=0x%x)", err);
    }

    char addr_str[18];
    snprintf(addr_str, sizeof(addr_str), "%02x:%02x:%02x:%02x:%02x:%02x", addr[0], addr[1],
             addr[2], addr[3], addr[4], addr[5]);
    return mik__result_ok(ctx, JS_NewString(ctx, addr_str));
}

static JSValue mik__ble_get_tx_power(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    int dbm = mik_ble_get_tx_power_dbm();
    return mik__result_ok(ctx, JS_NewInt32(ctx, dbm));
}

static JSValue mik__ble_set_tx_power(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 1) {
        return mik__result_err_named(ctx, "SetFailed", "missing txPower argument");
    }
    int32_t dbm;
    if (JS_ToInt32(ctx, &dbm, argv[0]) != 0) return JS_EXCEPTION;

    int rc = mik_ble_set_tx_power_dbm(static_cast<int>(dbm));
    if (rc != 0) {
        return mik__result_err_named(ctx, "SetFailed",
                               "failed to set TX power to %d dBm (rc=%d)", (int)dbm, rc);
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__ble_advertise(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;

    JSValue opts = argc > 0 ? argv[0] : JS_UNDEFINED;

    /* Parse GATT services from the options (if any). Ownership of new_table
     * transfers to s_gatt_table on successful first-time registration. */
    MIKBleGattTable* new_table = nullptr;
    if (JS_IsObject(opts)) {
        JSValue services_val = JS_GetPropertyStr(ctx, opts, "services");
        if (JS_IsArray(services_val)) {
            int build_err = mik__ble_build_gatt_table(ctx, services_val, &new_table);
            if (build_err != 0) {
                JS_FreeValue(ctx, services_val);
                return mik__result_err_named(ctx, mik__ble_code_to_name(build_err),
                                             "failed to build GATT service table");
            }
        }
        JS_FreeValue(ctx, services_val);
    }

    int init_err = mik__ble_ensure_initialized(new_table);
    if (init_err != 0) {
        /* If new_table wasn't adopted, free it. */
        if (new_table && s_gatt_table != new_table) {
            mik__ble_free_gatt_table(ctx, new_table);
        }
        return mik__result_err_named(ctx, mik__ble_code_to_name(init_err),
                                     "BLE stack initialization failed");
    }

    /* new_table was either adopted (s_gatt_table == new_table) or rejected
     * as a duplicate of the already-registered table (match case). In the
     * latter case, free the duplicate. */
    if (new_table && s_gatt_table != new_table) {
        mik__ble_free_gatt_table(ctx, new_table);
    }

    if (s_advertising) {
        return mik__result_err_named(ctx, "AlreadyAdvertising",
                               "BLE already advertising");
    }

    struct ble_hs_adv_fields fields = {};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;

    bool connectable = false;
    JSValue mfr_val = JS_UNDEFINED;
    JSValue iv_val = JS_UNDEFINED;
    JSValue min_val = JS_UNDEFINED;
    JSValue max_val = JS_UNDEFINED;

    if (JS_IsObject(opts)) {
        JSValue conn_val = JS_GetPropertyStr(ctx, opts, "connectable");
        if (!JS_IsUndefined(conn_val)) {
            connectable = JS_ToBool(ctx, conn_val);
        }
        JS_FreeValue(ctx, conn_val);

        JSValue name_val = JS_GetPropertyStr(ctx, opts, "name");
        if (JS_IsString(name_val)) {
            const char* name_str = JS_ToCString(ctx, name_val);
            if (name_str) {
                strncpy(s_device_name, name_str, sizeof(s_device_name) - 1);
                s_device_name[sizeof(s_device_name) - 1] = '\0';
                ble_svc_gap_device_name_set(s_device_name);
                JS_FreeCString(ctx, name_str);
            }
        }
        JS_FreeValue(ctx, name_val);

        JSValue tx_val = JS_GetPropertyStr(ctx, opts, "includeTxPower");
        if (JS_ToBool(ctx, tx_val)) {
            fields.tx_pwr_lvl_is_present = 1;
            fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;
        }
        JS_FreeValue(ctx, tx_val);

        mfr_val = JS_GetPropertyStr(ctx, opts, "manufacturerData");
        if (!JS_IsUndefined(mfr_val) && !JS_IsNull(mfr_val)) {
            size_t mfr_len = 0;
            const uint8_t* mfr_buf = JS_GetUint8Array(ctx, &mfr_len, mfr_val);
            if (mfr_buf && mfr_len > 0) {
                fields.mfg_data = mfr_buf;
                fields.mfg_data_len = static_cast<uint8_t>(mfr_len);
            }
        }

        iv_val = JS_GetPropertyStr(ctx, opts, "interval");
    }

    if (s_device_name[0] == '\0') {
        mik__ble_set_default_name();
        ble_svc_gap_device_name_set(s_device_name);
    }
    fields.name = reinterpret_cast<const uint8_t*>(s_device_name);
    fields.name_len = static_cast<uint8_t>(strlen(s_device_name));
    fields.name_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    JS_FreeValue(ctx, mfr_val);
    if (rc != 0) {
        JS_FreeValue(ctx, iv_val);
        return mik__result_err_named(ctx, "AdvertiseStartFailed",
                               "ble_gap_adv_set_fields failed (rc=%d)", rc);
    }

    struct ble_gap_adv_params adv_params = {};
    adv_params.conn_mode = connectable ? BLE_GAP_CONN_MODE_UND : BLE_GAP_CONN_MODE_NON;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    if (JS_IsObject(iv_val)) {
        min_val = JS_GetPropertyStr(ctx, iv_val, "min");
        max_val = JS_GetPropertyStr(ctx, iv_val, "max");
        double min_ms = 0;
        double max_ms = 0;
        if (JS_ToFloat64(ctx, &min_ms, min_val) == 0 &&
            JS_ToFloat64(ctx, &max_ms, max_val) == 0) {
            adv_params.itvl_min = static_cast<uint16_t>(min_ms / 0.625);
            adv_params.itvl_max = static_cast<uint16_t>(max_ms / 0.625);
        }
        JS_FreeValue(ctx, min_val);
        JS_FreeValue(ctx, max_val);
    }
    JS_FreeValue(ctx, iv_val);

    rc = ble_gap_adv_start(s_own_addr_type, nullptr, BLE_HS_FOREVER, &adv_params,
                           mik__ble_gap_event_cb, nullptr);
    if (rc != 0) {
        return mik__result_err_named(ctx, "AdvertiseStartFailed",
                               "ble_gap_adv_start failed (rc=%d)", rc);
    }

    s_advertising = true;
    return mik__result_ok_void(ctx);
}

static JSValue mik__ble_stop_advertising(JSContext* ctx, JSValue this_val, int argc,
                                         JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    if (!s_advertising) {
        return mik__result_ok_void(ctx);
    }
    int rc = ble_gap_adv_stop();
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        return mik__result_err_named(ctx, "AdvertiseStopFailed",
                               "ble_gap_adv_stop failed (rc=%d)", rc);
    }
    s_advertising = false;
    return mik__result_ok_void(ctx);
}

static JSValue mik__ble_stop(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    esp_err_t err = mik__ble_teardown(ctx);
    if (err != ESP_OK) {
        return mik__result_err_named(ctx, "StackShutdown",
                               "BLE stack shutdown failed (err=0x%x)", err);
    }
    return mik__result_ok_void(ctx);
}

/* Linear scan for a characteristic by NimBLE attribute handle. Used by
 * the loop consumer when dispatching write events to the JS handler. */
static MIKBleChar* mik__ble_find_char_by_handle(uint16_t attr_handle) {
    if (!s_gatt_table) return nullptr;
    for (auto& svc : s_gatt_table->services) {
        for (auto& chr : svc.chars) {
            if (chr.val_handle == attr_handle) return &chr;
        }
    }
    return nullptr;
}

/* Linear scan over the registered GATT table. The JS wrapper normalizes
 * UUIDs to lowercase before calling setValue, and the native side stores
 * the normalized strings from the original advertise() call, so direct
 * string comparison is sufficient. Returns nullptr if the characteristic
 * is not registered. */
static MIKBleChar* mik__ble_find_char(const char* svc_uuid_str,
                                      const char* chr_uuid_str) {
    if (!s_gatt_table || !svc_uuid_str || !chr_uuid_str) return nullptr;
    for (auto& svc : s_gatt_table->services) {
        if (svc.uuid_str != svc_uuid_str) continue;
        for (auto& chr : svc.chars) {
            if (chr.uuid_str == chr_uuid_str) return &chr;
        }
        return nullptr; /* service matched but characteristic didn't */
    }
    return nullptr;
}

static std::vector<JSValue>* mik__ble_listeners_for(const char* event_name) {
    if (strcmp(event_name, "connect") == 0) return &s_on_connect;
    if (strcmp(event_name, "disconnect") == 0) return &s_on_disconnect;
    if (strcmp(event_name, "mtu") == 0) return &s_on_mtu;
    return nullptr;
}

static JSValue mik__ble_on(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;

    const char* event_name = JS_ToCString(ctx, argv[0]);
    if (!event_name) return JS_EXCEPTION;

    JSValue func = argv[1];
    if (!JS_IsFunction(ctx, func)) {
        JS_FreeCString(ctx, event_name);
        return JS_ThrowTypeError(ctx, "expected argument 2 to be a function");
    }

    auto* listeners = mik__ble_listeners_for(event_name);
    if (listeners) {
        listeners->push_back(JS_DupValue(ctx, func));
    }

    JS_FreeCString(ctx, event_name);
    return JS_UNDEFINED;
}

static JSValue mik__ble_off(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;

    const char* event_name = JS_ToCString(ctx, argv[0]);
    if (!event_name) return JS_EXCEPTION;

    JSValue func = argv[1];
    auto* listeners = mik__ble_listeners_for(event_name);
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

/* Builds a structured AdvertisingPayloadTooLarge-style error object for
 * cases where the notify payload exceeds the negotiated MTU. We can't use
 * the generic mik__result_err helper because ValueTooLarge carries three
 * structured fields (uuid, bytes, max) instead of a single message string. */
static JSValue mik__ble_make_value_too_large(JSContext* ctx, const char* uuid_str,
                                             size_t bytes, size_t max) {
    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, "ValueTooLarge"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "uuid", JS_NewString(ctx, uuid_str), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "bytes", JS_NewInt32(ctx, (int32_t)bytes),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "max", JS_NewInt32(ctx, (int32_t)max), JS_PROP_C_W_E);

    JSValue obj = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", error, JS_PROP_C_W_E);
    return obj;
}

static JSValue mik__ble_notify(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 3) {
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "notify requires service UUID, characteristic UUID, and value");
    }

    const char* svc_uuid = JS_ToCString(ctx, argv[0]);
    if (!svc_uuid) return JS_EXCEPTION;
    const char* chr_uuid = JS_ToCString(ctx, argv[1]);
    if (!chr_uuid) {
        JS_FreeCString(ctx, svc_uuid);
        return JS_EXCEPTION;
    }

    MIKBleChar* chr = mik__ble_find_char(svc_uuid, chr_uuid);
    JS_FreeCString(ctx, svc_uuid);

    if (!chr) {
        JS_FreeCString(ctx, chr_uuid);
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "characteristic not found");
    }

    if (!(chr->properties & MIK_BLE_PROP_NOTIFY)) {
        JS_FreeCString(ctx, chr_uuid);
        return mik__result_err_named(ctx, "InvalidProperties",
                               "characteristic does not have notify property");
    }

    size_t value_len = 0;
    const uint8_t* value_buf = JS_GetUint8Array(ctx, &value_len, argv[2]);
    if (!value_buf) {
        JS_FreeCString(ctx, chr_uuid);
        return mik__result_err_named(ctx, "SetFailed",
                               "invalid value argument, expected Uint8Array");
    }

    if (!s_gatt_table || !s_gatt_table->value_mutex) {
        JS_FreeCString(ctx, chr_uuid);
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "GATT table not initialized");
    }

    /* Snapshot the set of subscribed connections and compute the minimum
     * MTU across them. Hold the critical section briefly to copy state. */
    struct SubSnapshot {
        uint16_t handle;
        uint16_t mtu;
    };
    SubSnapshot subs[MIK_BLE_MAX_CONNECTIONS];
    int sub_count = 0;
    uint16_t min_mtu = 0xFFFF;
    uint32_t bit = 1u << chr->global_idx;

    portENTER_CRITICAL(&s_connections_mux);
    for (int i = 0; i < MIK_BLE_MAX_CONNECTIONS; i++) {
        if (!s_connections[i].active) continue;
        if (!(s_connections[i].notify_subs & bit)) continue;
        subs[sub_count].handle = s_connections[i].handle;
        subs[sub_count].mtu = s_connections[i].mtu;
        if (s_connections[i].mtu < min_mtu) min_mtu = s_connections[i].mtu;
        sub_count++;
    }
    portEXIT_CRITICAL(&s_connections_mux);

    /* Always update the cached value, even if nobody is subscribed — that
     * way subsequent GATT reads see the current bytes, matching setValue
     * semantics. notify = setValue + push-to-subscribers. */
    xSemaphoreTake(s_gatt_table->value_mutex, portMAX_DELAY);
    chr->value.assign(value_buf, value_buf + value_len);
    xSemaphoreGive(s_gatt_table->value_mutex);

    if (sub_count == 0) {
        /* Silent no-op per plan: notify with no subscribers is success. */
        JS_FreeCString(ctx, chr_uuid);
        return mik__result_ok_void(ctx);
    }

    /* Validate payload against min(subscriber MTU) - 3 (ATT header). */
    size_t max_bytes = min_mtu > 3 ? (size_t)(min_mtu - 3) : 0;
    if (value_len > max_bytes) {
        JSValue err = mik__ble_make_value_too_large(ctx, chr_uuid, value_len, max_bytes);
        JS_FreeCString(ctx, chr_uuid);
        return err;
    }
    JS_FreeCString(ctx, chr_uuid);

    /* Blast notify to each subscriber. Per-subscriber failures are
     * logged but do not fail the overall call — notify is best-effort. */
    for (int i = 0; i < sub_count; i++) {
        struct os_mbuf* om = ble_hs_mbuf_from_flat(value_buf, value_len);
        if (!om) {
            ESP_LOGW(MIK_BLE_TAG, "notify mbuf alloc failed for conn %u", subs[i].handle);
            continue;
        }
        int rc = ble_gatts_notify_custom(subs[i].handle, chr->val_handle, om);
        if (rc != 0) {
            ESP_LOGW(MIK_BLE_TAG, "notify to conn %u failed: %d", subs[i].handle, rc);
            /* NimBLE frees the mbuf on both success and failure paths for
             * this API, so no cleanup needed here. */
        }
    }

    return mik__result_ok_void(ctx);
}

static JSValue mik__ble_set_value(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    if (argc < 3) {
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "setValue requires service UUID, characteristic UUID, and value");
    }

    const char* svc_uuid = JS_ToCString(ctx, argv[0]);
    if (!svc_uuid) return JS_EXCEPTION;
    const char* chr_uuid = JS_ToCString(ctx, argv[1]);
    if (!chr_uuid) {
        JS_FreeCString(ctx, svc_uuid);
        return JS_EXCEPTION;
    }

    MIKBleChar* chr = mik__ble_find_char(svc_uuid, chr_uuid);
    JS_FreeCString(ctx, svc_uuid);
    JS_FreeCString(ctx, chr_uuid);

    if (!chr) {
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "characteristic not found");
    }

    size_t value_len = 0;
    const uint8_t* value_buf = JS_GetUint8Array(ctx, &value_len, argv[2]);
    if (!value_buf) {
        return mik__result_err_named(ctx, "SetFailed",
                               "invalid value argument, expected Uint8Array");
    }

    if (!s_gatt_table || !s_gatt_table->value_mutex) {
        return mik__result_err_named(ctx, "NoSuchCharacteristic",
                               "GATT table not initialized");
    }

    xSemaphoreTake(s_gatt_table->value_mutex, portMAX_DELAY);
    chr->value.assign(value_buf, value_buf + value_len);
    xSemaphoreGive(s_gatt_table->value_mutex);

    return mik__result_ok_void(ctx);
}

/* ── JS class ──────────────────────────────────────────────────────── */

static JSClassID mik_ble_class_id;

static JSClassDef mik_ble_classdef = {
    .class_name = "Ble",
    .finalizer = nullptr,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

static JSValue mik__ble_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    (void)new_target;
    (void)argc;
    (void)argv;
    return JS_NewObjectClass(ctx, mik_ble_class_id);
}

static const JSCFunctionListEntry mik__ble_proto_funcs[] = {
    MIK_CFUNC_DEF("getName", 0, mik__ble_get_name),
    MIK_CFUNC_DEF("setName", 1, mik__ble_set_name),
    MIK_CFUNC_DEF("getAddress", 0, mik__ble_get_address),
    MIK_CFUNC_DEF("getTxPower", 0, mik__ble_get_tx_power),
    MIK_CFUNC_DEF("setTxPower", 1, mik__ble_set_tx_power),
    MIK_CFUNC_DEF("advertise", 1, mik__ble_advertise),
    MIK_CFUNC_DEF("stopAdvertising", 0, mik__ble_stop_advertising),
    MIK_CFUNC_DEF("stop", 0, mik__ble_stop),
    MIK_CFUNC_DEF("setValue", 3, mik__ble_set_value),
    MIK_CFUNC_DEF("notify", 3, mik__ble_notify),
    MIK_CFUNC_DEF("on", 2, mik__ble_on),
    MIK_CFUNC_DEF("off", 2, mik__ble_off),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__ble_module_init(JSContext* ctx, JSModuleDef* m) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &mik_ble_class_id);
    JS_NewClass(rt, mik_ble_class_id, &mik_ble_classdef);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik__ble_proto_funcs, countof(mik__ble_proto_funcs));
    JS_SetClassProto(ctx, mik_ble_class_id, proto);

    JSValue ctor =
        JS_NewCFunction2(ctx, mik__ble_constructor, "Ble", 0, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "Ble", ctor);
    return 0;
}

static JSModuleDef* mik__ble_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    mik__ble_slot = MIK_AllocModuleSlot(mik_rt);

    auto* state = new MIKBleState();
    mik__ble_st(mik_rt) = state;

    /* Create the event queue lazily on first module import. Shared between
     * the NimBLE host task (producers) and the JS loop thread (consumer). */
    if (!s_ble_event_queue) {
        s_ble_event_queue = xQueueCreate(MIK_BLE_EVENT_QUEUE_DEPTH, sizeof(MIKBleEvent));
        CHECK_NOT_NULL(s_ble_event_queue);
    }

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/ble", mik__ble_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Ble");
    return m;
}

/* ── Event loop + destroy ──────────────────────────────────────────── */

/* Build a {id, address, mtu} connection info object for connect and
 * disconnect events. peer_addr is in NimBLE internal little-endian order;
 * reverse for display. */
static JSValue mik__ble_build_conn_info(JSContext* ctx, uint16_t conn_handle,
                                        const uint8_t* peer_addr, uint16_t mtu) {
    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "id", JS_NewInt32(ctx, conn_handle));
    char addr_str[18];
    snprintf(addr_str, sizeof(addr_str), "%02x:%02x:%02x:%02x:%02x:%02x", peer_addr[5],
             peer_addr[4], peer_addr[3], peer_addr[2], peer_addr[1], peer_addr[0]);
    JS_SetPropertyStr(ctx, info, "address", JS_NewString(ctx, addr_str));
    JS_SetPropertyStr(ctx, info, "mtu", JS_NewInt32(ctx, mtu));
    return info;
}

static JSValue mik__ble_build_mtu_info(JSContext* ctx, uint16_t conn_handle, uint16_t mtu) {
    JSValue info = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, info, "id", JS_NewInt32(ctx, conn_handle));
    JS_SetPropertyStr(ctx, info, "mtu", JS_NewInt32(ctx, mtu));
    return info;
}

void mik__ble_consume(JSContext* ctx) {
    if (!s_ble_event_queue) return;

    MIKBleEvent evt;
    while (xQueueReceive(s_ble_event_queue, &evt, 0) == pdTRUE) {
        switch (evt.type) {
            case MIK_BLE_EVT_CONNECT: {
                JSValue info =
                    mik__ble_build_conn_info(ctx, evt.conn_handle, evt.peer_addr, evt.mtu);
                for (auto& listener : s_on_connect) {
                    mik_call_handler(ctx, listener, 1, &info);
                }
                JS_FreeValue(ctx, info);
                break;
            }
            case MIK_BLE_EVT_DISCONNECT: {
                JSValue info =
                    mik__ble_build_conn_info(ctx, evt.conn_handle, evt.peer_addr, evt.mtu);
                for (auto& listener : s_on_disconnect) {
                    mik_call_handler(ctx, listener, 1, &info);
                }
                JS_FreeValue(ctx, info);
                break;
            }
            case MIK_BLE_EVT_MTU: {
                JSValue info = mik__ble_build_mtu_info(ctx, evt.conn_handle, evt.mtu);
                for (auto& listener : s_on_mtu) {
                    mik_call_handler(ctx, listener, 1, &info);
                }
                JS_FreeValue(ctx, info);
                break;
            }
            case MIK_BLE_EVT_WRITE: {
                MIKBleChar* chr = mik__ble_find_char_by_handle(evt.attr_handle);
                if (chr && !JS_IsUndefined(chr->on_write)) {
                    JSValue buf =
                        JS_NewUint8ArrayCopy(ctx, evt.write_data, evt.write_data_len);
                    mik_call_handler(ctx, chr->on_write, 1, &buf);
                    JS_FreeValue(ctx, buf);
                }
                mik__ble_pool_free(evt.write_data);
                break;
            }
        }
    }
}

void mik__ble_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__ble_st(mik_rt)) return;

    mik__ble_teardown(ctx);

    if (s_ble_event_queue) {
        vQueueDelete(s_ble_event_queue);
        s_ble_event_queue = nullptr;
    }

    delete mik__ble_st(mik_rt);
    mik__ble_st(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(ble, "native:mikro/ble", mik__ble_init, mik__ble_consume, mik__ble_destroy)

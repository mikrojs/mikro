#include <cstring>

#include "driver/i2c_master.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_I2C_TAG "native:mikro/i2c"
#define MIK_I2C_DEFAULT_FREQ 100000
#define MIK_I2C_DEFAULT_TIMEOUT_MS 100
#define MIK_I2C_SCAN_START 0x08
#define MIK_I2C_SCAN_END 0x77
#define MIK_I2C_MAX_PENDING_WRITE 256

static JSClassID mik_i2c_class_id;

typedef struct {
    i2c_master_bus_handle_t bus;
    int32_t port;       // 0 or 1
    int32_t sda;
    int32_t scl;
    uint32_t freq;
    int32_t timeout_ms;
    bool begun;
    /* Pending write buffer for stop=false (used with transmit_receive) */
    uint8_t pending_write[MIK_I2C_MAX_PENDING_WRITE];
    size_t pending_write_len;
    uint16_t pending_write_addr;
    bool has_pending_write;
} MIKI2CState;

/* ── Helpers ───────────────────────────────────────────────────────── */

static MIKI2CState* mik__i2c_get(JSContext* ctx, JSValue this_val) {
    auto* s = static_cast<MIKI2CState*>(JS_GetOpaque2(ctx, this_val, mik_i2c_class_id));
    return s;
}

static void mik__i2c_clear_pending(MIKI2CState* s) {
    s->has_pending_write = false;
    s->pending_write_len = 0;
}

static esp_err_t mik__i2c_add_device(MIKI2CState* s, uint16_t addr,
                                      i2c_master_dev_handle_t* out_dev) {
    i2c_device_config_t dev_cfg = {};
    dev_cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dev_cfg.device_address = addr;
    dev_cfg.scl_speed_hz = s->freq;
    return i2c_master_bus_add_device(s->bus, &dev_cfg, out_dev);
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__i2c_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKI2CState*>(JS_GetOpaque(val, mik_i2c_class_id));
    if (!s) return;
    if (s->begun) {
        i2c_del_master_bus(s->bus);
    }
    free(s);
}

static JSClassDef mik_i2c_class = {
    .class_name = "I2c",
    .finalizer = mik__i2c_finalizer,
};

/* ── Constructor ───────────────────────────────────────────────────── */

static JSValue js_i2c_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    if (argc < 1) return JS_ThrowTypeError(ctx, "I2c requires busNo argument");

    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[0])) return JS_EXCEPTION;
    if (port < 0 || port > 1) return JS_ThrowRangeError(ctx, "busNo must be 0 or 1");

    auto* s = static_cast<MIKI2CState*>(calloc(1, sizeof(MIKI2CState)));
    if (!s) return JS_ThrowOutOfMemory(ctx);

    s->port = port;
    s->sda = -1;
    s->scl = -1;
    s->freq = MIK_I2C_DEFAULT_FREQ;
    s->timeout_ms = MIK_I2C_DEFAULT_TIMEOUT_MS;
    s->begun = false;
    mik__i2c_clear_pending(s);

    /* Parse options object */
    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValue opts = argv[1];
        JSValue v;

        v = JS_GetPropertyStr(ctx, opts, "sda");
        if (!JS_IsUndefined(v)) {
            if (JS_ToInt32(ctx, &s->sda, v)) {
                JS_FreeValue(ctx, v);
                free(s);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, v);

        v = JS_GetPropertyStr(ctx, opts, "scl");
        if (!JS_IsUndefined(v)) {
            if (JS_ToInt32(ctx, &s->scl, v)) {
                JS_FreeValue(ctx, v);
                free(s);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, v);

        v = JS_GetPropertyStr(ctx, opts, "freq");
        if (!JS_IsUndefined(v)) {
            int32_t freq;
            if (JS_ToInt32(ctx, &freq, v)) {
                JS_FreeValue(ctx, v);
                free(s);
                return JS_EXCEPTION;
            }
            s->freq = static_cast<uint32_t>(freq);
        }
        JS_FreeValue(ctx, v);

        v = JS_GetPropertyStr(ctx, opts, "timeout");
        if (!JS_IsUndefined(v)) {
            if (JS_ToInt32(ctx, &s->timeout_ms, v)) {
                JS_FreeValue(ctx, v);
                free(s);
                return JS_EXCEPTION;
            }
        }
        JS_FreeValue(ctx, v);
    }

    JSValue obj = JS_NewObjectClass(ctx, mik_i2c_class_id);
    if (JS_IsException(obj)) {
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── Methods ───────────────────────────────────────────────────────── */

static JSValue js_i2c_begin(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->begun) return mik__result_ok_void(ctx);  // idempotent

    if (s->sda < 0 || s->scl < 0) return mik__result_err_tag(ctx, "MissingPins");

    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(s->port);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(s->sda);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(s->scl);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s->bus);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "BusInitFailed",
                                     "failed to initialize I2C bus %d: %s", s->port,
                                     esp_err_to_name(err));

    s->begun = true;
    mik__i2c_clear_pending(s);
    return mik__result_ok_void(ctx);
}

static JSValue js_i2c_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_ok_void(ctx);  // idempotent

    mik__i2c_clear_pending(s);
    esp_err_t err = i2c_del_master_bus(s->bus);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "BusDeinitFailed",
                                     "failed to deinitialize I2C bus: %s", esp_err_to_name(err));

    s->bus = nullptr;
    s->begun = false;
    return mik__result_ok_void(ctx);
}

static JSValue js_i2c_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");

    int32_t addr;
    if (JS_ToInt32(ctx, &addr, argv[0])) return JS_EXCEPTION;

    size_t data_len;
    uint8_t* data;

    /* Try typed array (Uint8Array) first, then raw ArrayBuffer */
    size_t offset, elem_size;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[1], &offset, &data_len, &elem_size);
    if (!JS_IsException(ab)) {
        data = JS_GetArrayBuffer(ctx, &data_len, ab);
        JS_FreeValue(ctx, ab);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 2");
        data += offset;
    } else {
        /* Clear the pending exception from GetTypedArrayBuffer and try raw ArrayBuffer */
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        data = JS_GetArrayBuffer(ctx, &data_len, argv[1]);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 2");
    }

    /* Check stop parameter (default: true) */
    bool stop = true;
    if (argc >= 3 && !JS_IsUndefined(argv[2])) {
        stop = JS_ToBool(ctx, argv[2]);
    }

    if (!stop) {
        /* Buffer write data for later transmit_receive */
        if (data_len > MIK_I2C_MAX_PENDING_WRITE)
            return mik__result_err_tag(ctx, "WriteTooLarge");
        memcpy(s->pending_write, data, data_len);
        s->pending_write_len = data_len;
        s->pending_write_addr = static_cast<uint16_t>(addr);
        s->has_pending_write = true;
        return mik__result_ok_void(ctx);
    }

    /* Normal write with STOP */
    mik__i2c_clear_pending(s);

    i2c_master_dev_handle_t dev;
    esp_err_t err = mik__i2c_add_device(s, static_cast<uint16_t>(addr), &dev);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "AddDeviceFailed",
                                     "failed to add I2C device 0x%02x: %s", addr,
                                     esp_err_to_name(err));

    err = i2c_master_transmit(dev, data, data_len, s->timeout_ms);
    i2c_master_bus_rm_device(dev);

    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WriteFailed",
                                     "I2C write to 0x%02x failed: %s", addr,
                                     esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

static JSValue js_i2c_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");

    int32_t addr;
    if (JS_ToInt32(ctx, &addr, argv[0])) return JS_EXCEPTION;

    int32_t bytes;
    if (JS_ToInt32(ctx, &bytes, argv[1])) return JS_EXCEPTION;
    if (bytes <= 0) return JS_ThrowRangeError(ctx, "read length must be > 0");

    /* Allocate with js_malloc — MIK_NewUint8Array takes ownership and frees via js_free_rt */
    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, bytes));
    if (!buf) return JS_EXCEPTION;

    i2c_master_dev_handle_t dev;
    esp_err_t err = mik__i2c_add_device(s, static_cast<uint16_t>(addr), &dev);
    if (err != ESP_OK) {
        js_free(ctx, buf);
        return mik__result_err_named(ctx, "AddDeviceFailed",
                                     "failed to add I2C device 0x%02x: %s", addr,
                                     esp_err_to_name(err));
    }

    if (s->has_pending_write && s->pending_write_addr == static_cast<uint16_t>(addr)) {
        /* Combined write-read (ReSTART) via transmit_receive */
        err = i2c_master_transmit_receive(dev, s->pending_write, s->pending_write_len, buf, bytes,
                                          s->timeout_ms);
        mik__i2c_clear_pending(s);
    } else {
        mik__i2c_clear_pending(s);
        err = i2c_master_receive(dev, buf, bytes, s->timeout_ms);
    }

    i2c_master_bus_rm_device(dev);

    if (err != ESP_OK) {
        js_free(ctx, buf);
        return mik__result_err_named(ctx, "ReadFailed",
                                     "I2C read from 0x%02x failed: %s", addr,
                                     esp_err_to_name(err));
    }

    /* MIK_NewUint8Array takes ownership of buf — do NOT free it */
    return mik__result_ok(ctx, MIK_NewUint8Array(ctx, buf, bytes));
}

static JSValue js_i2c_scan(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");

    /* Worst case: all addresses respond */
    uint8_t found[MIK_I2C_SCAN_END - MIK_I2C_SCAN_START + 1];
    int count = 0;

    for (int addr = MIK_I2C_SCAN_START; addr <= MIK_I2C_SCAN_END; addr++) {
        esp_err_t err = i2c_master_probe(s->bus, static_cast<uint16_t>(addr), s->timeout_ms);
        if (err == ESP_OK) {
            found[count++] = static_cast<uint8_t>(addr);
        }
    }

    size_t alloc_size = count > 0 ? count : 1;
    auto* result = static_cast<uint8_t*>(js_malloc(ctx, alloc_size));
    if (!result) return JS_EXCEPTION;
    if (count > 0) memcpy(result, found, count);

    /* MIK_NewUint8Array takes ownership of result — do NOT free it */
    return mik__result_ok(ctx, MIK_NewUint8Array(ctx, result, count));
}

/* ── Prototype ─────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_i2c_proto_funcs[] = {
    MIK_CFUNC_DEF("begin", 0, js_i2c_begin),
    MIK_CFUNC_DEF("end", 0, js_i2c_end),
    MIK_CFUNC_DEF("write", 3, js_i2c_write),
    MIK_CFUNC_DEF("read", 2, js_i2c_read),
    MIK_CFUNC_DEF("scan", 0, js_i2c_scan),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__i2c_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor = JS_NewCFunction2(ctx, js_i2c_constructor, "I2c", 2, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "I2c", ctor);
    return 0;
}

static JSModuleDef* mik__i2c_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    JS_NewClassID(rt, &mik_i2c_class_id);
    JS_NewClass(rt, mik_i2c_class_id, &mik_i2c_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_i2c_proto_funcs, countof(mik_i2c_proto_funcs));
    JS_SetClassProto(ctx, mik_i2c_class_id, proto);  /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/i2c", mik__i2c_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "I2c");
    return m;
}

MIK_REGISTER_MODULE(i2c, "native:mikro/i2c", mik__i2c_init, nullptr, nullptr)

#include <cmath>
#include <cstring>

#include "driver/i2c_master.h"
#include "soc/soc_caps.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

#define MIK_I2C_DEFAULT_FREQ 100000
#define MIK_I2C_DEFAULT_TIMEOUT_MS 100
#define MIK_I2C_SCAN_START 0x08
#define MIK_I2C_SCAN_END 0x77
#define MIK_I2C_MAX_PENDING_WRITE 256
#define MIK_I2C_MAX_READ 65535

static JSClassID mik_i2c_class_id;

typedef struct {
    i2c_master_bus_handle_t bus;
    int port;
    int sda;
    int scl;
    uint32_t freq;
    int timeout_ms;
    bool active;
    bool warned_after_end;
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

/* Deletes the bus and releases its GPIO pins. */
static void mik__i2c_release(MIKI2CState* s) {
    mik__i2c_clear_pending(s);
    i2c_del_master_bus(s->bus);
    s->bus = nullptr;
    const int gpios[] = {s->sda, s->scl};
    mik__release_gpios(gpios, countof(gpios), "I2c");
    s->active = false;
}

/* True when the handle was ended; the first such call prints a warning. */
static bool mik__i2c_ended(MIKI2CState* s, const char* call) {
    if (s->active) return false;
    mik__warn_after_end(&s->warned_after_end, "I2c", s->port, call, "bus");
    return true;
}

/* JS_UNDEFINED for a 7-bit address, else the InvalidParam Result. */
static JSValue mik__i2c_check_address(JSContext* ctx, double addr) {
    if (addr >= 0 && addr <= 0x7f && std::trunc(addr) == addr) return JS_UNDEFINED;
    return mik__result_err_named(ctx, "InvalidParam",
                                 "address must be an integer from 0 to 0x7f, got %g", addr);
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__i2c_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKI2CState*>(JS_GetOpaque(val, mik_i2c_class_id));
    if (!s) return;
    if (s->active) mik__i2c_release(s);
    free(s);
}

static JSClassDef mik_i2c_class = {
    .class_name = "I2c",
    .finalizer = mik__i2c_finalizer,
};

/* ── Factory ───────────────────────────────────────────────────────── */

/* I2c(bus, {sda, scl, freq?, timeout?}) → Result<I2c, I2cError> */
static JSValue js_i2c(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t port;
    JSValueConst options;
    int32_t sda32, scl32;
    double freq = MIK_I2C_DEFAULT_FREQ;
    double timeout = MIK_I2C_DEFAULT_TIMEOUT_MS;
    if (mik__to_int_arg(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED, "bus", &port) ||
        mik__options_arg(ctx, argc, argv, 1, true, &options) ||
        mik__int_option(ctx, options, "sda", true, &sda32) ||
        mik__int_option(ctx, options, "scl", true, &scl32) ||
        mik__number_option(ctx, options, "freq", false, &freq) ||
        mik__number_option(ctx, options, "timeout", false, &timeout))
        return JS_EXCEPTION;
    int sda = sda32, scl = scl32;

    /* Only the HP controllers: the C6's second I2C_NUM is the LP controller. */
    const int max_bus = SOC_HP_I2C_NUM - 1;
    if (port < 0 || port > max_bus) {
        if (max_bus == 0)
            return mik__result_err_named(ctx, "InvalidParam", "bus must be 0 on %s, got %d",
                                         CONFIG_IDF_TARGET, (int)port);
        return mik__result_err_named(ctx, "InvalidParam", "bus must be 0 to %d on %s, got %d",
                                     max_bus, CONFIG_IDF_TARGET, (int)port);
    }
    if (!(freq >= 1 && freq <= UINT32_MAX))
        return mik__result_err_named(ctx, "InvalidParam", "freq must be at least 1 Hz, got %g",
                                     freq);
    if (!(timeout >= 0 && timeout <= INT32_MAX))
        return mik__result_err_named(ctx, "InvalidParam", "timeout must be 0 ms or more, got %g",
                                     timeout);
    const MIKGpioCheck checks[] = {{sda, true}, {scl, true}};
    JSValue invalid = mik__gpio_check(ctx, checks, countof(checks));
    if (!JS_IsUndefined(invalid)) return invalid;
    const int gpios[] = {sda, scl};
    JSValue claim_failed = mik__claim_gpios(ctx, gpios, countof(gpios), "I2c");
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(port);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(sda);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(scl);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    i2c_master_bus_handle_t bus = nullptr;
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
    if (err != ESP_OK) {
        mik__release_gpios(gpios, countof(gpios), "I2c");
        return mik__result_err_named(ctx, "BusInitFailed", "failed to initialize I2C bus %d: %s",
                                     (int)port, esp_err_to_name(err));
    }

    auto* s = static_cast<MIKI2CState*>(calloc(1, sizeof(MIKI2CState)));
    if (!s) {
        i2c_del_master_bus(bus);
        mik__release_gpios(gpios, countof(gpios), "I2c");
        return JS_ThrowOutOfMemory(ctx);
    }
    s->bus = bus;
    s->port = port;
    s->sda = sda;
    s->scl = scl;
    s->freq = static_cast<uint32_t>(freq);
    s->timeout_ms = static_cast<int>(timeout);
    s->active = true;

    JSValue obj = JS_NewObjectClass(ctx, mik_i2c_class_id);
    if (JS_IsException(obj)) {
        mik__i2c_release(s);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return mik__result_ok(ctx, obj);
}

/* ── Methods ───────────────────────────────────────────────────────── */

/* end() — deletes the bus; calling it again does nothing */
static JSValue js_i2c_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->active) mik__i2c_release(s);
    return JS_UNDEFINED;
}

static JSValue js_i2c_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2c_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;

    double addr_num;
    if (mik__to_number_arg(ctx, argv[0], "address", &addr_num)) return JS_EXCEPTION;
    size_t data_len;
    uint8_t* data = mik__bytes_arg(ctx, argv[1], "data", &data_len);
    if (!data) return JS_EXCEPTION;
    /* Check stop parameter (default: true) */
    bool stop = true;
    if (argc >= 3 && !JS_IsUndefined(argv[2])) {
        if (!JS_IsBool(argv[2])) return JS_ThrowTypeError(ctx, "stop must be a boolean");
        stop = JS_ToBool(ctx, argv[2]);
    }
    if (mik__i2c_ended(s, "write()")) return mik__result_ok_void(ctx);
    JSValue invalid = mik__i2c_check_address(ctx, addr_num);
    if (!JS_IsUndefined(invalid)) return invalid;
    auto addr = static_cast<uint16_t>(addr_num);

    if (!stop) {
        /* Buffer write data for later transmit_receive */
        if (data_len > MIK_I2C_MAX_PENDING_WRITE)
            return mik__result_err_tag(ctx, "WriteTooLarge");
        memcpy(s->pending_write, data, data_len);
        s->pending_write_len = data_len;
        s->pending_write_addr = addr;
        s->has_pending_write = true;
        return mik__result_ok_void(ctx);
    }

    /* Normal write with STOP */
    mik__i2c_clear_pending(s);

    i2c_master_dev_handle_t dev;
    esp_err_t err = mik__i2c_add_device(s, addr, &dev);
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

    double addr_num;
    double length;
    if (mik__to_number_arg(ctx, argv[0], "address", &addr_num) ||
        mik__to_number_arg(ctx, argv[1], "bytes", &length))
        return JS_EXCEPTION;
    if (mik__i2c_ended(s, "read()"))
        return mik__result_ok(ctx, JS_NewUint8ArrayCopy(ctx, nullptr, 0));
    JSValue invalid = mik__i2c_check_address(ctx, addr_num);
    if (!JS_IsUndefined(invalid)) return invalid;
    auto addr = static_cast<uint16_t>(addr_num);
    if (!(length >= 1 && length <= MIK_I2C_MAX_READ && std::trunc(length) == length))
        return mik__result_err_named(ctx, "InvalidParam",
                                     "bytes must be an integer from 1 to %d, got %g",
                                     MIK_I2C_MAX_READ, length);
    auto bytes = static_cast<size_t>(length);

    /* Allocate with js_malloc — MIK_NewUint8Array takes ownership and frees via js_free_rt */
    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, bytes));
    if (!buf) return JS_EXCEPTION;

    i2c_master_dev_handle_t dev;
    esp_err_t err = mik__i2c_add_device(s, addr, &dev);
    if (err != ESP_OK) {
        js_free(ctx, buf);
        return mik__result_err_named(ctx, "AddDeviceFailed",
                                     "failed to add I2C device 0x%02x: %s", addr,
                                     esp_err_to_name(err));
    }

    if (s->has_pending_write && s->pending_write_addr == addr) {
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
    if (mik__i2c_ended(s, "scan()"))
        return mik__result_ok(ctx, JS_NewUint8ArrayCopy(ctx, nullptr, 0));

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
    MIK_CFUNC_DEF("end", 0, js_i2c_end),
    MIK_CFUNC_DEF("write", 3, js_i2c_write),
    MIK_CFUNC_DEF("read", 2, js_i2c_read),
    MIK_CFUNC_DEF("scan", 0, js_i2c_scan),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__i2c_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "I2c", JS_NewCFunction(ctx, js_i2c, "I2c", 2));
    return 0;
}

static JSModuleDef* mik__i2c_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    MIK_NewClassID(rt, &mik_i2c_class_id);
    JS_NewClass(rt, mik_i2c_class_id, &mik_i2c_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_i2c_proto_funcs, countof(mik_i2c_proto_funcs));
    JS_SetClassProto(ctx, mik_i2c_class_id, proto); /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/i2c", mik__i2c_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "I2c");
    return m;
}

MIK__REGISTER_PUBLIC_MODULE(i2c, "mikro/i2c", mik__i2c_init, nullptr, nullptr)

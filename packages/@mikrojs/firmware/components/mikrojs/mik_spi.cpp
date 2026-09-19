#include <cstring>

#include "driver/spi_master.h"
#include "soc/soc_caps.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

#define MIK_SPI_DEFAULT_FREQ 1000000

static JSClassID mik_spi_class_id;

typedef struct {
    spi_device_handle_t device;
    spi_host_device_t host;
    int clk;
    int mosi;
    int miso;
    int cs;
    bool active;
    bool warned_after_end;
} MIKSPIState;

/* ── Helpers ───────────────────────────────────────────────────────── */

static MIKSPIState* mik__spi_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKSPIState*>(JS_GetOpaque2(ctx, this_val, mik_spi_class_id));
}

/* Removes the device, frees the bus and releases the GPIO pins. */
static void mik__spi_release(MIKSPIState* s) {
    spi_bus_remove_device(s->device);
    s->device = nullptr;
    spi_bus_free(s->host);
    const int gpios[] = {s->clk, s->mosi, s->miso, s->cs};
    mik__release_gpios(gpios, countof(gpios), "Spi");
    s->active = false;
}

/* True when the handle was ended; the first such call prints a warning. */
static bool mik__spi_ended(MIKSPIState* s, const char* call) {
    if (s->active) return false;
    mik__warn_after_end(&s->warned_after_end, "Spi", s->host, call, "bus");
    return true;
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__spi_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKSPIState*>(JS_GetOpaque(val, mik_spi_class_id));
    if (!s) return;
    if (s->active) mik__spi_release(s);
    free(s);
}

static JSClassDef mik_spi_class = {
    .class_name = "Spi",
    .finalizer = mik__spi_finalizer,
};

/* ── Factory ───────────────────────────────────────────────────────── */

/* Spi(host, {clk, mosi, miso?, cs?, freq?, mode?}) → Result<Spi, SpiError> */
static JSValue js_spi(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t host;
    JSValueConst options;
    int32_t clk32, mosi32, miso32 = -1, cs32 = -1, mode = 0;
    double freq = MIK_SPI_DEFAULT_FREQ;
    if (mik__to_int_arg(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED, "host", &host) ||
        mik__options_arg(ctx, argc, argv, 1, true, &options) ||
        mik__int_option(ctx, options, "clk", true, &clk32) ||
        mik__int_option(ctx, options, "mosi", true, &mosi32) ||
        mik__int_option(ctx, options, "miso", false, &miso32) ||
        mik__int_option(ctx, options, "cs", false, &cs32) ||
        mik__number_option(ctx, options, "freq", false, &freq) ||
        mik__int_option(ctx, options, "mode", false, &mode))
        return JS_EXCEPTION;
    if (mode < 0 || mode > 3) return JS_ThrowTypeError(ctx, "mode must be 0, 1, 2 or 3");
    int clk = clk32, mosi = mosi32, miso = miso32, cs = cs32;

    /* SOC_SPI_PERIPH_NUM includes SPI1 (flash), so user-available hosts are 1..N-1 */
    const int max_host = SOC_SPI_PERIPH_NUM - 1;
    if (host < 1 || host > max_host) {
        if (max_host == 1)
            return mik__result_err_named(ctx, "InvalidParam", "host must be 1 on %s, got %d",
                                         CONFIG_IDF_TARGET, (int)host);
        return mik__result_err_named(ctx, "InvalidParam", "host must be 1 to %d on %s, got %d",
                                     max_host, CONFIG_IDF_TARGET, (int)host);
    }
    if (!(freq >= 1 && freq <= INT32_MAX))
        return mik__result_err_named(ctx, "InvalidParam", "freq must be at least 1 Hz, got %g",
                                     freq);
    const MIKGpioCheck checks[] = {{clk, true}, {mosi, true}, {miso, false}, {cs, true}};
    JSValue invalid = mik__gpio_check(ctx, checks, countof(checks));
    if (!JS_IsUndefined(invalid)) return invalid;
    const int gpios[] = {clk, mosi, miso, cs};
    JSValue claim_failed = mik__claim_gpios(ctx, gpios, countof(gpios), "Spi");
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    /* SPI2_HOST is 1, SPI3_HOST is 2, etc. — host maps directly */
    auto host_id = static_cast<spi_host_device_t>(host);
    spi_bus_config_t bus_cfg = {};
    bus_cfg.mosi_io_num = mosi;
    bus_cfg.miso_io_num = miso;  // -1 if not set
    bus_cfg.sclk_io_num = clk;
    bus_cfg.quadwp_io_num = -1;
    bus_cfg.quadhd_io_num = -1;
    bus_cfg.max_transfer_sz = 32768;

    esp_err_t err = spi_bus_initialize(host_id, &bus_cfg, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        mik__release_gpios(gpios, countof(gpios), "Spi");
        return mik__result_err_named(ctx, "BusInitFailed", "SPI bus init failed: %s",
                                     esp_err_to_name(err));
    }

    spi_device_interface_config_t dev_cfg = {};
    dev_cfg.clock_speed_hz = static_cast<int>(freq);
    dev_cfg.mode = mode;
    dev_cfg.spics_io_num = cs;  // -1 if not set (manual CS)
    dev_cfg.queue_size = 1;
    /* Write-only devices (displays) don't need dummy bits for high clock speeds */
    if (miso < 0) {
        dev_cfg.flags = SPI_DEVICE_NO_DUMMY;
    }

    spi_device_handle_t device = nullptr;
    err = spi_bus_add_device(host_id, &dev_cfg, &device);
    if (err != ESP_OK) {
        spi_bus_free(host_id);
        mik__release_gpios(gpios, countof(gpios), "Spi");
        return mik__result_err_named(ctx, "AddDeviceFailed", "failed to add SPI device: %s",
                                     esp_err_to_name(err));
    }

    auto* s = static_cast<MIKSPIState*>(calloc(1, sizeof(MIKSPIState)));
    if (!s) {
        spi_bus_remove_device(device);
        spi_bus_free(host_id);
        mik__release_gpios(gpios, countof(gpios), "Spi");
        return JS_ThrowOutOfMemory(ctx);
    }
    s->device = device;
    s->host = host_id;
    s->clk = clk;
    s->mosi = mosi;
    s->miso = miso;
    s->cs = cs;
    s->active = true;

    JSValue obj = JS_NewObjectClass(ctx, mik_spi_class_id);
    if (JS_IsException(obj)) {
        mik__spi_release(s);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return mik__result_ok(ctx, obj);
}

/* ── Methods ───────────────────────────────────────────────────────── */

/* end() — frees the bus; calling it again does nothing */
static JSValue js_spi_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->active) mik__spi_release(s);
    return JS_UNDEFINED;
}

static JSValue js_spi_transfer(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    size_t data_len;
    uint8_t* data = mik__bytes_arg(ctx, argv[0], "data", &data_len);
    if (!data) return JS_EXCEPTION;
    if (mik__spi_ended(s, "transfer()"))
        return mik__result_ok(ctx, JS_NewUint8ArrayCopy(ctx, nullptr, 0));

    /* Allocate receive buffer with js_malloc (MIK_NewUint8Array takes ownership) */
    auto* rx_buf = static_cast<uint8_t*>(js_malloc(ctx, data_len ? data_len : 1));
    if (!rx_buf) return JS_EXCEPTION;

    spi_transaction_t txn = {};
    txn.length = data_len * 8;
    txn.tx_buffer = data;
    txn.rx_buffer = rx_buf;

    esp_err_t err = spi_device_polling_transmit(s->device, &txn);
    if (err != ESP_OK) {
        js_free(ctx, rx_buf);
        return mik__result_err_named(ctx, "TransferFailed",
                                     "SPI transfer failed: %s", esp_err_to_name(err));
    }

    JSValue result = MIK_NewUint8Array(ctx, rx_buf, data_len);
    return mik__result_ok(ctx, result);
}

static JSValue js_spi_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    size_t data_len;
    uint8_t* data = mik__bytes_arg(ctx, argv[0], "data", &data_len);
    if (!data) return JS_EXCEPTION;
    if (mik__spi_ended(s, "write()")) return mik__result_ok_void(ctx);

    spi_transaction_t txn = {};
    txn.length = data_len * 8;
    txn.tx_buffer = data;
    txn.rx_buffer = nullptr;

    esp_err_t err = spi_device_polling_transmit(s->device, &txn);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WriteFailed",
                                     "SPI write failed: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

/* ── Prototype ─────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_spi_proto_funcs[] = {
    MIK_CFUNC_DEF("end", 0, js_spi_end),
    MIK_CFUNC_DEF("transfer", 1, js_spi_transfer),
    MIK_CFUNC_DEF("write", 1, js_spi_write),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__spi_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "Spi", JS_NewCFunction(ctx, js_spi, "Spi", 2));
    return 0;
}

static JSModuleDef* mik__spi_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    MIK_NewClassID(rt, &mik_spi_class_id);
    JS_NewClass(rt, mik_spi_class_id, &mik_spi_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_spi_proto_funcs, countof(mik_spi_proto_funcs));
    JS_SetClassProto(ctx, mik_spi_class_id, proto); /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/spi", mik__spi_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Spi");
    return m;
}

MIK__REGISTER_PUBLIC_MODULE(spi, "mikro/spi", mik__spi_init, nullptr, nullptr)

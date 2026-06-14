#include <cstring>

#include "driver/spi_master.h"
#include "soc/soc_caps.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_SPI_TAG "native:mikro/spi"
#define MIK_SPI_DEFAULT_FREQ 1000000
#define MIK_SPI_DEFAULT_MODE 0

static JSClassID mik_spi_class_id;

typedef struct {
    spi_device_handle_t device;
    spi_host_device_t host;
    int32_t clk;
    int32_t mosi;
    int32_t miso;
    int32_t cs;
    int32_t freq;
    int32_t mode;
    bool begun;
} MIKSPIState;

/* ── Helpers ───────────────────────────────────────────────────────── */

static MIKSPIState* mik__spi_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKSPIState*>(JS_GetOpaque2(ctx, this_val, mik_spi_class_id));
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__spi_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKSPIState*>(JS_GetOpaque(val, mik_spi_class_id));
    if (!s) return;
    if (s->begun) {
        spi_bus_remove_device(s->device);
        spi_bus_free(s->host);
    }
    free(s);
}

static JSClassDef mik_spi_class = {
    .class_name = "Spi",
    .finalizer = mik__spi_finalizer,
};

/* ── Constructor ───────────────────────────────────────────────────── */

static JSValue js_spi_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "Spi requires hostNo and options arguments");

    int32_t host_no;
    if (JS_ToInt32(ctx, &host_no, argv[0])) return JS_EXCEPTION;
    /* SOC_SPI_PERIPH_NUM includes SPI1 (flash), so user-available hosts are 1..N-1 */
    if (host_no < 1 || host_no > SOC_SPI_PERIPH_NUM - 1)
        return JS_ThrowRangeError(ctx, "hostNo must be 1..%d", SOC_SPI_PERIPH_NUM - 1);

    auto* s = static_cast<MIKSPIState*>(calloc(1, sizeof(MIKSPIState)));
    if (!s) return JS_ThrowOutOfMemory(ctx);

    /* SPI2_HOST is 1, SPI3_HOST is 2, etc. — host_no maps directly */
    s->host = static_cast<spi_host_device_t>(host_no);
    s->clk = -1;
    s->mosi = -1;
    s->miso = -1;
    s->cs = -1;
    s->freq = MIK_SPI_DEFAULT_FREQ;
    s->mode = MIK_SPI_DEFAULT_MODE;
    s->begun = false;

    /* Parse options object (required) */
    if (!JS_IsObject(argv[1])) {
        free(s);
        return JS_ThrowTypeError(ctx, "Spi options must be an object");
    }

    JSValue opts = argv[1];
    JSValue v;

    v = JS_GetPropertyStr(ctx, opts, "clk");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->clk, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "mosi");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->mosi, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "miso");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->miso, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "cs");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->cs, v)) {
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
        s->freq = freq;
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "mode");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->mode, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
        if (s->mode < 0 || s->mode > 3) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_ThrowRangeError(ctx, "SPI mode must be 0-3");
        }
    }
    JS_FreeValue(ctx, v);

    JSValue obj = JS_NewObjectClass(ctx, mik_spi_class_id);
    if (JS_IsException(obj)) {
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── Methods ───────────────────────────────────────────────────────── */

static JSValue js_spi_begin(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->begun) return mik__result_ok_void(ctx);  // idempotent

    if (s->clk < 0 || s->mosi < 0)
        return mik__result_err_tag(ctx, "MissingPins");

    /* Initialize the SPI bus */
    spi_bus_config_t bus_cfg = {};
    bus_cfg.mosi_io_num = s->mosi;
    bus_cfg.miso_io_num = s->miso;  // -1 if not set
    bus_cfg.sclk_io_num = s->clk;
    bus_cfg.quadwp_io_num = -1;
    bus_cfg.quadhd_io_num = -1;
    bus_cfg.max_transfer_sz = 32768;

    esp_err_t err = spi_bus_initialize(s->host, &bus_cfg, SPI_DMA_CH_AUTO);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "BusInitFailed",
                                     "SPI bus init failed: %s", esp_err_to_name(err));

    /* Add device to the bus */
    spi_device_interface_config_t dev_cfg = {};
    dev_cfg.clock_speed_hz = s->freq;
    dev_cfg.mode = s->mode;
    dev_cfg.spics_io_num = s->cs;  // -1 if not set (manual CS)
    dev_cfg.queue_size = 1;
    /* Write-only devices (displays) don't need dummy bits for high clock speeds */
    if (s->miso < 0) {
        dev_cfg.flags = SPI_DEVICE_NO_DUMMY;
    }

    err = spi_bus_add_device(s->host, &dev_cfg, &s->device);
    if (err != ESP_OK) {
        spi_bus_free(s->host);
        return mik__result_err_named(ctx, "AddDeviceFailed",
                                     "failed to add SPI device: %s", esp_err_to_name(err));
    }

    s->begun = true;
    return mik__result_ok_void(ctx);
}

static JSValue js_spi_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_ok_void(ctx);  // idempotent

    spi_bus_remove_device(s->device);
    s->device = nullptr;
    spi_bus_free(s->host);
    s->begun = false;
    return mik__result_ok_void(ctx);
}

static JSValue js_spi_transfer(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__spi_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");

    /* Extract data from Uint8Array or ArrayBuffer */
    size_t data_len;
    uint8_t* data;
    size_t offset, elem_size, buf_len;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &data_len, &elem_size);
    if (!JS_IsException(ab)) {
        /* data_len keeps the view length; the full backing buffer goes to a
         * throwaway so a subarray view isn't over-read. */
        data = JS_GetArrayBuffer(ctx, &buf_len, ab);
        JS_FreeValue(ctx, ab);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
        data += offset;
    } else {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        data = JS_GetArrayBuffer(ctx, &data_len, argv[0]);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
    }

    /* Allocate receive buffer with js_malloc (MIK_NewUint8Array takes ownership) */
    auto* rx_buf = static_cast<uint8_t*>(js_malloc(ctx, data_len));
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
    if (!s->begun)
        return mik__result_err_tag(ctx, "NotStarted");

    /* Extract data from Uint8Array or ArrayBuffer */
    size_t data_len;
    uint8_t* data;
    size_t offset, elem_size, buf_len;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &data_len, &elem_size);
    if (!JS_IsException(ab)) {
        /* data_len keeps the view length; the full backing buffer goes to a
         * throwaway so a subarray view isn't over-read. */
        data = JS_GetArrayBuffer(ctx, &buf_len, ab);
        JS_FreeValue(ctx, ab);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
        data += offset;
    } else {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        data = JS_GetArrayBuffer(ctx, &data_len, argv[0]);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
    }

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
    MIK_CFUNC_DEF("begin", 0, js_spi_begin),
    MIK_CFUNC_DEF("end", 0, js_spi_end),
    MIK_CFUNC_DEF("transfer", 1, js_spi_transfer),
    MIK_CFUNC_DEF("write", 1, js_spi_write),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__spi_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor = JS_NewCFunction2(ctx, js_spi_constructor, "Spi", 2, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "Spi", ctor);
    return 0;
}

static JSModuleDef* mik__spi_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    JS_NewClassID(rt, &mik_spi_class_id);
    JS_NewClass(rt, mik_spi_class_id, &mik_spi_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_spi_proto_funcs, countof(mik_spi_proto_funcs));
    JS_SetClassProto(ctx, mik_spi_class_id, proto);  /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/spi", mik__spi_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Spi");
    return m;
}

MIK_REGISTER_MODULE(spi, "native:mikro/spi", mik__spi_init, nullptr, nullptr)

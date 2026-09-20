#include <cmath>
#include <cstring>

#include "driver/uart.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

#define MIK_UART_RX_BUF_SIZE 2048
#define MIK_UART_MAX_INSTANCES 3

static JSClassID mik_uart_class_id;
static int mik__uart_slot = -1;

/* Forward decl: defined alongside the iterator class further down. The Uart
 * state holds a non-owning backpointer so end() can mark the active iterator
 * as exhausted without having to reach through JS. */
struct MIKUartIterState;

/* ── State ────────────────────────────────────────────────────────── */

struct MIKUartState {
    uart_port_t port;
    int tx_pin;  // -1 if RX-only
    int rx_pin;  // -1 if TX-only
    bool active;
    bool warned_after_end;
    bool reading;             // active read() iterator exists
    MIKPromise read_promise;  // pending next() promise (when waiting for data)
    /* Non-owning ref to the active iterator (when reading == true). The iter
     * holds a strong ref to this Uart via uart_jsval, so this back-edge is
     * always cleared (iter_return / finalizer) before the Uart can outlive
     * the iterator. */
    MIKUartIterState* iter;
};

/* Per-runtime tracking of all Uart instances for the loop consumer */
struct MIKUartSlot {
    MIKUartState* instances[MIK_UART_MAX_INSTANCES];
    int count;
};

static inline MIKUartSlot*& mik__uart_slot_data(MIKRuntime* rt) {
    return reinterpret_cast<MIKUartSlot*&>(rt->module_data[mik__uart_slot]);
}

static void mik__uart_track(MIKRuntime* mik_rt, MIKUartState* s) {
    auto* slot = mik__uart_slot_data(mik_rt);
    if (!slot) return;
    if (slot->count >= MIK_UART_MAX_INSTANCES) return;
    slot->instances[slot->count++] = s;
}

static void mik__uart_untrack(MIKRuntime* mik_rt, MIKUartState* s) {
    auto* slot = mik_rt ? mik__uart_slot_data(mik_rt) : nullptr;
    if (!slot) return;
    for (int i = 0; i < slot->count; i++) {
        if (slot->instances[i] == s) {
            slot->instances[i] = slot->instances[--slot->count];
            return;
        }
    }
}

/* ── Helpers ──────────────────────────────────────────────────────── */

static MIKUartState* mik__uart_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKUartState*>(JS_GetOpaque2(ctx, this_val, mik_uart_class_id));
}

/* Stops tracking, deletes the driver and releases the GPIO pins. */
static void mik__uart_release(MIKRuntime* mik_rt, MIKUartState* s) {
    mik__uart_untrack(mik_rt, s);
    uart_driver_delete(s->port);
    const int gpios[] = {s->tx_pin, s->rx_pin};
    mik__release_gpios(gpios, countof(gpios), "Uart");
    s->active = false;
}

/* True when the handle was ended; the first such call prints a warning. */
static bool mik__uart_ended(MIKUartState* s, const char* call) {
    if (s->active) return false;
    mik__warn_after_end(&s->warned_after_end, "Uart", s->port, call, "port");
    return true;
}

/* ── Finalizer ────────────────────────────────────────────────────── */

static void mik__uart_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKUartState*>(JS_GetOpaque(val, mik_uart_class_id));
    if (!s) return;
    /* Untracks too, so the loop consumer never reads a freed handle. */
    if (s->active) mik__uart_release(static_cast<MIKRuntime*>(JS_GetRuntimeOpaque(rt)), s);
    /* Only at runtime teardown can a handle with a pending read be collected. */
    if (!JS_IsUndefined(s->read_promise.p)) MIK_FreePromiseRT(rt, &s->read_promise);
    free(s);
}

static JSClassDef mik_uart_class = {
    .class_name = "Uart",
    .finalizer = mik__uart_finalizer,
};

/* ── Factory ──────────────────────────────────────────────────────── */

/* Uart(port, {tx?, rx?, baudRate}) → Result<Uart, UartError> */
static JSValue js_uart(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t port;
    JSValueConst options;
    int32_t tx32 = -1, rx32 = -1;
    double baud_rate;
    if (mik__to_int_arg(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED, "port", &port) ||
        mik__options_arg(ctx, argc, argv, 1, true, &options) ||
        mik__int_option(ctx, options, "tx", false, &tx32) ||
        mik__int_option(ctx, options, "rx", false, &rx32) ||
        mik__number_option(ctx, options, "baudRate", true, &baud_rate))
        return JS_EXCEPTION;
    int tx = tx32, rx = rx32;
    if (tx < 0 && rx < 0) return JS_ThrowTypeError(ctx, "Uart requires at least one of tx or rx");

    if (port < 0 || port >= UART_NUM_MAX)
        return mik__result_err_named(ctx, "InvalidParam", "port must be 0 to %d on %s, got %d",
                                     UART_NUM_MAX - 1, CONFIG_IDF_TARGET, (int)port);
    if (!(baud_rate >= 1 && baud_rate <= INT32_MAX && std::trunc(baud_rate) == baud_rate))
        return mik__result_err_named(ctx, "InvalidParam",
                                     "baudRate must be a whole number of at least 1, got %g",
                                     baud_rate);
    const MIKGpioCheck checks[] = {{tx, true}, {rx, false}};
    JSValue invalid = mik__gpio_check(ctx, checks, countof(checks));
    if (!JS_IsUndefined(invalid)) return invalid;
    const int gpios[] = {tx, rx};
    JSValue claim_failed = mik__claim_gpios(ctx, gpios, countof(gpios), "Uart");
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    auto uart_port = static_cast<uart_port_t>(port);
    /* A port that is in use (the console on UART0, or another Uart handle) is
     * refused before uart_param_config and uart_set_pin can change its baud
     * rate and pins. */
    if (uart_is_driver_installed(uart_port)) {
        mik__release_gpios(gpios, countof(gpios), "Uart");
        return mik__result_err_named(ctx, "DriverInstallFailed", "port %d is already in use",
                                     (int)port);
    }

    uart_config_t uart_config = {};
    uart_config.baud_rate = static_cast<int>(baud_rate);
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.source_clk = UART_SCLK_DEFAULT;

    esp_err_t err = uart_param_config(uart_port, &uart_config);
    if (err != ESP_OK) {
        mik__release_gpios(gpios, countof(gpios), "Uart");
        return mik__result_err_named(ctx, "InvalidParam",
                                     "uart_param_config failed on port %d: %s", (int)port,
                                     esp_err_to_name(err));
    }

    err = uart_set_pin(uart_port, tx >= 0 ? tx : UART_PIN_NO_CHANGE,
                       rx >= 0 ? rx : UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err != ESP_OK) {
        mik__release_gpios(gpios, countof(gpios), "Uart");
        return mik__result_err_named(ctx, "SetPinFailed",
                                     "uart_set_pin failed on port %d (tx=%d, rx=%d): %s", (int)port,
                                     tx, rx, esp_err_to_name(err));
    }

    /* RX buffer only if we have an RX pin; no TX buffer (writes block until done) */
    int rx_buf = rx >= 0 ? MIK_UART_RX_BUF_SIZE : 0;
    err = uart_driver_install(uart_port, rx_buf, 0, 0, nullptr, ESP_INTR_FLAG_IRAM);
    if (err != ESP_OK) {
        mik__release_gpios(gpios, countof(gpios), "Uart");
        return mik__result_err_named(ctx, "DriverInstallFailed",
                                     "uart_driver_install failed on port %d: %s", (int)port,
                                     esp_err_to_name(err));
    }

    auto* s = static_cast<MIKUartState*>(calloc(1, sizeof(MIKUartState)));
    if (!s) {
        uart_driver_delete(uart_port);
        mik__release_gpios(gpios, countof(gpios), "Uart");
        return JS_ThrowOutOfMemory(ctx);
    }
    s->port = uart_port;
    s->tx_pin = tx;
    s->rx_pin = rx;
    s->active = true;
    MIK_ClearPromise(ctx, &s->read_promise);

    JSValue obj = JS_NewObjectClass(ctx, mik_uart_class_id);
    if (JS_IsException(obj)) {
        uart_driver_delete(uart_port);
        mik__release_gpios(gpios, countof(gpios), "Uart");
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    mik__uart_track(MIK_GetRuntime(ctx), s);
    MIK_KeepHandle(ctx, obj);
    return mik__result_ok(ctx, obj);
}

/* ── Methods ──────────────────────────────────────────────────────── */

/* Forward decls — bodies live with the iterator class. */
static JSValue mik__uart_iter_done(JSContext* ctx);
static void mik__uart_iter_mark_ended(MIKUartIterState* it);

/* end() — deletes the driver; a pending read completes. Calling it again does nothing. */
static JSValue js_uart_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return JS_UNDEFINED;

    /* An active read() iterator completes: an awaiting next() resolves with
     * {done:true}, and later next() calls see the sticky `ended` flag. */
    if (s->reading) {
        if (MIK_IsPromisePending(ctx, &s->read_promise)) {
            JSValue done = mik__uart_iter_done(ctx);
            MIK_ResolvePromise(ctx, &s->read_promise, 1, &done);
            MIK_ClearPromise(ctx, &s->read_promise);
        }
        if (s->iter) mik__uart_iter_mark_ended(s->iter);
        s->reading = false;
    }

    mik__uart_release(MIK_GetRuntime(ctx), s);
    MIK_DropHandle(ctx, this_val);
    return JS_UNDEFINED;
}

static JSValue js_uart_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    size_t data_len;
    uint8_t* data = mik__bytes_arg(ctx, argv[0], "data", &data_len);
    if (!data) return JS_EXCEPTION;
    if (mik__uart_ended(s, "write()")) return mik__result_ok_void(ctx);
    if (s->tx_pin < 0) return mik__result_err_tag(ctx, "NoTxPin");

    int written = uart_write_bytes(s->port, data, data_len);
    if (written < 0)
        return mik__result_err_named(ctx, "WriteFailed", "uart_write_bytes failed on port %d",
                                     s->port);

    return mik__result_ok_void(ctx);
}

/* ── Async iterator for read() ────────────────────────────────────── */

/* The iterator object holds a reference back to the Uart state.
 * next() either returns buffered data synchronously or creates a promise.
 * return() cancels the pending read. */

static JSClassID mik_uart_iter_class_id;

struct MIKUartIterState {
    /* Borrowed pointer into the Uart instance's opaque state. Kept alive
     * for the iterator's lifetime by `uart_jsval` below — without that
     * strong ref, QuickJS finalization order isn't guaranteed and the
     * iterator could outlive its parent Uart, leading to a UAF here. */
    MIKUartState* uart;
    JSValue uart_jsval;
    bool ended;  // sticky: once true, next() returns {done:true} immediately
};

static void mik__uart_iter_finalizer(JSRuntime* rt, JSValue val) {
    auto* it = static_cast<MIKUartIterState*>(JS_GetOpaque(val, mik_uart_iter_class_id));
    if (!it) return;
    /* uart_jsval keeps the Uart alive, so accessing it->uart->reading is
     * safe here — except after iterator.return() nulled it out. */
    if (it->uart && it->uart->iter == it) {
        it->uart->reading = false;
        it->uart->iter = nullptr;
    }
    JS_FreeValueRT(rt, it->uart_jsval);
    free(it);
}

static void mik__uart_iter_mark_ended(MIKUartIterState* it) {
    if (it) it->ended = true;
}

static void mik__uart_iter_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    auto* it = static_cast<MIKUartIterState*>(JS_GetOpaque(val, mik_uart_iter_class_id));
    if (!it) return;
    JS_MarkValue(rt, it->uart_jsval, mark_func);
}

static JSClassDef mik_uart_iter_class = {
    .class_name = "UartIterator",
    .finalizer = mik__uart_iter_finalizer,
    .gc_mark = mik__uart_iter_gc_mark,
};

/* Build {done:false, value: Result<Uint8Array, UartError>} wrapper. Takes
 * ownership of the inner Result value. */
static JSValue mik__uart_iter_yield(JSContext* ctx, JSValue inner_result) {
    JSValue out = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, out, "done", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, out, "value", inner_result, JS_PROP_C_W_E);
    return out;
}

static JSValue mik__uart_iter_done(JSContext* ctx) {
    JSValue out = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, out, "done", JS_TRUE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, out, "value", JS_UNDEFINED, JS_PROP_C_W_E);
    return out;
}

/* Try to read available data and return {done:false, value: ok(Uint8Array)}
 * synchronously, or JS_UNDEFINED if no data is buffered yet. */
static JSValue mik__uart_try_read(JSContext* ctx, MIKUartState* s) {
    size_t buffered = 0;
    uart_get_buffered_data_len(s->port, &buffered);
    if (buffered == 0) return JS_UNDEFINED;  // sentinel: no data

    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, buffered));
    if (!buf) return JS_EXCEPTION;

    int read = uart_read_bytes(s->port, buf, buffered, 0);
    if (read <= 0) {
        js_free(ctx, buf);
        return JS_UNDEFINED;
    }

    JSValue arr = MIK_NewUint8Array(ctx, buf, read);
    return mik__uart_iter_yield(ctx, mik__result_ok(ctx, arr));
}

static JSValue js_uart_iter_next(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* it = static_cast<MIKUartIterState*>(JS_GetOpaque2(ctx, this_val, mik_uart_iter_class_id));
    if (!it) return JS_EXCEPTION;

    if (it->ended || !it->uart || !it->uart->active) {
        it->ended = true;
        JSValue done_result = mik__uart_iter_done(ctx);
        return MIK_NewResolvedPromise(ctx, 1, &done_result);
    }

    MIKUartState* s = it->uart;

    /* Try synchronous read first */
    JSValue sync_result = mik__uart_try_read(ctx, s);
    if (JS_IsException(sync_result)) return sync_result;
    if (!JS_IsUndefined(sync_result)) {
        /* Async iterator protocol requires next() to return a Promise */
        return MIK_NewResolvedPromise(ctx, 1, &sync_result);
    }

    /* No data available: create a promise, resolved by loop consumer */
    JSValue promise = MIK_InitPromise(ctx, &s->read_promise);
    return promise;
}

static JSValue js_uart_iter_return(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* it = static_cast<MIKUartIterState*>(JS_GetOpaque2(ctx, this_val, mik_uart_iter_class_id));
    if (!it) return JS_EXCEPTION;
    it->ended = true;

    if (it->uart && it->uart->iter == it) {
        /* Cancel pending read promise: resolve with {done: true} to cleanly end the iteration */
        if (MIK_IsPromisePending(ctx, &it->uart->read_promise)) {
            JSValue done_result = mik__uart_iter_done(ctx);
            MIK_ResolvePromise(ctx, &it->uart->read_promise, 1, &done_result);
            MIK_ClearPromise(ctx, &it->uart->read_promise);
        }
        it->uart->reading = false;
        it->uart->iter = nullptr;
    }
    it->uart = nullptr;

    JSValue result = mik__uart_iter_done(ctx);
    return MIK_NewResolvedPromise(ctx, 1, &result);
}

/* [Symbol.asyncIterator]() on the iterator prototype: the iterator is its own iterable. */
static JSValue js_uart_iter_self(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    return JS_DupValue(ctx, this_val);
}

static const JSCFunctionListEntry mik_uart_iter_proto_funcs[] = {
    MIK_CFUNC_DEF("next", 0, js_uart_iter_next),
    MIK_CFUNC_DEF("return", 0, js_uart_iter_return),
};

/* read() method on the Uart class — returns Result<AsyncIterable, UartError> */
static JSValue js_uart_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    bool ended = mik__uart_ended(s, "read()");
    if (!ended) {
        if (s->rx_pin < 0) return mik__result_err_tag(ctx, "NoRxPin");
        if (s->reading) return mik__result_err_tag(ctx, "AlreadyReading");
    }

    auto* it = static_cast<MIKUartIterState*>(calloc(1, sizeof(MIKUartIterState)));
    if (!it) return JS_ThrowOutOfMemory(ctx);
    /* After end() the iterable completes on its first next(). */
    it->ended = ended;
    it->uart = ended ? nullptr : s;
    it->uart_jsval = ended ? JS_UNDEFINED : JS_DupValue(ctx, this_val);

    JSValue iter_obj = JS_NewObjectClass(ctx, mik_uart_iter_class_id);
    if (JS_IsException(iter_obj)) {
        JS_FreeValue(ctx, it->uart_jsval);
        free(it);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(iter_obj, it);
    if (!ended) {
        s->reading = true;
        s->iter = it;
    }

    return mik__result_ok(ctx, iter_obj);
}

/* ── Prototype ────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_uart_proto_funcs[] = {
    MIK_CFUNC_DEF("end", 0, js_uart_end),
    MIK_CFUNC_DEF("write", 1, js_uart_write),
    MIK_CFUNC_DEF("read", 0, js_uart_read),
};

/* ── Module init ──────────────────────────────────────────────────── */

static int mik__uart_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "Uart", JS_NewCFunction(ctx, js_uart, "Uart", 2));
    return 0;
}

static JSModuleDef* mik__uart_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik__uart_slot < 0) mik__uart_slot = MIK_ReserveModuleSlot();

    /* Allocate per-runtime slot data */
    auto* slot_data = static_cast<MIKUartSlot*>(calloc(1, sizeof(MIKUartSlot)));
    if (!slot_data) return nullptr;
    mik__uart_slot_data(mik_rt) = slot_data;

    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register Uart class */
    MIK_NewClassID(rt, &mik_uart_class_id);
    JS_NewClass(rt, mik_uart_class_id, &mik_uart_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_uart_proto_funcs, countof(mik_uart_proto_funcs));
    JS_SetClassProto(ctx, mik_uart_class_id, proto);

    /* Register iterator class */
    MIK_NewClassID(rt, &mik_uart_iter_class_id);
    JS_NewClass(rt, mik_uart_iter_class_id, &mik_uart_iter_class);

    JSValue iter_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, iter_proto, mik_uart_iter_proto_funcs,
                               countof(mik_uart_iter_proto_funcs));
    /* Once on the prototype, so for await works on the iterator itself. */
    JSAtom iter_atom = mik__async_iterator_atom(ctx);
    JS_DefinePropertyValue(ctx, iter_proto, iter_atom,
                           JS_NewCFunction(ctx, js_uart_iter_self, "[Symbol.asyncIterator]", 0),
                           JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
    JS_FreeAtom(ctx, iter_atom);
    JS_SetClassProto(ctx, mik_uart_iter_class_id, iter_proto);

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/uart", mik__uart_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Uart");
    return m;
}

/* ── Event loop: check for incoming UART data ─────────────────────── */

void mik__uart_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* slot = mik__uart_slot_data(mik_rt);
    if (!slot) return;

    for (int i = 0; i < slot->count; i++) {
        MIKUartState* s = slot->instances[i];
        if (!s || !s->reading || !s->active) continue;
        if (!MIK_IsPromisePending(ctx, &s->read_promise)) continue;

        size_t buffered = 0;
        uart_get_buffered_data_len(s->port, &buffered);
        if (buffered == 0) continue;

        auto* buf = static_cast<uint8_t*>(js_malloc(ctx, buffered));
        if (!buf) continue;

        int read_bytes = uart_read_bytes(s->port, buf, buffered, 0);
        if (read_bytes <= 0) {
            js_free(ctx, buf);
            continue;
        }

        JSValue arr = MIK_NewUint8Array(ctx, buf, read_bytes);
        JSValue result = mik__uart_iter_yield(ctx, mik__result_ok(ctx, arr));
        MIK_ResolvePromise(ctx, &s->read_promise, 1, &result);
        MIK_ClearPromise(ctx, &s->read_promise);
    }
}

void mik__uart_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* slot = mik__uart_slot_data(mik_rt);
    if (!slot) return;

    for (int i = 0; i < slot->count; i++) {
        MIKUartState* s = slot->instances[i];
        if (!s) continue;
        if (s->reading && MIK_IsPromisePending(ctx, &s->read_promise)) {
            MIK_FreePromise(ctx, &s->read_promise);
            MIK_ClearPromise(ctx, &s->read_promise);
        }
    }

    free(slot);
    mik__uart_slot_data(mik_rt) = nullptr;
}

MIK__REGISTER_PUBLIC_MODULE(uart, "mikro/uart", mik__uart_init, mik__uart_consume,
                            mik__uart_destroy)

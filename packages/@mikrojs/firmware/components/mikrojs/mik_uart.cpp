#include <cstring>

#include "driver/uart.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_UART_TAG "native:uart"
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
    int32_t tx_pin;   // -1 if RX-only
    int32_t rx_pin;   // -1 if TX-only
    int32_t baud_rate;
    bool begun;
    bool reading;     // active read() iterator exists
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

static void mik__uart_track(JSContext* ctx, MIKUartState* s) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* slot = mik__uart_slot_data(mik_rt);
    if (!slot) return;
    if (slot->count >= MIK_UART_MAX_INSTANCES) return;
    slot->instances[slot->count++] = s;
}

static void mik__uart_untrack(JSContext* ctx, MIKUartState* s) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* slot = mik__uart_slot_data(mik_rt);
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

/* ── Finalizer ────────────────────────────────────────────────────── */

static void mik__uart_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKUartState*>(JS_GetOpaque(val, mik_uart_class_id));
    if (!s) return;
    if (s->begun) {
        uart_driver_delete(s->port);
    }
    /* Note: can't untrack here (no JSContext), but destroy handles cleanup */
    free(s);
}

static JSClassDef mik_uart_class = {
    .class_name = "Uart",
    .finalizer = mik__uart_finalizer,
};

/* ── Constructor ──────────────────────────────────────────────────── */

static JSValue js_uart_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "Uart requires port and options arguments");

    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[0])) return JS_EXCEPTION;
    if (port < 0 || port >= UART_NUM_MAX)
        return JS_ThrowRangeError(ctx, "port must be 0..%d", UART_NUM_MAX - 1);

    if (!JS_IsObject(argv[1])) return JS_ThrowTypeError(ctx, "Uart options must be an object");

    auto* s = static_cast<MIKUartState*>(calloc(1, sizeof(MIKUartState)));
    if (!s) return JS_ThrowOutOfMemory(ctx);

    s->port = static_cast<uart_port_t>(port);
    s->tx_pin = -1;
    s->rx_pin = -1;
    s->baud_rate = 115200;
    s->begun = false;
    s->reading = false;
    s->iter = nullptr;
    s->read_promise.p = JS_UNDEFINED;
    s->read_promise.rfuncs[0] = JS_UNDEFINED;
    s->read_promise.rfuncs[1] = JS_UNDEFINED;

    JSValue opts = argv[1];
    JSValue v;

    v = JS_GetPropertyStr(ctx, opts, "tx");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->tx_pin, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "rx");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->rx_pin, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    /* At least one pin must be provided */
    if (s->tx_pin < 0 && s->rx_pin < 0) {
        free(s);
        return JS_ThrowTypeError(ctx, "Uart requires at least one of tx or rx pins");
    }

    v = JS_GetPropertyStr(ctx, opts, "baudRate");
    if (!JS_IsUndefined(v)) {
        if (JS_ToInt32(ctx, &s->baud_rate, v)) {
            JS_FreeValue(ctx, v);
            free(s);
            return JS_EXCEPTION;
        }
    }
    JS_FreeValue(ctx, v);

    JSValue obj = JS_NewObjectClass(ctx, mik_uart_class_id);
    if (JS_IsException(obj)) {
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── Methods ──────────────────────────────────────────────────────── */

static JSValue js_uart_begin(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->begun) return mik__result_ok_void(ctx);  // idempotent

    uart_config_t uart_config = {};
    uart_config.baud_rate = s->baud_rate;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.source_clk = UART_SCLK_DEFAULT;

    esp_err_t err = uart_param_config(s->port, &uart_config);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "InvalidParam",
                                     "uart_param_config failed on port %d: %s", s->port,
                                     esp_err_to_name(err));

    err = uart_set_pin(s->port,
                       s->tx_pin >= 0 ? s->tx_pin : UART_PIN_NO_CHANGE,
                       s->rx_pin >= 0 ? s->rx_pin : UART_PIN_NO_CHANGE,
                       UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "SetPinFailed",
                                     "uart_set_pin failed on port %d (tx=%d, rx=%d): %s", s->port,
                                     s->tx_pin, s->rx_pin, esp_err_to_name(err));

    /* RX buffer only if we have an RX pin; no TX buffer (writes block until done) */
    int rx_buf = s->rx_pin >= 0 ? MIK_UART_RX_BUF_SIZE : 0;
    err = uart_driver_install(s->port, rx_buf, 0, 0, nullptr, ESP_INTR_FLAG_IRAM);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "DriverInstallFailed",
                                     "uart_driver_install failed on port %d: %s", s->port,
                                     esp_err_to_name(err));

    s->begun = true;
    mik__uart_track(ctx, s);
    return mik__result_ok_void(ctx);
}

/* Forward decls — bodies live with the iterator class. */
static JSValue mik__uart_iter_yield(JSContext* ctx, JSValue inner_result);
static void mik__uart_iter_mark_ended(MIKUartIterState* it);

static JSValue js_uart_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_ok_void(ctx);  // idempotent

    /* If a read() iterator is active, deliver a terminal err item so any
     * awaiting next() unblocks with err(NotStarted) rather than hanging.
     * Also flip the iterator's `ended` flag so its next call resolves with
     * {done:true} — without this, the awaiter consumes the err yield, then
     * the next call hits the `!s->begun` branch in iter_next and emits a
     * second err yield. The active iterator backpointer makes that flip
     * possible without reaching through JS. */
    if (s->reading) {
        if (MIK_IsPromisePending(ctx, &s->read_promise)) {
            JSValue err_yield = mik__uart_iter_yield(ctx, mik__result_err_tag(ctx, "NotStarted"));
            MIK_ResolvePromise(ctx, &s->read_promise, 1, &err_yield);
            MIK_ClearPromise(ctx, &s->read_promise);
        }
        if (s->iter) mik__uart_iter_mark_ended(s->iter);
        s->reading = false;
    }

    mik__uart_untrack(ctx, s);
    uart_driver_delete(s->port);
    s->begun = false;
    return mik__result_ok_void(ctx);
}

static JSValue js_uart_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");
    if (s->tx_pin < 0) return mik__result_err_tag(ctx, "NoTxPin");

    size_t data_len;
    uint8_t* data;
    size_t offset, elem_size;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &data_len, &elem_size);
    if (!JS_IsException(ab)) {
        data = JS_GetArrayBuffer(ctx, &data_len, ab);
        JS_FreeValue(ctx, ab);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
        data += offset;
    } else {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        data = JS_GetArrayBuffer(ctx, &data_len, argv[0]);
        if (!data) return JS_ThrowTypeError(ctx, "expected Uint8Array as argument 1");
    }

    int written = uart_write_bytes(s->port, data, data_len);
    if (written < 0)
        return mik__result_err_named(ctx, "WriteFailed",
                                     "uart_write_bytes failed on port %d", s->port);

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
    if (it->uart) {
        it->uart->reading = false;
        if (it->uart->iter == it) it->uart->iter = nullptr;
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
    if (!it || !it->uart) return JS_ThrowInternalError(ctx, "invalid uart iterator");

    if (it->ended) {
        JSValue done_result = mik__uart_iter_done(ctx);
        return MIK_NewResolvedPromise(ctx, 1, &done_result);
    }

    MIKUartState* s = it->uart;

    /* If end() has invalidated the underlying port, surface NotStarted as
     * a single err item and mark the iterator done. */
    if (!s->begun) {
        it->ended = true;
        JSValue err_yield = mik__uart_iter_yield(ctx, mik__result_err_tag(ctx, "NotStarted"));
        return MIK_NewResolvedPromise(ctx, 1, &err_yield);
    }

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
    if (!it || !it->uart) goto done;

    /* Cancel pending read promise */
    if (MIK_IsPromisePending(ctx, &it->uart->read_promise)) {
        /* Resolve with {done: true} to cleanly end the iteration */
        JSValue done_result = JS_NewObject(ctx);
        JS_DefinePropertyValueStr(ctx, done_result, "done", JS_TRUE, JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, done_result, "value", JS_UNDEFINED, JS_PROP_C_W_E);
        MIK_ResolvePromise(ctx, &it->uart->read_promise, 1, &done_result);
        MIK_ClearPromise(ctx, &it->uart->read_promise);
    }

    it->uart->reading = false;
    if (it->uart->iter == it) it->uart->iter = nullptr;
    it->uart = nullptr;

done:
    JSValue result = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, result, "done", JS_TRUE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, result, "value", JS_UNDEFINED, JS_PROP_C_W_E);
    return MIK_NewResolvedPromise(ctx, 1, &result);
}

static const JSCFunctionListEntry mik_uart_iter_proto_funcs[] = {
    MIK_CFUNC_DEF("next", 0, js_uart_iter_next),
    MIK_CFUNC_DEF("return", 0, js_uart_iter_return),
};

/* read() method on the Uart class — returns Result<AsyncIterable, UartError> */
static JSValue js_uart_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__uart_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");
    if (s->rx_pin < 0) return mik__result_err_tag(ctx, "NoRxPin");
    if (s->reading) return mik__result_err_tag(ctx, "AlreadyReading");

    s->reading = true;

    /* Create iterator object */
    auto* it = static_cast<MIKUartIterState*>(calloc(1, sizeof(MIKUartIterState)));
    if (!it) {
        s->reading = false;
        return JS_ThrowOutOfMemory(ctx);
    }
    it->uart = s;
    it->uart_jsval = JS_DupValue(ctx, this_val);

    JSValue iter_obj = JS_NewObjectClass(ctx, mik_uart_iter_class_id);
    if (JS_IsException(iter_obj)) {
        s->reading = false;
        JS_FreeValue(ctx, it->uart_jsval);
        free(it);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(iter_obj, it);
    s->iter = it;

    return mik__result_ok(ctx, iter_obj);
}

/* ── Prototype ────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_uart_proto_funcs[] = {
    MIK_CFUNC_DEF("begin", 0, js_uart_begin),
    MIK_CFUNC_DEF("end", 0, js_uart_end),
    MIK_CFUNC_DEF("write", 1, js_uart_write),
    MIK_CFUNC_DEF("read", 0, js_uart_read),
};

/* ── Module init ──────────────────────────────────────────────────── */

static int mik__uart_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor =
        JS_NewCFunction2(ctx, js_uart_constructor, "Uart", 2, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "Uart", ctor);
    return 0;
}

static JSModuleDef* mik__uart_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    mik__uart_slot = MIK_AllocModuleSlot(mik_rt);

    /* Allocate per-runtime slot data */
    auto* slot_data = static_cast<MIKUartSlot*>(calloc(1, sizeof(MIKUartSlot)));
    if (!slot_data) return nullptr;
    mik__uart_slot_data(mik_rt) = slot_data;

    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register Uart class */
    JS_NewClassID(rt, &mik_uart_class_id);
    JS_NewClass(rt, mik_uart_class_id, &mik_uart_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_uart_proto_funcs, countof(mik_uart_proto_funcs));
    JS_SetClassProto(ctx, mik_uart_class_id, proto);

    /* Register iterator class */
    JS_NewClassID(rt, &mik_uart_iter_class_id);
    JS_NewClass(rt, mik_uart_iter_class_id, &mik_uart_iter_class);

    JSValue iter_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, iter_proto, mik_uart_iter_proto_funcs,
                               countof(mik_uart_iter_proto_funcs));
    JS_SetClassProto(ctx, mik_uart_iter_class_id, iter_proto);

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "native:uart", mik__uart_module_init);
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
        if (!s || !s->reading || !s->begun) continue;
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
        }
    }

    free(slot);
    mik__uart_slot_data(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(uart, "native:uart", mik__uart_init, mik__uart_consume, mik__uart_destroy)

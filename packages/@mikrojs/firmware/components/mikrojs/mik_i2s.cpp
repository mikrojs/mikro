#include <cstring>

#include "driver/i2s_std.h"
#include "soc/soc_caps.h"
#if SOC_I2S_SUPPORTS_PDM_RX
#include "driver/i2s_pdm.h"
#endif
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_I2S_TAG "native:mikro/i2s"
#define MIK_I2S_MAX_INSTANCES 2
#define MIK_I2S_TX_QUEUE_DEPTH 4
#define MIK_I2S_DEFAULT_DMA_FRAMES 240  /* ~5 ms @ 48 kHz; audio-tuned, not the UART default */
#define MIK_I2S_DEFAULT_DMA_BUFFERS 4

static JSClassID mik_i2s_class_id;
static int mik__i2s_slot = -1;

/* ── State ────────────────────────────────────────────────────────── */

/* One pending TX write: a copy of the not-yet-drained tail of a write() call,
 * plus the promise that resolves once the whole chunk reaches DMA. Owned copy
 * because the JS source array may be GC'd or mutated before we finish draining. */
struct MIKI2sTxChunk {
    uint8_t* data;       // js_malloc'd copy of the remaining bytes
    size_t len;          // total bytes in `data`
    size_t off;          // bytes already handed to DMA
    MIKPromise promise;  // resolved ok(void) when off == len
};

struct MIKI2sState {
    MIKRuntime* rt;  // owning runtime, so the finalizer can untrack without a JSContext
    int port;  // i2s_chan_config_t.id is a plain int in the new driver
    i2s_chan_handle_t tx_chan;  // null if RX-only
    i2s_chan_handle_t rx_chan;  // null if TX-only
    bool pdm;                   // PDM (RX-only) vs standard mode
    uint32_t sample_rate;
    int bits;       // 16 or 32
    bool stereo;    // stereo vs mono slot mode
    int32_t bclk;   // std only
    int32_t ws;     // std only
    int32_t clk;    // pdm only
    int32_t dout;   // -1 if no TX
    int32_t din;    // -1 if no RX
    int dma_frames;
    int dma_buffers;
    bool begun;

    /* TX bounded queue (ring buffer) */
    MIKI2sTxChunk tx_queue[MIK_I2S_TX_QUEUE_DEPTH];
    int tx_head;
    int tx_count;
};

struct MIKI2sSlot {
    MIKI2sState* instances[MIK_I2S_MAX_INSTANCES];
    int count;
};

static inline MIKI2sSlot*& mik__i2s_slot_data(MIKRuntime* rt) {
    return reinterpret_cast<MIKI2sSlot*&>(rt->module_data[mik__i2s_slot]);
}

/* Returns false if the loop consumer can't take another instance; begin() turns
 * that into an error so a tracked-but-undriven instance can't exist. */
static bool mik__i2s_track(JSContext* ctx, MIKI2sState* s) {
    auto* slot = mik__i2s_slot_data(MIK_GetRuntime(ctx));
    if (!slot) return false;
    if (slot->count >= MIK_I2S_MAX_INSTANCES) return false;
    slot->instances[slot->count++] = s;
    return true;
}

static void mik__i2s_untrack_slot(MIKI2sSlot* slot, MIKI2sState* s) {
    if (!slot) return;
    for (int i = 0; i < slot->count; i++) {
        if (slot->instances[i] == s) {
            slot->instances[i] = slot->instances[--slot->count];
            return;
        }
    }
}

static void mik__i2s_untrack(JSContext* ctx, MIKI2sState* s) {
    mik__i2s_untrack_slot(mik__i2s_slot_data(MIK_GetRuntime(ctx)), s);
}

/* ── Helpers ──────────────────────────────────────────────────────── */

static MIKI2sState* mik__i2s_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKI2sState*>(JS_GetOpaque2(ctx, this_val, mik_i2s_class_id));
}

static void mik__i2s_buf_free(JSRuntime* rt, void* opaque, void* ptr) { js_free_rt(rt, ptr); }

/* write() returns Promise<Result>; settle synchronously for the immediate cases
 * (errors, fully-drained writes). Consumes `value`. */
static JSValue mik__i2s_resolved(JSContext* ctx, JSValue value) {
    return MIK_NewResolvedPromise(ctx, 1, &value);
}

/* Build an Int16Array that OWNS `data` (`bytes` must be a whole number of int16
 * samples). The typed array never shares its buffer with another chunk, so it is
 * safe to retain. */
static JSValue mik__i2s_new_samples(JSContext* ctx, uint8_t* data, size_t bytes) {
    JSValue ab = JS_NewArrayBuffer(ctx, data, bytes, mik__i2s_buf_free, nullptr, false);
    if (JS_IsException(ab)) {
        js_free(ctx, data);
        return ab;
    }
    /* `new Int16Array(ab)`. The constructor reads argv[1] (offset) and argv[2]
     * (length) unconditionally; it does NOT honor argc, so all three must be
     * passed. A 1-element argv left it reading out-of-bounds stack as
     * offset/length and crashing. Undefined offset/length means "whole buffer". */
    JSValueConst args[3] = {ab, JS_UNDEFINED, JS_UNDEFINED};
    JSValue ta = JS_NewTypedArray(ctx, 3, args, JS_TYPED_ARRAY_INT16);
    JS_FreeValue(ctx, ab);  // the typed array holds its own ref to the buffer
    return ta;
}

static inline i2s_data_bit_width_t mik__i2s_bit_width(int bits) {
    return bits == 32 ? I2S_DATA_BIT_WIDTH_32BIT : I2S_DATA_BIT_WIDTH_16BIT;
}

static inline i2s_slot_mode_t mik__i2s_slot_mode(bool stereo) {
    return stereo ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO;
}

/* ── Finalizer ────────────────────────────────────────────────────── */

static void mik__i2s_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKI2sState*>(JS_GetOpaque(val, mik_i2s_class_id));
    if (!s) return;
    if (s->begun) {
        if (s->tx_chan) {
            i2s_channel_disable(s->tx_chan);
            i2s_del_channel(s->tx_chan);
        }
        if (s->rx_chan) {
            i2s_channel_disable(s->rx_chan);
            i2s_del_channel(s->rx_chan);
        }
    }
    for (int i = 0; i < s->tx_count; i++) {
        MIKI2sTxChunk* c = &s->tx_queue[(s->tx_head + i) % MIK_I2S_TX_QUEUE_DEPTH];
        js_free_rt(rt, c->data);
    }
    /* Untrack so the loop consumer never dereferences this freed state if the
     * instance is GC'd mid-run. At runtime teardown destroy() already cleared the
     * slot (it runs before finalizers), so the slot lookup returns null and this
     * is a no-op. */
    if (s->rt) mik__i2s_untrack_slot(mik__i2s_slot_data(s->rt), s);
    free(s);
}

static JSClassDef mik_i2s_class = {
    .class_name = "I2s",
    .finalizer = mik__i2s_finalizer,
};

/* ── Constructor ──────────────────────────────────────────────────── */

static JSValue js_i2s_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    if (argc < 2) return JS_ThrowTypeError(ctx, "I2s requires port and options arguments");

    int32_t port;
    if (JS_ToInt32(ctx, &port, argv[0])) return JS_EXCEPTION;
    /* No SOC port-count macro in the new driver; reject negatives here and let
     * i2s_new_channel() reject an out-of-range port at begin() time. */
    if (port < 0) return JS_ThrowRangeError(ctx, "port must be >= 0");

    if (!JS_IsObject(argv[1])) return JS_ThrowTypeError(ctx, "I2s options must be an object");

    auto* s = static_cast<MIKI2sState*>(calloc(1, sizeof(MIKI2sState)));
    if (!s) return JS_ThrowOutOfMemory(ctx);

    s->rt = MIK_GetRuntime(ctx);
    s->bits = 16;
    s->dout = -1;
    s->din = -1;
    s->bclk = -1;
    s->ws = -1;
    s->clk = -1;
    s->dma_frames = MIK_I2S_DEFAULT_DMA_FRAMES;
    s->dma_buffers = MIK_I2S_DEFAULT_DMA_BUFFERS;
    s->port = port;
    s->tx_chan = nullptr;
    s->rx_chan = nullptr;

    JSValue opts = argv[1];
    JSValue v;

#define MIK_I2S_FAIL(ret)   \
    do {                    \
        JS_FreeValue(ctx, v); \
        free(s);            \
        return (ret);       \
    } while (0)

    /* mode: 'std' (default) | 'pdm' */
    v = JS_GetPropertyStr(ctx, opts, "mode");
    if (!JS_IsUndefined(v)) {
        const char* mode = JS_ToCString(ctx, v);
        if (!mode) MIK_I2S_FAIL(JS_EXCEPTION);
        s->pdm = strcmp(mode, "pdm") == 0;
        bool unknown = !s->pdm && strcmp(mode, "std") != 0;
        JS_FreeCString(ctx, mode);
        if (unknown) MIK_I2S_FAIL(JS_ThrowTypeError(ctx, "mode must be 'std' or 'pdm'"));
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "sampleRate");
    if (JS_IsUndefined(v)) MIK_I2S_FAIL(JS_ThrowTypeError(ctx, "sampleRate is required"));
    uint32_t rate;
    if (JS_ToUint32(ctx, &rate, v)) MIK_I2S_FAIL(JS_EXCEPTION);
    s->sample_rate = rate;
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "bitsPerSample");
    if (!JS_IsUndefined(v)) {
        int32_t bits;
        if (JS_ToInt32(ctx, &bits, v)) MIK_I2S_FAIL(JS_EXCEPTION);
        if (bits != 16 && bits != 32)
            MIK_I2S_FAIL(JS_ThrowRangeError(ctx, "bitsPerSample must be 16 or 32"));
        s->bits = bits;
    }
    JS_FreeValue(ctx, v);

    /* channels: 'mono' | 'stereo'. Default stereo for std, mono for pdm. */
    s->stereo = !s->pdm;
    v = JS_GetPropertyStr(ctx, opts, "channels");
    if (!JS_IsUndefined(v)) {
        const char* ch = JS_ToCString(ctx, v);
        if (!ch) MIK_I2S_FAIL(JS_EXCEPTION);
        s->stereo = strcmp(ch, "stereo") == 0;
        bool unknown = !s->stereo && strcmp(ch, "mono") != 0;
        JS_FreeCString(ctx, ch);
        if (unknown) MIK_I2S_FAIL(JS_ThrowTypeError(ctx, "channels must be 'mono' or 'stereo'"));
    }
    JS_FreeValue(ctx, v);

#define MIK_I2S_PIN(field, key)                            \
    v = JS_GetPropertyStr(ctx, opts, key);                 \
    if (!JS_IsUndefined(v)) {                              \
        if (JS_ToInt32(ctx, &s->field, v)) MIK_I2S_FAIL(JS_EXCEPTION); \
    }                                                      \
    JS_FreeValue(ctx, v)

    MIK_I2S_PIN(dout, "dout");
    MIK_I2S_PIN(din, "din");
    if (s->pdm) {
        MIK_I2S_PIN(clk, "clk");
    } else {
        MIK_I2S_PIN(bclk, "bclk");
        MIK_I2S_PIN(ws, "ws");
    }

    v = JS_GetPropertyStr(ctx, opts, "dmaFrames");
    if (!JS_IsUndefined(v)) {
        int32_t n;
        if (JS_ToInt32(ctx, &n, v)) MIK_I2S_FAIL(JS_EXCEPTION);
        if (n > 0) s->dma_frames = n;
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "dmaBuffers");
    if (!JS_IsUndefined(v)) {
        int32_t n;
        if (JS_ToInt32(ctx, &n, v)) MIK_I2S_FAIL(JS_EXCEPTION);
        if (n > 0) s->dma_buffers = n;
    }
    JS_FreeValue(ctx, v);

#undef MIK_I2S_PIN

    /* Direction sanity. PDM here is RX-only. */
    if (s->pdm) {
        if (s->din < 0 || s->clk < 0) {
            free(s);
            return JS_ThrowTypeError(ctx, "pdm mode requires clk and din pins");
        }
        if (s->dout >= 0) {
            free(s);
            return JS_ThrowTypeError(ctx, "pdm mode is receive-only (no dout)");
        }
    } else {
        if (s->bclk < 0 || s->ws < 0) {
            free(s);
            return JS_ThrowTypeError(ctx, "std mode requires bclk and ws pins");
        }
        if (s->dout < 0 && s->din < 0) {
            free(s);
            return JS_ThrowTypeError(ctx, "I2s requires at least one of dout or din pins");
        }
    }

#undef MIK_I2S_FAIL

    JSValue obj = JS_NewObjectClass(ctx, mik_i2s_class_id);
    if (JS_IsException(obj)) {
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── begin / end ──────────────────────────────────────────────────── */

/* The port is captured here from the channel config. We re-derive it on each
 * begin() from the controller default; only one I2s per port is meaningful. */
static JSValue js_i2s_begin(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2s_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (s->begun) return mik__result_ok_void(ctx);  // idempotent

    bool want_tx = s->dout >= 0;
    bool want_rx = s->din >= 0;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(s->port, I2S_ROLE_MASTER);
    chan_cfg.dma_desc_num = s->dma_buffers;
    chan_cfg.dma_frame_num = s->dma_frames;

    esp_err_t err = i2s_new_channel(&chan_cfg, want_tx ? &s->tx_chan : nullptr,
                                    want_rx ? &s->rx_chan : nullptr);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ChannelInitFailed", "i2s_new_channel failed: %s",
                                     esp_err_to_name(err));

    i2s_data_bit_width_t width = mik__i2s_bit_width(s->bits);
    i2s_slot_mode_t slot_mode = mik__i2s_slot_mode(s->stereo);

    if (s->pdm) {
        /* PDM RX is chip-dependent. On targets without it the driver API isn't
         * even declared, so the whole block is compiled out and begin() fails
         * with a clear error rather than failing opaquely (or not compiling). */
#if SOC_I2S_SUPPORTS_PDM_RX
        i2s_pdm_rx_config_t cfg = {
            .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(s->sample_rate),
            .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(width, slot_mode),
            .gpio_cfg =
                {
                    .clk = static_cast<gpio_num_t>(s->clk),
                    .din = static_cast<gpio_num_t>(s->din),
                    .invert_flags = {.clk_inv = false},
                },
        };
        err = i2s_channel_init_pdm_rx_mode(s->rx_chan, &cfg);
        if (err != ESP_OK)
            goto init_failed;
#else
        err = ESP_ERR_NOT_SUPPORTED;
        goto init_failed;
#endif
    } else {
        i2s_std_config_t cfg = {
            .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(s->sample_rate),
            .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(width, slot_mode),
            .gpio_cfg =
                {
                    .mclk = I2S_GPIO_UNUSED,
                    .bclk = static_cast<gpio_num_t>(s->bclk),
                    .ws = static_cast<gpio_num_t>(s->ws),
                    .dout = want_tx ? static_cast<gpio_num_t>(s->dout) : I2S_GPIO_UNUSED,
                    .din = want_rx ? static_cast<gpio_num_t>(s->din) : I2S_GPIO_UNUSED,
                    .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
                },
        };
        /* The Philips mono default is slot_mask = BOTH on every target except the
         * classic ESP32/S2, so mono would read both slots and garble a
         * single-channel mic. Force the left slot for mono: the one a mic with
         * SEL/LR tied to GND drives. */
        if (!s->stereo) cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
        if (s->tx_chan) {
            err = i2s_channel_init_std_mode(s->tx_chan, &cfg);
            if (err != ESP_OK)
                goto init_failed;
        }
        if (s->rx_chan) {
            err = i2s_channel_init_std_mode(s->rx_chan, &cfg);
            if (err != ESP_OK)
                goto init_failed;
        }
    }

    if (s->tx_chan && (err = i2s_channel_enable(s->tx_chan)) != ESP_OK)
        goto init_failed;
    if (s->rx_chan && (err = i2s_channel_enable(s->rx_chan)) != ESP_OK)
        goto init_failed;

    if (!mik__i2s_track(ctx, s)) {
        err = ESP_ERR_NO_MEM;  // more live instances than the loop consumer can drive
        goto init_failed;
    }
    s->begun = true;
    return mik__result_ok_void(ctx);

init_failed:
    /* A channel may already be enabled (e.g. tx enabled, rx enable failed);
     * disable before delete. disable() on a not-yet-enabled channel returns an
     * error we intentionally ignore on this cleanup path. */
    if (s->tx_chan) {
        i2s_channel_disable(s->tx_chan);
        i2s_del_channel(s->tx_chan);
        s->tx_chan = nullptr;
    }
    if (s->rx_chan) {
        i2s_channel_disable(s->rx_chan);
        i2s_del_channel(s->rx_chan);
        s->rx_chan = nullptr;
    }
    return mik__result_err_named(ctx, "ChannelInitFailed", "I2S init failed: %s",
                                 esp_err_to_name(err));
}

/* Settle every queued TX write with a terminal err and free retained tails. */
static void mik__i2s_drain_tx_on_stop(JSContext* ctx, MIKI2sState* s) {
    while (s->tx_count > 0) {
        MIKI2sTxChunk* c = &s->tx_queue[s->tx_head];
        if (MIK_IsPromisePending(ctx, &c->promise)) {
            JSValue e = mik__result_err_tag(ctx, "NotStarted");
            MIK_ResolvePromise(ctx, &c->promise, 1, &e);
            MIK_ClearPromise(ctx, &c->promise);
        }
        js_free(ctx, c->data);
        c->data = nullptr;
        s->tx_head = (s->tx_head + 1) % MIK_I2S_TX_QUEUE_DEPTH;
        s->tx_count--;
    }
}

static JSValue js_i2s_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2s_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_ok_void(ctx);  // idempotent

    mik__i2s_drain_tx_on_stop(ctx, s);

    mik__i2s_untrack(ctx, s);
    if (s->tx_chan) {
        i2s_channel_disable(s->tx_chan);
        i2s_del_channel(s->tx_chan);
        s->tx_chan = nullptr;
    }
    if (s->rx_chan) {
        i2s_channel_disable(s->rx_chan);
        i2s_del_channel(s->rx_chan);
        s->rx_chan = nullptr;
    }
    s->begun = false;
    return mik__result_ok_void(ctx);
}

/* ── TX write (async, bounded queue) ──────────────────────────────── */

/* Push as much of `data[off..len]` to DMA as fits right now (timeout 0).
 * Returns true on progress/no-fault, false on a genuine write fault. */
static bool mik__i2s_push(MIKI2sState* s, MIKI2sTxChunk* c) {
    size_t written = 0;
    esp_err_t err =
        i2s_channel_write(s->tx_chan, c->data + c->off, c->len - c->off, &written, 0);
    if (err == ESP_OK || err == ESP_ERR_TIMEOUT) {
        c->off += written;
        return true;
    }
    return false;  // real fault
}

static JSValue js_i2s_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2s_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__i2s_resolved(ctx, mik__result_err_tag(ctx, "NotStarted"));
    if (!s->tx_chan) return mik__i2s_resolved(ctx, mik__result_err_tag(ctx, "NoTxPin"));

    /* Extract bytes + element width from the typed array. `data_len` is the view
     * length from JS_GetTypedArrayBuffer; JS_GetArrayBuffer reports the whole
     * backing buffer into a throwaway, so a subarray view isn't over-read. */
    size_t data_len, offset, elem_size, buf_len;
    uint8_t* data;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &data_len, &elem_size);
    if (!JS_IsException(ab)) {
        data = JS_GetArrayBuffer(ctx, &buf_len, ab);
        JS_FreeValue(ctx, ab);
        if (!data) return JS_ThrowTypeError(ctx, "expected a typed array as argument 1");
        data += offset;
    } else {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_ThrowTypeError(ctx, "expected a typed array as argument 1");
    }

    /* Width validation: Int16Array↔16, Int32Array↔32. Uint8Array
     * (elem_size 1) is treated as raw bytes, the caller's responsibility. */
    size_t expected = s->bits / 8;
    if (elem_size != 1 && elem_size != expected)
        return mik__i2s_resolved(
            ctx, mik__result_err_named(ctx, "InvalidParam",
                                       "sample width %zu does not match bitsPerSample %d",
                                       elem_size * 8, s->bits));
    /* Reject partial frames (matters for a raw Uint8Array, where elem_size is 1). */
    if (data_len % expected != 0)
        return mik__i2s_resolved(
            ctx, mik__result_err_named(ctx, "InvalidParam",
                                       "byte length %zu is not a whole number of %d-bit samples",
                                       data_len, s->bits));

    if (s->tx_count >= MIK_I2S_TX_QUEUE_DEPTH)
        return mik__i2s_resolved(ctx, mik__result_err_tag(ctx, "QueueFull"));

    /* Copy the payload; the JS array may move/free before we finish draining.
     * On OOM resolve with err rather than throwing, so write() always settles to
     * a Result as its Promise<Result> type promises. */
    auto* copy = static_cast<uint8_t*>(js_malloc(ctx, data_len ? data_len : 1));
    if (!copy)
        return mik__i2s_resolved(
            ctx, mik__result_err_named(ctx, "WriteFailed", "out of memory queueing %zu bytes",
                                       data_len));
    memcpy(copy, data, data_len);

    /* Stage into the next free ring slot but DON'T count it yet: the immediate
     * timeout-0 push below may drain it fully. tx_count is bumped only if a tail
     * remains. Safe because i2s_channel_write(.., 0) can't re-enter JS and call
     * write() again. A future yielding write path would have to revisit this. */
    int idx = (s->tx_head + s->tx_count) % MIK_I2S_TX_QUEUE_DEPTH;
    MIKI2sTxChunk* c = &s->tx_queue[idx];
    c->data = copy;
    c->len = data_len;
    c->off = 0;
    c->promise.p = JS_UNDEFINED;
    c->promise.rfuncs[0] = JS_UNDEFINED;
    c->promise.rfuncs[1] = JS_UNDEFINED;

    /* Try to drain immediately; if it all fits, resolve synchronously. */
    if (!mik__i2s_push(s, c)) {
        js_free(ctx, copy);
        c->data = nullptr;
        return mik__i2s_resolved(ctx, mik__result_err_tag(ctx, "WriteFailed"));
    }
    if (c->off >= c->len) {
        js_free(ctx, copy);
        c->data = nullptr;
        return mik__i2s_resolved(ctx, mik__result_ok_void(ctx));
    }

    /* Tail remains: enqueue and resolve from the loop consumer. */
    s->tx_count++;
    return MIK_InitPromise(ctx, &c->promise);
}

/* ── Bulk capture (blocking, low-overhead) ────────────────────────── */

/* capture(frames, {gainBits?}) → Result<Int16Array, I2sError>. Reads exactly
 * `frames` mono samples, converts 24-in-32 → int16 (with optional gain) in C,
 * and returns one packed buffer, with no per-chunk JS allocation or async
 * machinery, so it can sustain high sample rates. BLOCKING: stalls the JS loop
 * for ~frames/sampleRate while it drains the DMA, so it's for dedicated
 * capture/stream loops, not general use. Reuses the running channel (begin()). */
static JSValue js_i2s_capture(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__i2s_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->begun) return mik__result_err_tag(ctx, "NotStarted");
    if (!s->rx_chan) return mik__result_err_tag(ctx, "NoRxPin");
    /* capture() reads int32 DMA samples and packs them to mono int16; the
     * conversion only makes sense for a 32-bit mono channel. Reject anything
     * else rather than silently misinterpreting the DMA bytes. */
    if (s->bits != 32)
        return mik__result_err_named(ctx, "InvalidParam",
                                     "capture requires bitsPerSample 32, got %d", s->bits);
    if (s->stereo)
        return mik__result_err_named(ctx, "InvalidParam", "capture requires mono channels");

    int64_t frames64;
    if (JS_ToInt64(ctx, &frames64, argv[0])) return JS_EXCEPTION;
    if (frames64 <= 0) return JS_ThrowRangeError(ctx, "frames must be > 0");
    /* Bound it well below the size_t overflow of frames * sizeof(int16_t); any
     * value this large would exhaust the heap long before allocating anyway. */
    if (frames64 > (1 << 24)) return JS_ThrowRangeError(ctx, "frames too large");
    size_t frames = static_cast<size_t>(frames64);

    int32_t gain_bits = 0;
    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValue gv = JS_GetPropertyStr(ctx, argv[1], "gainBits");
        if (!JS_IsUndefined(gv) && JS_ToInt32(ctx, &gain_bits, gv)) {
            JS_FreeValue(ctx, gv);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, gv);
    }
    if (gain_bits < 0) gain_bits = 0;
    if (gain_bits > 16) gain_bits = 16;
    int shift = 16 - gain_bits;

    auto* out = static_cast<int16_t*>(js_malloc(ctx, frames * sizeof(int16_t)));
    if (!out) return JS_ThrowOutOfMemory(ctx);

    int32_t buf[256];  // scratch for one read
    size_t got = 0;
    int timeouts = 0;
    esp_err_t err = ESP_OK;
    while (got < frames) {
        size_t want = frames - got;
        size_t chunk = want < countof(buf) ? want : countof(buf);
        size_t bytes_read = 0;
        esp_err_t r =
            i2s_channel_read(s->rx_chan, buf, chunk * sizeof(int32_t), &bytes_read, 200);  // ms
        if (r == ESP_ERR_TIMEOUT || r == ESP_ERR_INVALID_STATE) {
            if (++timeouts > 20) {  // ~4 s of nothing: treat as a dead mic
                err = r;
                break;
            }
            continue;
        }
        if (r != ESP_OK) {
            err = r;
            break;
        }
        timeouts = 0;
        size_t n = bytes_read / sizeof(int32_t);
        for (size_t i = 0; i < n && got < frames; i++) {
            int32_t v = buf[i] >> shift;
            out[got++] = static_cast<int16_t>(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
        }
    }

    if (err != ESP_OK) {
        js_free(ctx, out);
        return mik__result_err_named(ctx, "ReadFailed", "i2s capture failed: %s",
                                     esp_err_to_name(err));
    }

    JSValue samples =
        mik__i2s_new_samples(ctx, reinterpret_cast<uint8_t*>(out), frames * sizeof(int16_t));
    if (JS_IsException(samples)) return samples;  // frees `out`
    return mik__result_ok(ctx, samples);
}

/* ── Prototype ────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_i2s_proto_funcs[] = {
    MIK_CFUNC_DEF("begin", 0, js_i2s_begin),
    MIK_CFUNC_DEF("end", 0, js_i2s_end),
    MIK_CFUNC_DEF("write", 1, js_i2s_write),
    MIK_CFUNC_DEF("capture", 1, js_i2s_capture),
};

/* ── Module init ──────────────────────────────────────────────────── */

static int mik__i2s_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor = JS_NewCFunction2(ctx, js_i2s_constructor, "I2s", 2, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "I2s", ctor);
    return 0;
}

static JSModuleDef* mik__i2s_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    mik__i2s_slot = MIK_AllocModuleSlot(mik_rt);

    auto* slot_data = static_cast<MIKI2sSlot*>(calloc(1, sizeof(MIKI2sSlot)));
    if (!slot_data) return nullptr;
    mik__i2s_slot_data(mik_rt) = slot_data;

    JSRuntime* rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &mik_i2s_class_id);
    JS_NewClass(rt, mik_i2s_class_id, &mik_i2s_class);
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_i2s_proto_funcs, countof(mik_i2s_proto_funcs));
    JS_SetClassProto(ctx, mik_i2s_class_id, proto);

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/i2s", mik__i2s_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "I2s");
    return m;
}

/* ── Event loop: drain queued TX writes ───────────────────────────── */

void mik__i2s_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* slot = mik__i2s_slot_data(mik_rt);
    if (!slot) return;

    for (int i = 0; i < slot->count; i++) {
        MIKI2sState* s = slot->instances[i];
        if (!s || !s->begun) continue;

        /* Drain TX queue head(s) into DMA as space frees up. */
        while (s->tx_count > 0) {
            MIKI2sTxChunk* c = &s->tx_queue[s->tx_head];
            if (!mik__i2s_push(s, c)) {
                /* Fault: settle this chunk and every later queued chunk with
                 * WriteFailed rather than silently continuing. */
                while (s->tx_count > 0) {
                    MIKI2sTxChunk* f = &s->tx_queue[s->tx_head];
                    if (MIK_IsPromisePending(ctx, &f->promise)) {
                        JSValue e = mik__result_err_tag(ctx, "WriteFailed");
                        MIK_ResolvePromise(ctx, &f->promise, 1, &e);
                        MIK_ClearPromise(ctx, &f->promise);
                    }
                    js_free(ctx, f->data);
                    f->data = nullptr;
                    s->tx_head = (s->tx_head + 1) % MIK_I2S_TX_QUEUE_DEPTH;
                    s->tx_count--;
                }
                break;
            }
            if (c->off < c->len) break;  // DMA full for now; resume next tick
            JSValue ok = mik__result_ok_void(ctx);
            MIK_ResolvePromise(ctx, &c->promise, 1, &ok);
            MIK_ClearPromise(ctx, &c->promise);
            js_free(ctx, c->data);
            c->data = nullptr;
            s->tx_head = (s->tx_head + 1) % MIK_I2S_TX_QUEUE_DEPTH;
            s->tx_count--;
        }
    }
}

void mik__i2s_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* slot = mik__i2s_slot_data(mik_rt);
    if (!slot) return;

    for (int i = 0; i < slot->count; i++) {
        MIKI2sState* s = slot->instances[i];
        if (!s) continue;
        for (int j = 0; j < s->tx_count; j++) {
            MIKI2sTxChunk* c = &s->tx_queue[(s->tx_head + j) % MIK_I2S_TX_QUEUE_DEPTH];
            if (MIK_IsPromisePending(ctx, &c->promise)) MIK_FreePromise(ctx, &c->promise);
        }
    }

    free(slot);
    mik__i2s_slot_data(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(i2s, "native:mikro/i2s", mik__i2s_init, mik__i2s_consume, mik__i2s_destroy)

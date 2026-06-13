#include <cstddef>
#include <cstring>

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_NEOPIXEL_TAG "native:mikro/neopixel"
#define MIK_NEOPIXEL_RMT_RESOLUTION_HZ 10000000  // 10 MHz → 0.1 µs per tick
#define MIK_NEOPIXEL_MAX_LEDS 1024

static JSClassID mik_neopixel_class_id;

/* ── WS2812 RMT encoder (based on ESP-IDF led_strip example) ───────── */

struct mik_led_strip_encoder_t {
    rmt_encoder_t base;
    rmt_encoder_t* bytes_encoder;
    rmt_encoder_t* copy_encoder;
    int state;
    rmt_symbol_word_t reset_code;
};

/* C++-safe container_of: recover enclosing struct from its `base` member */
static inline mik_led_strip_encoder_t* mik__encoder_from_base(rmt_encoder_t* base_ptr) {
    return reinterpret_cast<mik_led_strip_encoder_t*>(
        reinterpret_cast<char*>(base_ptr) - offsetof(mik_led_strip_encoder_t, base));
}

RMT_ENCODER_FUNC_ATTR
static size_t mik__neopixel_encode(rmt_encoder_t* encoder, rmt_channel_handle_t channel,
                                   const void* primary_data, size_t data_size,
                                   rmt_encode_state_t* ret_state) {
    auto* led_enc = mik__encoder_from_base(encoder);
    rmt_encoder_handle_t bytes_encoder = led_enc->bytes_encoder;
    rmt_encoder_handle_t copy_encoder = led_enc->copy_encoder;
    rmt_encode_state_t session_state = RMT_ENCODING_RESET;
    int state = 0;
    size_t encoded_symbols = 0;

    switch (led_enc->state) {
        case 0:  // send pixel data
            encoded_symbols += bytes_encoder->encode(bytes_encoder, channel, primary_data,
                                                     data_size, &session_state);
            if (session_state & RMT_ENCODING_COMPLETE) {
                led_enc->state = 1;
            }
            if (session_state & RMT_ENCODING_MEM_FULL) {
                state |= RMT_ENCODING_MEM_FULL;
                goto out;
            }
            // fall-through
        case 1:  // send reset code
            encoded_symbols +=
                copy_encoder->encode(copy_encoder, channel, &led_enc->reset_code,
                                     sizeof(led_enc->reset_code), &session_state);
            if (session_state & RMT_ENCODING_COMPLETE) {
                led_enc->state = RMT_ENCODING_RESET;
                state |= RMT_ENCODING_COMPLETE;
            }
            if (session_state & RMT_ENCODING_MEM_FULL) {
                state |= RMT_ENCODING_MEM_FULL;
                goto out;
            }
    }
out:
    *ret_state = static_cast<rmt_encode_state_t>(state);
    return encoded_symbols;
}

static esp_err_t mik__neopixel_encoder_del(rmt_encoder_t* encoder) {
    auto* led_enc = mik__encoder_from_base(encoder);
    rmt_del_encoder(led_enc->bytes_encoder);
    rmt_del_encoder(led_enc->copy_encoder);
    free(led_enc);
    return ESP_OK;
}

RMT_ENCODER_FUNC_ATTR
static esp_err_t mik__neopixel_encoder_reset(rmt_encoder_t* encoder) {
    auto* led_enc = mik__encoder_from_base(encoder);
    rmt_encoder_reset(led_enc->bytes_encoder);
    rmt_encoder_reset(led_enc->copy_encoder);
    led_enc->state = RMT_ENCODING_RESET;
    return ESP_OK;
}

static esp_err_t mik__neopixel_new_encoder(uint32_t resolution,
                                           rmt_encoder_handle_t* ret_encoder) {
    auto* led_enc = static_cast<mik_led_strip_encoder_t*>(
        rmt_alloc_encoder_mem(sizeof(mik_led_strip_encoder_t)));
    if (!led_enc) return ESP_ERR_NO_MEM;

    led_enc->base.encode = mik__neopixel_encode;
    led_enc->base.del = mik__neopixel_encoder_del;
    led_enc->base.reset = mik__neopixel_encoder_reset;

    // WS2812 timing: T0H=0.3µs T0L=0.9µs T1H=0.9µs T1L=0.3µs
    rmt_bytes_encoder_config_t bytes_cfg = {};
    bytes_cfg.bit0.level0 = 1;
    bytes_cfg.bit0.duration0 = 0.3 * resolution / 1000000;  // T0H
    bytes_cfg.bit0.level1 = 0;
    bytes_cfg.bit0.duration1 = 0.9 * resolution / 1000000;  // T0L
    bytes_cfg.bit1.level0 = 1;
    bytes_cfg.bit1.duration0 = 0.9 * resolution / 1000000;  // T1H
    bytes_cfg.bit1.level1 = 0;
    bytes_cfg.bit1.duration1 = 0.3 * resolution / 1000000;  // T1L
    bytes_cfg.flags.msb_first = 1;  // WS2812: G7..G0 R7..R0 B7..B0

    esp_err_t err = rmt_new_bytes_encoder(&bytes_cfg, &led_enc->bytes_encoder);
    if (err != ESP_OK) {
        free(led_enc);
        return err;
    }

    rmt_copy_encoder_config_t copy_cfg = {};
    err = rmt_new_copy_encoder(&copy_cfg, &led_enc->copy_encoder);
    if (err != ESP_OK) {
        rmt_del_encoder(led_enc->bytes_encoder);
        free(led_enc);
        return err;
    }

    // Reset code ≥ 50 µs low
    uint32_t reset_ticks = resolution / 1000000 * 50 / 2;
    led_enc->reset_code = {};
    led_enc->reset_code.level0 = 0;
    led_enc->reset_code.duration0 = reset_ticks;
    led_enc->reset_code.level1 = 0;
    led_enc->reset_code.duration1 = reset_ticks;

    *ret_encoder = &led_enc->base;
    return ESP_OK;
}

/* ── Per-instance state ────────────────────────────────────────────── */

typedef struct {
    int gpio;
    int num_leds;
    int bytes_per_led;  // 3 for RGB (GRB wire order), 4 for RGBW (GRBW)
    rmt_channel_handle_t channel;
    rmt_encoder_handle_t encoder;
    uint8_t* pixel_buf;  // GRB(W) encoded, num_leds * bytes_per_led
    bool active;
} MIKNeoPixelState;

/* ── Helpers ───────────────────────────────────────────────────────── */

static MIKNeoPixelState* mik__neopixel_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKNeoPixelState*>(JS_GetOpaque2(ctx, this_val, mik_neopixel_class_id));
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__neopixel_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKNeoPixelState*>(JS_GetOpaque(val, mik_neopixel_class_id));
    if (!s) return;
    if (s->active) {
        rmt_disable(s->channel);
        rmt_del_encoder(s->encoder);
        rmt_del_channel(s->channel);
    }
    free(s->pixel_buf);
    free(s);
}

static JSClassDef mik_neopixel_class = {
    .class_name = "NeoPixel",
    .finalizer = mik__neopixel_finalizer,
};

/* ── Constructor ───────────────────────────────────────────────────── */

static JSValue js_neopixel_constructor(JSContext* ctx, JSValue new_target, int argc,
                                       JSValue* argv) {
    if (argc < 2)
        return JS_ThrowTypeError(ctx,
                                 "NeoPixel requires (pin, numLeds) or (pin, numLeds, bytesPerLed)");

    int32_t gpio;
    if (JS_ToInt32(ctx, &gpio, argv[0])) return JS_EXCEPTION;

    int32_t num_leds;
    if (JS_ToInt32(ctx, &num_leds, argv[1])) return JS_EXCEPTION;
    if (num_leds <= 0 || num_leds > MIK_NEOPIXEL_MAX_LEDS)
        return JS_ThrowRangeError(ctx, "numLeds must be between 1 and %d", MIK_NEOPIXEL_MAX_LEDS);

    int32_t bytes_per_led = 3;  // default: RGB (GRB on wire)
    if (argc >= 3) {
        if (JS_ToInt32(ctx, &bytes_per_led, argv[2])) return JS_EXCEPTION;
        if (bytes_per_led != 3 && bytes_per_led != 4)
            return JS_ThrowRangeError(ctx, "bytesPerLed must be 3 (RGB) or 4 (RGBW)");
    }

    /* Allocate pixel buffer */
    size_t buf_size = static_cast<size_t>(num_leds) * bytes_per_led;
    auto* pixel_buf = static_cast<uint8_t*>(calloc(1, buf_size));
    if (!pixel_buf) return JS_ThrowOutOfMemory(ctx);

    /* Create RMT TX channel */
    rmt_channel_handle_t channel = nullptr;
    rmt_tx_channel_config_t tx_cfg = {};
    tx_cfg.clk_src = RMT_CLK_SRC_DEFAULT;
    tx_cfg.gpio_num = static_cast<gpio_num_t>(gpio);
    tx_cfg.mem_block_symbols = 64;
    tx_cfg.resolution_hz = MIK_NEOPIXEL_RMT_RESOLUTION_HZ;
    tx_cfg.trans_queue_depth = 4;

    esp_err_t err = rmt_new_tx_channel(&tx_cfg, &channel);
    if (err != ESP_OK) {
        free(pixel_buf);
        return JS_ThrowInternalError(ctx, "RMT channel create failed: %s", esp_err_to_name(err));
    }

    /* Create LED strip encoder */
    rmt_encoder_handle_t encoder = nullptr;
    err = mik__neopixel_new_encoder(MIK_NEOPIXEL_RMT_RESOLUTION_HZ, &encoder);
    if (err != ESP_OK) {
        rmt_del_channel(channel);
        free(pixel_buf);
        return JS_ThrowInternalError(ctx, "LED encoder create failed: %s", esp_err_to_name(err));
    }

    /* Enable channel */
    err = rmt_enable(channel);
    if (err != ESP_OK) {
        rmt_del_encoder(encoder);
        rmt_del_channel(channel);
        free(pixel_buf);
        return JS_ThrowInternalError(ctx, "RMT enable failed: %s", esp_err_to_name(err));
    }

    /* Allocate state */
    auto* s = static_cast<MIKNeoPixelState*>(calloc(1, sizeof(MIKNeoPixelState)));
    if (!s) {
        rmt_disable(channel);
        rmt_del_encoder(encoder);
        rmt_del_channel(channel);
        free(pixel_buf);
        return JS_ThrowOutOfMemory(ctx);
    }
    s->gpio = gpio;
    s->num_leds = num_leds;
    s->bytes_per_led = bytes_per_led;
    s->channel = channel;
    s->encoder = encoder;
    s->pixel_buf = pixel_buf;
    s->active = true;

    JSValue obj = JS_NewObjectClass(ctx, mik_neopixel_class_id);
    if (JS_IsException(obj)) {
        rmt_disable(channel);
        rmt_del_encoder(encoder);
        rmt_del_channel(channel);
        free(pixel_buf);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── Methods ───────────────────────────────────────────────────────── */

/* setPixel(index, r, g, b [, w]) */
static JSValue js_neopixel_set_pixel(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__neopixel_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active)
        return mik__result_err_tag(ctx, "NotActive");

    int32_t index;
    if (JS_ToInt32(ctx, &index, argv[0])) return JS_EXCEPTION;
    if (index < 0 || index >= s->num_leds) return mik__result_err_tag(ctx, "IndexOutOfRange");

    int32_t r, g, b;
    if (JS_ToInt32(ctx, &r, argv[1])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &g, argv[2])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &b, argv[3])) return JS_EXCEPTION;

    uint8_t* p = s->pixel_buf + index * s->bytes_per_led;
    // WS2812 wire order: GRB
    p[0] = static_cast<uint8_t>(g & 0xFF);
    p[1] = static_cast<uint8_t>(r & 0xFF);
    p[2] = static_cast<uint8_t>(b & 0xFF);

    if (s->bytes_per_led == 4) {
        int32_t w = 0;
        if (argc >= 5) {
            if (JS_ToInt32(ctx, &w, argv[4])) return JS_EXCEPTION;
        }
        p[3] = static_cast<uint8_t>(w & 0xFF);
    }

    return mik__result_ok_void(ctx);
}

/* fill(r, g, b [, w]) */
static JSValue js_neopixel_fill(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__neopixel_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active)
        return mik__result_err_tag(ctx, "NotActive");

    int32_t r, g, b;
    if (JS_ToInt32(ctx, &r, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &g, argv[1])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &b, argv[2])) return JS_EXCEPTION;

    int32_t w = 0;
    if (s->bytes_per_led == 4 && argc >= 4) {
        if (JS_ToInt32(ctx, &w, argv[3])) return JS_EXCEPTION;
    }

    for (int i = 0; i < s->num_leds; i++) {
        uint8_t* p = s->pixel_buf + i * s->bytes_per_led;
        p[0] = static_cast<uint8_t>(g & 0xFF);
        p[1] = static_cast<uint8_t>(r & 0xFF);
        p[2] = static_cast<uint8_t>(b & 0xFF);
        if (s->bytes_per_led == 4) {
            p[3] = static_cast<uint8_t>(w & 0xFF);
        }
    }

    return mik__result_ok_void(ctx);
}

/* show() — transmit pixel buffer via RMT */
static JSValue js_neopixel_show(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__neopixel_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active)
        return mik__result_err_tag(ctx, "NotActive");

    rmt_transmit_config_t tx_cfg = {};
    tx_cfg.loop_count = 0;

    size_t buf_size = static_cast<size_t>(s->num_leds) * s->bytes_per_led;
    esp_err_t err = rmt_transmit(s->channel, s->encoder, s->pixel_buf, buf_size, &tx_cfg);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ShowFailed", "RMT transmit failed: %s",
                               esp_err_to_name(err));

    err = rmt_tx_wait_all_done(s->channel, pdMS_TO_TICKS(1000));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ShowFailed",
                                     "RMT wait for transmit failed: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

/* clear() — zero all pixels and transmit */
static JSValue js_neopixel_clear(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__neopixel_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active)
        return mik__result_err_tag(ctx, "NotActive");

    memset(s->pixel_buf, 0, static_cast<size_t>(s->num_leds) * s->bytes_per_led);

    rmt_transmit_config_t tx_cfg = {};
    tx_cfg.loop_count = 0;

    size_t buf_size = static_cast<size_t>(s->num_leds) * s->bytes_per_led;
    esp_err_t err = rmt_transmit(s->channel, s->encoder, s->pixel_buf, buf_size, &tx_cfg);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ShowFailed", "RMT transmit failed: %s",
                               esp_err_to_name(err));

    err = rmt_tx_wait_all_done(s->channel, pdMS_TO_TICKS(1000));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ShowFailed",
                                     "RMT wait for transmit failed: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

/* end() — release RMT resources */
static JSValue js_neopixel_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__neopixel_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return mik__result_ok_void(ctx);  // idempotent

    rmt_disable(s->channel);
    rmt_del_encoder(s->encoder);
    rmt_del_channel(s->channel);
    s->encoder = nullptr;
    s->channel = nullptr;
    s->active = false;
    return mik__result_ok_void(ctx);
}

/* ── Prototype ─────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_neopixel_proto_funcs[] = {
    MIK_CFUNC_DEF("setPixel", 5, js_neopixel_set_pixel),
    MIK_CFUNC_DEF("fill", 4, js_neopixel_fill),
    MIK_CFUNC_DEF("show", 0, js_neopixel_show),
    MIK_CFUNC_DEF("clear", 0, js_neopixel_clear),
    MIK_CFUNC_DEF("end", 0, js_neopixel_end),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__neopixel_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor = JS_NewCFunction2(ctx, js_neopixel_constructor, "NeoPixel", 3,
                                    JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "NeoPixel", ctor);
    return 0;
}

static JSModuleDef* mik__neopixel_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    JS_NewClassID(rt, &mik_neopixel_class_id);
    JS_NewClass(rt, mik_neopixel_class_id, &mik_neopixel_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_neopixel_proto_funcs,
                               countof(mik_neopixel_proto_funcs));
    JS_SetClassProto(ctx, mik_neopixel_class_id, proto);  /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/neopixel", mik__neopixel_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "NeoPixel");
    return m;
}

MIK_REGISTER_MODULE(neopixel, "native:mikro/neopixel", mik__neopixel_init, nullptr, nullptr)

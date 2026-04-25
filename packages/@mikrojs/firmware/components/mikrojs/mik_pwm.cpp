#include <atomic>
#include <cstring>

#include "driver/ledc.h"
#include "esp_log.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_PWM_TAG "native:pwm"
#define MIK_PWM_MAX_CHANNELS LEDC_CHANNEL_MAX
#define MIK_PWM_MAX_TIMERS LEDC_TIMER_MAX
#define MIK_PWM_MAX_PENDING_FADES 8

static JSClassID mik_pwm_class_id;

/* ── Channel / timer pool ──────────────────────────────────────────── */

static uint8_t s_channel_used = 0;  // bitmask of allocated channels
static uint32_t s_timer_freq[MIK_PWM_MAX_TIMERS] = {};
static uint8_t s_timer_refcount[MIK_PWM_MAX_TIMERS] = {};
static bool s_fade_installed = false;

static int mik__pwm_alloc_channel() {
    for (int i = 0; i < MIK_PWM_MAX_CHANNELS; i++) {
        if (!(s_channel_used & (1 << i))) {
            s_channel_used |= (1 << i);
            return i;
        }
    }
    return -1;
}

static void mik__pwm_free_channel(int ch) {
    if (ch >= 0 && ch < MIK_PWM_MAX_CHANNELS) {
        s_channel_used &= ~(1 << ch);
    }
}

static int mik__pwm_alloc_timer(uint32_t freq) {
    /* Try to share an existing timer with the same frequency */
    for (int i = 0; i < MIK_PWM_MAX_TIMERS; i++) {
        if (s_timer_refcount[i] > 0 && s_timer_freq[i] == freq) {
            s_timer_refcount[i]++;
            return i;
        }
    }
    /* Allocate a new timer */
    for (int i = 0; i < MIK_PWM_MAX_TIMERS; i++) {
        if (s_timer_refcount[i] == 0) {
            s_timer_freq[i] = freq;
            s_timer_refcount[i] = 1;
            return i;
        }
    }
    return -1;
}

static void mik__pwm_free_timer(int timer) {
    if (timer >= 0 && timer < MIK_PWM_MAX_TIMERS) {
        if (s_timer_refcount[timer] > 0) {
            s_timer_refcount[timer]--;
        }
    }
}

/* ── Resolution helper ─────────────────────────────────────────────── */

static ledc_timer_bit_t mik__pwm_best_resolution(uint32_t freq) {
    /* Pick the highest resolution that works for this frequency.
     * Max duty resolution = log2(APB_CLK_FREQ / freq).
     * APB clock is typically 80 MHz. Clamp to LEDC limits. */
    uint32_t apb_clk = 80000000;
    int max_bits = 0;
    uint32_t ratio = apb_clk / freq;
    while (ratio > 1) {
        ratio >>= 1;
        max_bits++;
    }
    if (max_bits < 1) max_bits = 1;
    if (max_bits > LEDC_TIMER_14_BIT) max_bits = LEDC_TIMER_14_BIT;
    return static_cast<ledc_timer_bit_t>(max_bits);
}

/* ── Per-instance state ────────────────────────────────────────────── */

typedef struct {
    int gpio;
    int channel;
    int timer;
    uint32_t freq;
    ledc_timer_bit_t resolution;
    double duty;  // 0.0–1.0
    bool active;
} MIKPwmState;

/* ── Fade tracking ─────────────────────────────────────────────────── */

struct MIKPwmFadePending {
    int channel;                  // LEDC channel that is fading
    MIKPromise promise;
    std::atomic<bool> complete;   // set from ISR
};

/* Dynamic module data slot, allocated on first import */
static int mik__pwm_slot = -1;

/* Helper to access PWM module state from runtime */
static inline MIKPwmFadePending*& mik__pwm_fades(MIKRuntime* rt) {
    return reinterpret_cast<MIKPwmFadePending*&>(rt->module_data[mik__pwm_slot]);
}

static int s_fade_count = 0;

static IRAM_ATTR bool mik__pwm_fade_cb(const ledc_cb_param_t* param, void* user_arg) {
    auto* pending = static_cast<MIKPwmFadePending*>(user_arg);
    if (param->event == LEDC_FADE_END_EVT) {
        pending->complete.store(true, std::memory_order_release);
    }
    return false;  // no high-priority task woken
}

/* ── Helpers ───────────────────────────────────────────────────────── */

static MIKPwmState* mik__pwm_get(JSContext* ctx, JSValue this_val) {
    return static_cast<MIKPwmState*>(JS_GetOpaque2(ctx, this_val, mik_pwm_class_id));
}

static uint32_t mik__pwm_duty_to_raw(double duty, ledc_timer_bit_t resolution) {
    uint32_t max_duty = (1u << resolution) - 1;
    if (duty <= 0.0) return 0;
    if (duty >= 1.0) return max_duty;
    return static_cast<uint32_t>(duty * max_duty + 0.5);
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__pwm_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKPwmState*>(JS_GetOpaque(val, mik_pwm_class_id));
    if (!s) return;
    if (s->active) {
        ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), 0);
        mik__pwm_free_channel(s->channel);
        mik__pwm_free_timer(s->timer);
    }
    free(s);
}

static JSClassDef mik_pwm_class = {
    .class_name = "Pwm",
    .finalizer = mik__pwm_finalizer,
};

/* ── Constructor ───────────────────────────────────────────────────── */

static JSValue js_pwm_constructor(JSContext* ctx, JSValue new_target, int argc, JSValue* argv) {
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Pwm requires (pin, freq) or (pin, freq, duty)");

    int32_t gpio;
    if (JS_ToInt32(ctx, &gpio, argv[0])) return JS_EXCEPTION;

    double freq;
    if (JS_ToFloat64(ctx, &freq, argv[1])) return JS_EXCEPTION;
    if (freq <= 0) return JS_ThrowRangeError(ctx, "frequency must be > 0");

    double duty = 0.0;
    if (argc >= 3) {
        if (JS_ToFloat64(ctx, &duty, argv[2])) return JS_EXCEPTION;
        if (duty < 0.0 || duty > 1.0)
            return JS_ThrowRangeError(ctx, "duty must be between 0.0 and 1.0");
    }

    int ch = mik__pwm_alloc_channel();
    if (ch < 0)
        return JS_ThrowInternalError(ctx, "no free PWM channels (max %d)", MIK_PWM_MAX_CHANNELS);

    int timer = mik__pwm_alloc_timer(static_cast<uint32_t>(freq));
    if (timer < 0) {
        mik__pwm_free_channel(ch);
        return JS_ThrowInternalError(ctx, "no free PWM timers (max %d)", MIK_PWM_MAX_TIMERS);
    }

    ledc_timer_bit_t resolution = mik__pwm_best_resolution(static_cast<uint32_t>(freq));

    /* Configure timer */
    ledc_timer_config_t timer_cfg = {};
    timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_cfg.duty_resolution = resolution;
    timer_cfg.timer_num = static_cast<ledc_timer_t>(timer);
    timer_cfg.freq_hz = static_cast<uint32_t>(freq);
    timer_cfg.clk_cfg = LEDC_AUTO_CLK;

    esp_err_t err = ledc_timer_config(&timer_cfg);
    if (err != ESP_OK) {
        mik__pwm_free_channel(ch);
        mik__pwm_free_timer(timer);
        return JS_ThrowInternalError(ctx, "LEDC timer config failed: %s", esp_err_to_name(err));
    }

    /* Configure channel */
    ledc_channel_config_t ch_cfg = {};
    ch_cfg.gpio_num = gpio;
    ch_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_cfg.channel = static_cast<ledc_channel_t>(ch);
    ch_cfg.timer_sel = static_cast<ledc_timer_t>(timer);
    ch_cfg.duty = mik__pwm_duty_to_raw(duty, resolution);
    ch_cfg.hpoint = 0;

    err = ledc_channel_config(&ch_cfg);
    if (err != ESP_OK) {
        mik__pwm_free_channel(ch);
        mik__pwm_free_timer(timer);
        return JS_ThrowInternalError(ctx, "LEDC channel config failed: %s", esp_err_to_name(err));
    }

    /* Install fade service (once) */
    if (!s_fade_installed) {
        err = ledc_fade_func_install(0);
        if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
            s_fade_installed = true;
        }
    }

    auto* s = static_cast<MIKPwmState*>(calloc(1, sizeof(MIKPwmState)));
    if (!s) {
        mik__pwm_free_channel(ch);
        mik__pwm_free_timer(timer);
        return JS_ThrowOutOfMemory(ctx);
    }
    s->gpio = gpio;
    s->channel = ch;
    s->timer = timer;
    s->freq = static_cast<uint32_t>(freq);
    s->resolution = resolution;
    s->duty = duty;
    s->active = true;

    JSValue obj = JS_NewObjectClass(ctx, mik_pwm_class_id);
    if (JS_IsException(obj)) {
        ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch), 0);
        mik__pwm_free_channel(ch);
        mik__pwm_free_timer(timer);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

/* ── Methods ───────────────────────────────────────────────────────── */

static JSValue js_pwm_duty(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return mik__result_err_tag(ctx, "NotActive");

    /* Getter */
    if (argc == 0 || JS_IsUndefined(argv[0])) {
        return mik__result_ok(ctx, JS_NewFloat64(ctx, s->duty));
    }

    /* Setter */
    double duty;
    if (JS_ToFloat64(ctx, &duty, argv[0])) return JS_EXCEPTION;
    if (duty < 0.0 || duty > 1.0)
        return mik__result_err_named(ctx, "DutyFailed", "duty must be 0.0-1.0");

    uint32_t raw = mik__pwm_duty_to_raw(duty, s->resolution);
    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), raw);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "DutyFailed", "failed to set duty: %s",
                                     esp_err_to_name(err));

    err = ledc_update_duty(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "DutyFailed", "failed to update duty: %s",
                                     esp_err_to_name(err));

    s->duty = duty;
    return mik__result_ok_void(ctx);
}

static JSValue js_pwm_freq(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return mik__result_err_tag(ctx, "NotActive");

    /* Getter */
    if (argc == 0 || JS_IsUndefined(argv[0])) {
        return mik__result_ok(ctx, JS_NewFloat64(ctx, static_cast<double>(s->freq)));
    }

    /* Setter */
    double freq;
    if (JS_ToFloat64(ctx, &freq, argv[0])) return JS_EXCEPTION;
    if (freq <= 0) return mik__result_err_named(ctx, "FreqFailed", "frequency must be positive");

    uint32_t new_freq = static_cast<uint32_t>(freq);
    ledc_timer_bit_t new_resolution = mik__pwm_best_resolution(new_freq);

    /* Release old timer, allocate new one */
    mik__pwm_free_timer(s->timer);
    int new_timer = mik__pwm_alloc_timer(new_freq);
    if (new_timer < 0) {
        /* Re-claim old timer */
        s->timer = mik__pwm_alloc_timer(s->freq);
        return mik__result_err_named(ctx, "NoTimer",
                                     "no free PWM timers (max %d)", MIK_PWM_MAX_TIMERS);
    }

    ledc_timer_config_t timer_cfg = {};
    timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_cfg.duty_resolution = new_resolution;
    timer_cfg.timer_num = static_cast<ledc_timer_t>(new_timer);
    timer_cfg.freq_hz = new_freq;
    timer_cfg.clk_cfg = LEDC_AUTO_CLK;

    esp_err_t err = ledc_timer_config(&timer_cfg);
    if (err != ESP_OK) {
        mik__pwm_free_timer(new_timer);
        s->timer = mik__pwm_alloc_timer(s->freq);
        return mik__result_err_named(ctx, "FreqFailed",
                                     "failed to configure timer: %s", esp_err_to_name(err));
    }

    /* Bind channel to new timer */
    err = ledc_bind_channel_timer(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel),
                                  static_cast<ledc_timer_t>(new_timer));
    if (err != ESP_OK) {
        mik__pwm_free_timer(new_timer);
        s->timer = mik__pwm_alloc_timer(s->freq);
        return mik__result_err_named(ctx, "FreqFailed",
                                     "failed to bind channel to timer: %s", esp_err_to_name(err));
    }

    s->timer = new_timer;
    s->freq = new_freq;
    s->resolution = new_resolution;

    /* Re-apply duty at new resolution */
    uint32_t raw = mik__pwm_duty_to_raw(s->duty, s->resolution);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), raw);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel));

    return mik__result_ok(ctx, JS_NewFloat64(ctx, static_cast<double>(s->freq)));
}

static JSValue js_pwm_fade(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return mik__result_err_tag(ctx, "NotActive");
    if (!s_fade_installed)
        return mik__result_err_named(ctx, "FadeFailed", "fade service not installed");

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (s_fade_count >= MIK_PWM_MAX_PENDING_FADES)
        return mik__result_err_named(ctx, "FadeFailed",
                                     "too many pending fades (max %d)",
                                     MIK_PWM_MAX_PENDING_FADES);

    double target;
    if (JS_ToFloat64(ctx, &target, argv[0])) return JS_EXCEPTION;
    if (target < 0.0 || target > 1.0)
        return mik__result_err_named(ctx, "DutyFailed", "duty must be 0.0-1.0");

    int32_t duration_ms;
    if (JS_ToInt32(ctx, &duration_ms, argv[1])) return JS_EXCEPTION;
    if (duration_ms < 0)
        return mik__result_err_named(ctx, "FadeFailed", "fade duration must be non-negative");

    /* Allocate fade tracking entry */
    auto* fades = mik__pwm_fades(mik_rt);
    if (!fades) {
        fades = static_cast<MIKPwmFadePending*>(
            calloc(MIK_PWM_MAX_PENDING_FADES, sizeof(MIKPwmFadePending)));
        if (!fades) return JS_ThrowOutOfMemory(ctx);
        for (int j = 0; j < MIK_PWM_MAX_PENDING_FADES; j++) {
            MIK_ClearPromise(ctx, &fades[j].promise);
        }
        mik__pwm_fades(mik_rt) = fades;
    }

    /* Find free slot */
    int slot = -1;
    for (int i = 0; i < MIK_PWM_MAX_PENDING_FADES; i++) {
        if (!MIK_IsPromisePending(ctx, &fades[i].promise)) {
            slot = i;
            break;
        }
    }
    if (slot < 0)
        return mik__result_err_named(ctx, "FadeFailed", "no free fade slots available");

    /* Create promise */
    fades[slot].channel = s->channel;
    fades[slot].complete.store(false, std::memory_order_relaxed);
    JSValue promise = MIK_InitPromise(ctx, &fades[slot].promise);
    s_fade_count++;

    /* Register fade callback */
    ledc_cbs_t cbs = {};
    cbs.fade_cb = mik__pwm_fade_cb;
    ledc_cb_register(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), &cbs,
                     &fades[slot]);

    /* Start fade */
    uint32_t target_raw = mik__pwm_duty_to_raw(target, s->resolution);
    esp_err_t err = ledc_set_fade_with_time(LEDC_LOW_SPEED_MODE,
                                             static_cast<ledc_channel_t>(s->channel), target_raw,
                                             duration_ms);
    if (err != ESP_OK) {
        s_fade_count--;
        MIK_FreePromise(ctx, &fades[slot].promise);
        return mik__result_err_named(ctx, "FadeFailed",
                                     "failed to configure fade: %s", esp_err_to_name(err));
    }

    err = ledc_fade_start(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel),
                          LEDC_FADE_NO_WAIT);
    if (err != ESP_OK) {
        s_fade_count--;
        MIK_FreePromise(ctx, &fades[slot].promise);
        return mik__result_err_named(ctx, "FadeFailed",
                                     "failed to start fade: %s", esp_err_to_name(err));
    }

    /* Update duty to target (will be accurate once fade completes) */
    s->duty = target;

    return mik__result_ok(ctx, promise);
}

static JSValue js_pwm_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return mik__result_ok_void(ctx);  // idempotent

    ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), 0);
    mik__pwm_free_channel(s->channel);
    mik__pwm_free_timer(s->timer);
    s->active = false;
    return mik__result_ok_void(ctx);
}

/* ── Prototype ─────────────────────────────────────────────────────── */

static const JSCFunctionListEntry mik_pwm_proto_funcs[] = {
    MIK_CFUNC_DEF("duty", 1, js_pwm_duty),
    MIK_CFUNC_DEF("freq", 1, js_pwm_freq),
    MIK_CFUNC_DEF("fade", 2, js_pwm_fade),
    MIK_CFUNC_DEF("end", 0, js_pwm_end),
};

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__pwm_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor =
        JS_NewCFunction2(ctx, js_pwm_constructor, "Pwm", 3, JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "Pwm", ctor);
    return 0;
}

static JSModuleDef* mik__pwm_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    mik__pwm_slot = MIK_AllocModuleSlot(mik_rt);

    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    JS_NewClassID(rt, &mik_pwm_class_id);
    JS_NewClass(rt, mik_pwm_class_id, &mik_pwm_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_pwm_proto_funcs, countof(mik_pwm_proto_funcs));
    JS_SetClassProto(ctx, mik_pwm_class_id, proto);  /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "native:pwm", mik__pwm_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Pwm");
    return m;
}

/* ── Event loop: fade completion ───────────────────────────────────── */

void mik__pwm_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* fades = mik__pwm_fades(mik_rt);
    if (!fades) return;

    for (int i = 0; i < MIK_PWM_MAX_PENDING_FADES; i++) {
        if (!MIK_IsPromisePending(ctx, &fades[i].promise)) continue;
        if (!fades[i].complete.load(std::memory_order_acquire)) continue;

        /* Fade completed — resolve promise and mark slot as free */
        JSValue undef = JS_UNDEFINED;
        MIK_ResolvePromise(ctx, &fades[i].promise, 1, &undef);
        MIK_ClearPromise(ctx, &fades[i].promise);
        s_fade_count--;
    }
}

void mik__pwm_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    auto* fades = mik__pwm_fades(mik_rt);
    if (!fades) return;

    for (int i = 0; i < MIK_PWM_MAX_PENDING_FADES; i++) {
        if (MIK_IsPromisePending(ctx, &fades[i].promise)) {
            MIK_FreePromise(ctx, &fades[i].promise);
            s_fade_count--;
        }
    }

    free(fades);
    mik__pwm_fades(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(pwm, "native:pwm", mik__pwm_init, mik__pwm_consume, mik__pwm_destroy)

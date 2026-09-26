#include <atomic>
#include <cstring>

#include "driver/ledc.h"
#include "soc/soc_caps.h"
#include "esp_log.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

#define MIK_PWM_TAG "mikro/pwm"
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
    bool warned_after_end;
} MIKPwmState;

/* ── Fade tracking ─────────────────────────────────────────────────── */

struct MIKPwmFadePending {
    int channel;                  // LEDC channel that is fading
    MIKPromise promise;
    std::atomic<bool> complete;   // set from ISR, or by the finalizer to settle with ok()
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

/* The channel's fade that is still running, or nullptr. */
static MIKPwmFadePending* mik__pwm_running_fade(MIKRuntime* mik_rt, int channel) {
    MIKPwmFadePending* fades = mik_rt ? mik__pwm_fades(mik_rt) : nullptr;
    if (!fades) return nullptr;
    for (int i = 0; i < MIK_PWM_MAX_PENDING_FADES; i++) {
        if (!JS_IsUndefined(fades[i].promise.p) && fades[i].channel == channel &&
            !fades[i].complete.load(std::memory_order_acquire))
            return &fades[i];
    }
    return nullptr;
}

/* Stops a running fade and detaches the channel's callback, so no later
 * fade-end event reaches the slot. The ESP32 cannot stop a fade early. */
static void mik__pwm_stop_fade(int channel) {
    auto ch = static_cast<ledc_channel_t>(channel);
#if SOC_LEDC_SUPPORT_FADE_STOP
    ledc_fade_stop(LEDC_LOW_SPEED_MODE, ch);
#endif
    ledc_cbs_t cbs = {};
    ledc_cb_register(LEDC_LOW_SPEED_MODE, ch, &cbs, nullptr);
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

/* Stops the output and returns the channel, timer and GPIO pin. */
static void mik__pwm_release(MIKPwmState* s) {
    ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(s->channel), 0);
    mik__pwm_free_channel(s->channel);
    mik__pwm_free_timer(s->timer);
    MIK_ReleaseGpio(s->gpio, "Pwm");
    s->active = false;
}

/* True when the handle was ended; the first such call prints a warning. */
static bool mik__pwm_ended(MIKPwmState* s, const char* call) {
    if (s->active) return false;
    mik__warn_after_end(&s->warned_after_end, "Pwm", s->gpio, call, "pin");
    return true;
}

/* LEDC takes a whole number of Hz; 40 MHz is the APB clock over a 1-bit duty. */
static JSValue mik__pwm_check_freq(JSContext* ctx, double freq) {
    if (freq >= 1 && freq <= 40000000) return JS_UNDEFINED;
    return mik__result_err_named(ctx, "InvalidParam", "freq must be 1 to 40000000 Hz, got %g",
                                 freq);
}

static JSValue mik__pwm_check_duty(JSContext* ctx, const char* name, double duty) {
    if (duty >= 0.0 && duty <= 1.0) return JS_UNDEFINED;
    return mik__result_err_named(ctx, "InvalidParam", "%s must be 0 to 1, got %g", name, duty);
}

/* ── Finalizer ─────────────────────────────────────────────────────── */

static void mik__pwm_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<MIKPwmState*>(JS_GetOpaque(val, mik_pwm_class_id));
    if (!s) return;
    if (s->active) {
        auto* mik_rt = static_cast<MIKRuntime*>(JS_GetRuntimeOpaque(rt));
        MIKPwmFadePending* fade = mik__pwm_running_fade(mik_rt, s->channel);
        if (fade) {
            /* No ctx here: flag the slot and the loop consumer settles it. */
            mik__pwm_stop_fade(s->channel);
            fade->complete.store(true, std::memory_order_release);
        }
        mik__pwm_release(s);
    }
    free(s);
}

static JSClassDef mik_pwm_class = {
    .class_name = "Pwm",
    .finalizer = mik__pwm_finalizer,
};

/* ── Factory ───────────────────────────────────────────────────────── */

/* Pwm(gpio, {freq, duty?}) → Result<Pwm, PwmError> */
static JSValue js_pwm(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t gpio;
    JSValueConst options;
    double freq;
    double duty = 0.0;
    if (mik__to_int_arg(ctx, argc >= 1 ? argv[0] : JS_UNDEFINED, "gpio", &gpio) ||
        mik__options_arg(ctx, argc, argv, 1, true, &options) ||
        mik__number_option(ctx, options, "freq", true, &freq) ||
        mik__number_option(ctx, options, "duty", false, &duty))
        return JS_EXCEPTION;

    JSValue invalid = mik__pwm_check_freq(ctx, freq);
    if (JS_IsUndefined(invalid)) invalid = mik__pwm_check_duty(ctx, "duty", duty);
    if (!JS_IsUndefined(invalid)) return invalid;
    const MIKGpioCheck check = {gpio, true};
    invalid = mik__gpio_check(ctx, &check, 1);
    if (!JS_IsUndefined(invalid)) return invalid;
    const int gpios[] = {gpio};
    JSValue claim_failed = MIK_ClaimGpios(ctx, gpios, 1, "Pwm");
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    int ch = mik__pwm_alloc_channel();
    if (ch < 0) {
        MIK_ReleaseGpio(gpio, "Pwm");
        return mik__result_err_named(ctx, "NoChannel", "no free PWM channels (max %d)",
                                     MIK_PWM_MAX_CHANNELS);
    }

    int timer = mik__pwm_alloc_timer(static_cast<uint32_t>(freq));
    if (timer < 0) {
        MIK_ReleaseGpio(gpio, "Pwm");
        mik__pwm_free_channel(ch);
        return mik__result_err_named(ctx, "NoTimer", "no free PWM timers (max %d)",
                                     MIK_PWM_MAX_TIMERS);
    }

    ledc_timer_bit_t resolution = mik__pwm_best_resolution(static_cast<uint32_t>(freq));

    ledc_timer_config_t timer_cfg = {};
    timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_cfg.duty_resolution = resolution;
    timer_cfg.timer_num = static_cast<ledc_timer_t>(timer);
    timer_cfg.freq_hz = static_cast<uint32_t>(freq);
    timer_cfg.clk_cfg = LEDC_AUTO_CLK;

    ledc_channel_config_t ch_cfg = {};
    ch_cfg.gpio_num = gpio;
    ch_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_cfg.channel = static_cast<ledc_channel_t>(ch);
    ch_cfg.timer_sel = static_cast<ledc_timer_t>(timer);
    ch_cfg.duty = mik__pwm_duty_to_raw(duty, resolution);
    ch_cfg.hpoint = 0;

    const char* step = "ledc_timer_config";
    esp_err_t err = ledc_timer_config(&timer_cfg);
    if (err == ESP_OK) {
        step = "ledc_channel_config";
        err = ledc_channel_config(&ch_cfg);
    }
    if (err != ESP_OK) {
        MIK_ReleaseGpio(gpio, "Pwm");
        mik__pwm_free_channel(ch);
        mik__pwm_free_timer(timer);
        return mik__result_err_named(ctx, "ConfigFailed", "%s failed on GPIO %d: %s", step, gpio,
                                     esp_err_to_name(err));
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
        ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch), 0);
        MIK_ReleaseGpio(gpio, "Pwm");
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
        mik__pwm_release(s);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    MIK_KeepHandle(ctx, obj);
    return mik__result_ok(ctx, obj);
}

/* ── Methods ───────────────────────────────────────────────────────── */

static JSValue js_pwm_duty(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    bool set = argc > 0 && !JS_IsUndefined(argv[0]);
    double duty = 0.0;
    if (set && mik__to_number_arg(ctx, argv[0], "duty", &duty)) return JS_EXCEPTION;
    if (mik__pwm_ended(s, "duty()") || !set) {
        return set ? mik__result_ok_void(ctx) : mik__result_ok(ctx, JS_NewFloat64(ctx, s->duty));
    }

    JSValue invalid = mik__pwm_check_duty(ctx, "duty", duty);
    if (!JS_IsUndefined(invalid)) return invalid;

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
    bool set = argc > 0 && !JS_IsUndefined(argv[0]);
    double freq = 0.0;
    if (set && mik__to_number_arg(ctx, argv[0], "freq", &freq)) return JS_EXCEPTION;
    if (mik__pwm_ended(s, "freq()") || !set) {
        return set ? mik__result_ok_void(ctx)
                   : mik__result_ok(ctx, JS_NewFloat64(ctx, static_cast<double>(s->freq)));
    }

    JSValue invalid = mik__pwm_check_freq(ctx, freq);
    if (!JS_IsUndefined(invalid)) return invalid;

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

    return mik__result_ok_void(ctx);
}

/* A promise already resolved with `result`, which it takes. */
static JSValue mik__pwm_resolved(JSContext* ctx, JSValue result) {
    if (JS_IsException(result)) return JS_EXCEPTION;
    return MIK_NewResolvedPromise(ctx, 1, &result);
}

/* fade(targetDuty, durationMs) → Promise<Result<void, PwmError>> */
static JSValue js_pwm_fade(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    double target;
    double duration_ms;
    if (mik__to_number_arg(ctx, argv[0], "targetDuty", &target) ||
        mik__to_number_arg(ctx, argv[1], "durationMs", &duration_ms))
        return JS_EXCEPTION;
    if (mik__pwm_ended(s, "fade()")) return mik__pwm_resolved(ctx, mik__result_ok_void(ctx));

    JSValue invalid = mik__pwm_check_duty(ctx, "targetDuty", target);
    if (JS_IsUndefined(invalid) && !(duration_ms >= 0 && duration_ms <= INT32_MAX))
        invalid = mik__result_err_named(ctx, "InvalidParam", "durationMs must be 0 or more, got %g",
                                        duration_ms);
    if (JS_IsUndefined(invalid) && !s_fade_installed)
        invalid = mik__result_err_named(ctx, "FadeFailed", "fade service not installed");
    if (JS_IsUndefined(invalid) && s_fade_count >= MIK_PWM_MAX_PENDING_FADES)
        invalid = mik__result_err_named(ctx, "FadeFailed", "too many pending fades (max %d)",
                                        MIK_PWM_MAX_PENDING_FADES);
    if (!JS_IsUndefined(invalid)) return mik__pwm_resolved(ctx, invalid);

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

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
        return mik__pwm_resolved(
            ctx, mik__result_err_named(ctx, "FadeFailed", "no free fade slots available"));

    /* Waits for a fade already running on this channel to finish, so that
     * fade's callback still reaches its own slot. */
    auto ch = static_cast<ledc_channel_t>(s->channel);
    uint32_t target_raw = mik__pwm_duty_to_raw(target, s->resolution);
    esp_err_t err = ledc_set_fade_with_time(LEDC_LOW_SPEED_MODE, ch, target_raw,
                                            static_cast<int>(duration_ms));
    if (err != ESP_OK)
        return mik__pwm_resolved(ctx, mik__result_err_named(ctx, "FadeFailed",
                                                            "failed to configure fade: %s",
                                                            esp_err_to_name(err)));

    fades[slot].channel = s->channel;
    fades[slot].complete.store(false, std::memory_order_relaxed);
    JSValue promise = MIK_InitPromise(ctx, &fades[slot].promise);
    if (JS_IsException(promise)) {
        MIK_ClearPromise(ctx, &fades[slot].promise);
        return JS_EXCEPTION;
    }

    ledc_cbs_t cbs = {};
    cbs.fade_cb = mik__pwm_fade_cb;
    ledc_cb_register(LEDC_LOW_SPEED_MODE, ch, &cbs, &fades[slot]);

    err = ledc_fade_start(LEDC_LOW_SPEED_MODE, ch, LEDC_FADE_NO_WAIT);
    if (err != ESP_OK) {
        MIK_FreePromise(ctx, &fades[slot].promise);
        MIK_ClearPromise(ctx, &fades[slot].promise);
        JS_FreeValue(ctx, promise);
        return mik__pwm_resolved(ctx, mik__result_err_named(ctx, "FadeFailed",
                                                            "failed to start fade: %s",
                                                            esp_err_to_name(err)));
    }
    s_fade_count++;

    /* Update duty to target (will be accurate once fade completes) */
    s->duty = target;
    return promise;
}

/* end() — stops the output; a fade in progress resolves with ok() */
static JSValue js_pwm_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    auto* s = mik__pwm_get(ctx, this_val);
    if (!s) return JS_EXCEPTION;
    if (!s->active) return JS_UNDEFINED;

    MIKPwmFadePending* fade = mik__pwm_running_fade(MIK_GetRuntime(ctx), s->channel);
    if (fade) {
        mik__pwm_stop_fade(s->channel);
        JSValue ok = mik__result_ok_void(ctx);
        MIK_ResolvePromise(ctx, &fade->promise, 1, &ok);
        MIK_ClearPromise(ctx, &fade->promise);
        s_fade_count--;
    }
    mik__pwm_release(s);
    MIK_DropHandle(ctx, this_val);
    return JS_UNDEFINED;
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
    JS_SetModuleExport(ctx, m, "Pwm", JS_NewCFunction(ctx, js_pwm, "Pwm", 2));
    return 0;
}

static JSModuleDef* mik__pwm_init(JSContext* ctx) {
    if (mik__pwm_slot < 0) mik__pwm_slot = MIK_ReserveModuleSlot();

    JSRuntime* rt = JS_GetRuntime(ctx);

    /* Register class (once per runtime) */
    MIK_NewClassID(rt, &mik_pwm_class_id);
    JS_NewClass(rt, mik_pwm_class_id, &mik_pwm_class);

    /* Create prototype with methods */
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_pwm_proto_funcs, countof(mik_pwm_proto_funcs));
    JS_SetClassProto(ctx, mik_pwm_class_id, proto); /* consumed */

    /* Register module */
    JSModuleDef* m = JS_NewCModule(ctx, "mikro/pwm", mik__pwm_module_init);
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
        JSValue ok = mik__result_ok_void(ctx);
        MIK_ResolvePromise(ctx, &fades[i].promise, 1, &ok);
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
            /* Destroy runs before finalizers, which then find no slot to stop:
             * detach the callback now so the fade-end ISR never writes freed memory. */
            mik__pwm_stop_fade(fades[i].channel);
            MIK_FreePromise(ctx, &fades[i].promise);
            s_fade_count--;
        }
    }

    free(fades);
    mik__pwm_fades(mik_rt) = nullptr;
}

MIK__REGISTER_PUBLIC_MODULE(pwm, "mikro/pwm", mik__pwm_init, mik__pwm_consume, mik__pwm_destroy)

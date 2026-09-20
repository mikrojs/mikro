#include <atomic>
#include <cmath>
#include <cstring>
#include <vector>

#include "driver/gpio.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

/* ── mikro/gpio: DigitalOut, DigitalIn, AnalogIn ──────────────────────
 *
 * Each factory validates, claims the GPIO pin, configures it and returns
 * Result<handle>. Handles are native class instances with no exported
 * constructor. DigitalIn.onChange installs an any-edge ISR that only sets
 * a flag; the loop consumer reads the pad and emits real level changes. */

enum MIKGpioKind : uint8_t { MIK_GPIO_OUT, MIK_GPIO_IN, MIK_GPIO_ADC };

struct MIKGpioState {
    int gpio;
    MIKGpioKind kind;
    bool released;
    bool warned_after_end; /* use after end() is reported once per handle */
    adc_channel_t channel;
    adc_atten_t atten;
    /* DigitalIn events. `self` is a strong reference to the handle, held from
     * the first onChange read until end(), so subscribers keep receiving
     * events when the app drops the handle itself. */
    JSContext* ctx;
    JSValue self;
    JSValue observable;
    JSValue next_fn;
    JSValue complete_fn;
    std::atomic<bool> pending;
    int last_emitted;
    bool isr_added;
    MIKGpioState* next_live;
};

static JSClassID mik_digital_out_class_id;
static JSClassID mik_digital_in_class_id;
static JSClassID mik_analog_in_class_id;

/* DigitalIn handles with onChange live, across runtimes (entries carry ctx). */
static MIKGpioState* s_live_head = nullptr;

static const char* const s_owner_names[] = {"DigitalOut", "DigitalIn", "AnalogIn"};

/* ── ADC helpers ─────────────────────────────────────────────────── */

static adc_oneshot_unit_handle_t s_adc_handle = NULL;
static adc_cali_handle_t s_adc_cali[4] = {};  // one per attenuation level

static esp_err_t mik_adc_ensure_init() {
    if (s_adc_handle) return ESP_OK;
    adc_oneshot_unit_init_cfg_t cfg = {.unit_id = ADC_UNIT_1};
    return adc_oneshot_new_unit(&cfg, &s_adc_handle);
}

static adc_cali_handle_t mik_adc_get_cali(adc_atten_t atten) {
    int idx = (int)atten;
    if (s_adc_cali[idx]) return s_adc_cali[idx];

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cfg = {
        .unit_id = ADC_UNIT_1,
        .atten = atten,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_curve_fitting(&cfg, &s_adc_cali[idx]) != ESP_OK) return NULL;
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cfg = {
        .unit_id = ADC_UNIT_1,
        .atten = atten,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_line_fitting(&cfg, &s_adc_cali[idx]) != ESP_OK) return NULL;
#else
    return NULL;
#endif
    return s_adc_cali[idx];
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static MIKGpioState* mik__gpio_get(JSContext* ctx, JSValueConst this_val, JSClassID class_id) {
    return static_cast<MIKGpioState*>(JS_GetOpaque2(ctx, this_val, class_id));
}

/* Claims `gpio` for the handle kind, or returns the GpioInUse Result. */
static JSValue mik__gpio_claim(JSContext* ctx, int gpio, MIKGpioKind kind) {
    return mik__claim_gpios(ctx, &gpio, 1, s_owner_names[kind]);
}

/* Converts a JS value to a pin level. Returns false unless it is the number 0 or 1. */
static bool mik__gpio_to_level(JSContext* ctx, JSValueConst v, int* out) {
    double d;
    if (!JS_IsNumber(v) || JS_ToFloat64(ctx, &d, v) || (d != 0 && d != 1)) return false;
    *out = static_cast<int>(d);
    return true;
}

/* Reads options.<name> as a pin level. Returns -1 with a TypeError pending. */
static int mik__gpio_level_option(JSContext* ctx, JSValueConst options, const char* name,
                                  int* out) {
    if (JS_IsUndefined(options)) return 0;
    JSValue v = JS_GetPropertyStr(ctx, options, name);
    if (JS_IsException(v)) return -1;
    int rc = 0;
    if (!JS_IsUndefined(v) && !mik__gpio_to_level(ctx, v, out)) {
        JS_ThrowTypeError(ctx, "%s must be 0 or 1", name);
        rc = -1;
    }
    JS_FreeValue(ctx, v);
    return rc;
}

/* Reads options.<name> as one of `choices`, writing its index. Returns -1 with
 * a TypeError pending. */
static int mik__gpio_enum_option(JSContext* ctx, JSValueConst options, const char* name,
                                const char* const* choices, int count, const char* expected,
                                int* out) {
    if (JS_IsUndefined(options)) return 0;
    JSValue v = JS_GetPropertyStr(ctx, options, name);
    if (JS_IsException(v)) return -1;
    if (JS_IsUndefined(v)) return 0;
    const char* s = JS_IsString(v) ? JS_ToCString(ctx, v) : nullptr;
    JS_FreeValue(ctx, v);
    int found = -1;
    for (int i = 0; s && i < count; i++) {
        if (strcmp(s, choices[i]) == 0) found = i;
    }
    JS_FreeCString(ctx, s);
    if (found < 0) {
        JS_ThrowTypeError(ctx, "%s must be %s", name, expected);
        return -1;
    }
    *out = found;
    return 0;
}

/* Validates the (gpio, options) arguments shared by the factories. */
static int mik__gpio_args(JSContext* ctx, int argc, JSValueConst* argv, int32_t* gpio) {
    double d = 0;
    if (argc < 1 || !JS_IsNumber(argv[0]) || JS_ToFloat64(ctx, &d, argv[0]) ||
        std::trunc(d) != d || std::fabs(d) > INT32_MAX) {
        /* Reject NaN and fractions instead of truncating them to a real pin. */
        JS_ThrowTypeError(ctx, "gpio must be an integer");
        return -1;
    }
    *gpio = static_cast<int32_t>(d);
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsObject(argv[1])) {
        JS_ThrowTypeError(ctx, "options must be an object");
        return -1;
    }
    return 0;
}

static JSValue mik__gpio_new_handle(JSContext* ctx, JSClassID class_id, MIKGpioState* s) {
    JSValue obj = JS_NewObjectClass(ctx, class_id);
    if (JS_IsException(obj)) {
        MIK_ReleaseGpio(s->gpio, s_owner_names[s->kind]);
        delete s;
        return obj;
    }
    JS_SetOpaque(obj, s);
    MIK_KeepHandle(ctx, obj);
    return mik__result_ok(ctx, obj);
}

static MIKGpioState* mik__gpio_state_new(int gpio, MIKGpioKind kind) {
    auto* s = new MIKGpioState{};
    s->gpio = gpio;
    s->kind = kind;
    s->self = JS_UNDEFINED;
    s->observable = JS_UNDEFINED;
    s->next_fn = JS_UNDEFINED;
    s->complete_fn = JS_UNDEFINED;
    return s;
}

static void mik__gpio_unlink_live(MIKGpioState* s) {
    for (MIKGpioState** p = &s_live_head; *p; p = &(*p)->next_live) {
        if (*p == s) {
            *p = s->next_live;
            s->next_live = nullptr;
            return;
        }
    }
}

/* Reports use of a handle after end() once, so a loop that keeps using it
 * does not flood the console. */
static void mik__gpio_warn_after_end(MIKGpioState* s, const char* call) {
    if (!s->released || s->warned_after_end) return;
    s->warned_after_end = true;
    mik__print_error_line("GPIO %d: %s after end(); the handle no longer owns the pin", s->gpio,
                          call);
}

static void mik__gpio_remove_isr(MIKGpioState* s) {
    if (!s->isr_added) return;
    gpio_intr_disable(static_cast<gpio_num_t>(s->gpio));
    gpio_isr_handler_remove(static_cast<gpio_num_t>(s->gpio));
    s->isr_added = false;
}

static int mik__gpio_level(const MIKGpioState* s) {
    return gpio_get_level(static_cast<gpio_num_t>(s->gpio)) != 0;
}

/* ── Finalizers ──────────────────────────────────────────────────── */

static void mik__gpio_finalizer_common(JSRuntime* rt, MIKGpioState* s) {
    if (!s) return;
    /* A handle with live events holds `self`, so it only reaches here after
     * end() or from mik__gpio_destroy, both of which unlink it. */
    mik__gpio_remove_isr(s);
    if (!s->released) MIK_ReleaseGpio(s->gpio, s_owner_names[s->kind]);
    JS_FreeValueRT(rt, s->observable);
    JS_FreeValueRT(rt, s->next_fn);
    JS_FreeValueRT(rt, s->complete_fn);
    delete s;
}

static void mik__digital_out_finalizer(JSRuntime* rt, JSValue val) {
    mik__gpio_finalizer_common(
        rt, static_cast<MIKGpioState*>(JS_GetOpaque(val, mik_digital_out_class_id)));
}

static void mik__digital_in_finalizer(JSRuntime* rt, JSValue val) {
    mik__gpio_finalizer_common(
        rt, static_cast<MIKGpioState*>(JS_GetOpaque(val, mik_digital_in_class_id)));
}

static void mik__analog_in_finalizer(JSRuntime* rt, JSValue val) {
    mik__gpio_finalizer_common(
        rt, static_cast<MIKGpioState*>(JS_GetOpaque(val, mik_analog_in_class_id)));
}

static void mik__digital_in_gc_mark(JSRuntime* rt, JSValueConst val, JS_MarkFunc* mark_func) {
    auto* s = static_cast<MIKGpioState*>(JS_GetOpaque(val, mik_digital_in_class_id));
    if (!s) return;
    /* `self` is deliberately not marked: as an unmarked reference it roots the
     * handle, so cycle collection cannot free it while events are live. */
    JS_MarkValue(rt, s->observable, mark_func);
    JS_MarkValue(rt, s->next_fn, mark_func);
    JS_MarkValue(rt, s->complete_fn, mark_func);
}

static JSClassDef mik_digital_out_class = {
    .class_name = "DigitalOut",
    .finalizer = mik__digital_out_finalizer,
};
static JSClassDef mik_digital_in_class = {
    .class_name = "DigitalIn",
    .finalizer = mik__digital_in_finalizer,
    .gc_mark = mik__digital_in_gc_mark,
};
static JSClassDef mik_analog_in_class = {
    .class_name = "AnalogIn",
    .finalizer = mik__analog_in_finalizer,
};

/* ── GPIO validation ─────────────────────────────────────────────── */

JSValue mik__gpio_check(JSContext* ctx, const MIKGpioCheck* checks, int count) {
    for (int i = 0; i < count; i++) {
        int gpio = checks[i].gpio;
        if (gpio == -1) continue;
        if (!GPIO_IS_VALID_GPIO(gpio))
            return mik__result_err_named(ctx, "InvalidGpio", "GPIO %d does not exist on %s", gpio,
                                         CONFIG_IDF_TARGET);
        if (checks[i].output && !GPIO_IS_VALID_OUTPUT_GPIO(gpio))
            return mik__result_err_named(ctx, "InvalidGpio", "GPIO %d cannot be an output on %s",
                                         gpio, CONFIG_IDF_TARGET);
    }
    return JS_UNDEFINED;
}

/* ── Factories ───────────────────────────────────────────────────── */

static JSValue js_digital_out(JSContext* ctx, JSValueConst this_val, int argc,
                              JSValueConst* argv) {
    int32_t gpio;
    if (mik__gpio_args(ctx, argc, argv, &gpio)) return JS_EXCEPTION;
    JSValueConst options = argc >= 2 ? argv[1] : JS_UNDEFINED;
    int initial = 0;
    if (mik__gpio_level_option(ctx, options, "initial", &initial)) return JS_EXCEPTION;

    const MIKGpioCheck check = {gpio, true};
    JSValue invalid = mik__gpio_check(ctx, &check, 1);
    if (!JS_IsUndefined(invalid)) return invalid;
    JSValue claim_failed = mik__gpio_claim(ctx, gpio, MIK_GPIO_OUT);
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    auto num = static_cast<gpio_num_t>(gpio);
    const char* step = "gpio_reset_pin";
    esp_err_t err = gpio_reset_pin(num);
    if (err == ESP_OK) {
        /* gpio_reset_pin enables the pull-up, which wastes current while driving low. */
        step = "gpio_pullup_dis";
        err = gpio_pullup_dis(num);
    }
    if (err == ESP_OK) {
        /* Level before direction, so the pad never pulses on creation. */
        step = "gpio_set_level";
        err = gpio_set_level(num, initial);
    }
    if (err == ESP_OK) {
        step = "gpio_set_direction";
        err = gpio_set_direction(num, GPIO_MODE_OUTPUT);
    }
    if (err != ESP_OK) {
        MIK_ReleaseGpio(gpio, s_owner_names[MIK_GPIO_OUT]);
        return mik__result_err_named(ctx, "ConfigFailed", "%s failed on GPIO %d: %s", step, gpio,
                                     esp_err_to_name(err));
    }

    MIKGpioState* s = mik__gpio_state_new(gpio, MIK_GPIO_OUT);
    return mik__gpio_new_handle(ctx, mik_digital_out_class_id, s);
}

static JSValue js_digital_in(JSContext* ctx, JSValueConst this_val, int argc,
                             JSValueConst* argv) {
    int32_t gpio;
    if (mik__gpio_args(ctx, argc, argv, &gpio)) return JS_EXCEPTION;
    JSValueConst options = argc >= 2 ? argv[1] : JS_UNDEFINED;
    static const char* const pulls[] = {"none", "up", "down"};
    int pull = 0;
    if (mik__gpio_enum_option(ctx, options, "pull", pulls, 3, "'up', 'down' or 'none'", &pull))
        return JS_EXCEPTION;

    const MIKGpioCheck check = {gpio, false};
    JSValue invalid = mik__gpio_check(ctx, &check, 1);
    if (!JS_IsUndefined(invalid)) return invalid;
    /* Input-only pads have no pull resistors. Checked here because
     * gpio_set_pull_mode logs, returns ESP_OK and leaves the pad floating. */
    if (pull != 0 && !GPIO_IS_VALID_OUTPUT_GPIO(gpio))
        return mik__result_err_named(ctx, "InvalidGpio",
                                     "GPIO %d has no internal pull resistors on %s", gpio,
                                     CONFIG_IDF_TARGET);
    JSValue claim_failed = mik__gpio_claim(ctx, gpio, MIK_GPIO_IN);
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    static const gpio_pull_mode_t pull_modes[] = {GPIO_FLOATING, GPIO_PULLUP_ONLY,
                                                  GPIO_PULLDOWN_ONLY};
    auto num = static_cast<gpio_num_t>(gpio);
    const char* step = "gpio_reset_pin";
    esp_err_t err = gpio_reset_pin(num);
    if (err == ESP_OK) {
        step = "gpio_set_direction";
        err = gpio_set_direction(num, GPIO_MODE_INPUT);
    }
    if (err == ESP_OK) {
        step = "gpio_set_pull_mode";
        err = gpio_set_pull_mode(num, pull_modes[pull]);
    }
    if (err == ESP_OK) {
        /* Installed here rather than on the first onChange read, so the one
         * failure a getter could not report as a Result surfaces now. */
        step = "gpio_install_isr_service";
        /* IRAM, so edges still register while flash writes disable the cache. */
        err = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
        if (err == ESP_ERR_INVALID_STATE) err = ESP_OK;  // already installed
    }
    if (err != ESP_OK) {
        MIK_ReleaseGpio(gpio, s_owner_names[MIK_GPIO_IN]);
        return mik__result_err_named(ctx, "ConfigFailed", "%s failed on GPIO %d: %s", step, gpio,
                                     esp_err_to_name(err));
    }

    MIKGpioState* s = mik__gpio_state_new(gpio, MIK_GPIO_IN);
    return mik__gpio_new_handle(ctx, mik_digital_in_class_id, s);
}

static JSValue js_analog_in(JSContext* ctx, JSValueConst this_val, int argc,
                            JSValueConst* argv) {
    int32_t gpio;
    if (mik__gpio_args(ctx, argc, argv, &gpio)) return JS_EXCEPTION;
    JSValueConst options = argc >= 2 ? argv[1] : JS_UNDEFINED;
    static const char* const attens[] = {"0db", "2.5db", "6db", "11db"};
    static const adc_atten_t atten_values[] = {ADC_ATTEN_DB_0, ADC_ATTEN_DB_2_5, ADC_ATTEN_DB_6,
                                               ADC_ATTEN_DB_12};
    int atten = 3;
    if (mik__gpio_enum_option(ctx, options, "attenuation", attens, 4,
                             "'0db', '2.5db', '6db' or '11db'", &atten))
        return JS_EXCEPTION;

    adc_unit_t unit;
    adc_channel_t channel;
    if (adc_oneshot_io_to_channel(gpio, &unit, &channel) != ESP_OK || unit != ADC_UNIT_1)
        return mik__result_err_named(ctx, "InvalidGpio", "GPIO %d is not an ADC1 input on %s",
                                     gpio, CONFIG_IDF_TARGET);
    JSValue claim_failed = mik__gpio_claim(ctx, gpio, MIK_GPIO_ADC);
    if (!JS_IsUndefined(claim_failed)) return claim_failed;

    const char* step = "adc_oneshot_new_unit";
    esp_err_t err = mik_adc_ensure_init();
    if (err == ESP_OK) {
        step = "adc_oneshot_config_channel";
        adc_oneshot_chan_cfg_t chan_cfg = {
            .atten = atten_values[atten],
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        err = adc_oneshot_config_channel(s_adc_handle, channel, &chan_cfg);
    }
    if (err != ESP_OK) {
        MIK_ReleaseGpio(gpio, s_owner_names[MIK_GPIO_ADC]);
        return mik__result_err_named(ctx, "ConfigFailed", "%s failed on GPIO %d: %s", step, gpio,
                                     esp_err_to_name(err));
    }

    MIKGpioState* s = mik__gpio_state_new(gpio, MIK_GPIO_ADC);
    s->channel = channel;
    s->atten = atten_values[atten];
    return mik__gpio_new_handle(ctx, mik_analog_in_class_id, s);
}

/* ── Shared methods ──────────────────────────────────────────────── */

static JSValue js_gpio_get_gpio(JSContext* ctx, JSValueConst this_val, int magic) {
    JSClassID ids[] = {mik_digital_out_class_id, mik_digital_in_class_id,
                       mik_analog_in_class_id};
    MIKGpioState* s = mik__gpio_get(ctx, this_val, ids[magic]);
    if (!s) return JS_EXCEPTION;
    return JS_NewInt32(ctx, s->gpio);
}

static JSValue js_gpio_end(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                          int magic) {
    JSClassID ids[] = {mik_digital_out_class_id, mik_digital_in_class_id,
                       mik_analog_in_class_id};
    MIKGpioState* s = mik__gpio_get(ctx, this_val, ids[magic]);
    if (!s) return JS_EXCEPTION;
    if (s->released) return JS_UNDEFINED;
    s->released = true;
    mik__gpio_remove_isr(s);
    mik__gpio_unlink_live(s);
    MIK_ReleaseGpio(s->gpio, s_owner_names[s->kind]);
    MIK_DropHandle(ctx, this_val);

    /* Complete before dropping `self`: subscribers' teardowns may still use
     * the handle, and `self` may be the last reference to it. */
    JSValue self = s->self;
    s->self = JS_UNDEFINED;
    JSValue ret = JS_UNDEFINED;
    if (!JS_IsUndefined(s->complete_fn)) {
        ret = JS_Call(ctx, s->complete_fn, JS_UNDEFINED, 0, nullptr);
    }
    JS_FreeValue(ctx, self);
    /* A subscriber's exception panics inside the multicast, so only an
     * out-of-memory error reaches here; return it to the caller. */
    if (JS_IsException(ret)) return JS_EXCEPTION;
    JS_FreeValue(ctx, ret);
    return JS_UNDEFINED;
}

/* ── DigitalOut ──────────────────────────────────────────────────── */

static JSValue js_digital_out_write(JSContext* ctx, JSValueConst this_val, int argc,
                                    JSValueConst* argv) {
    MIKGpioState* s = mik__gpio_get(ctx, this_val, mik_digital_out_class_id);
    if (!s) return JS_EXCEPTION;
    int level;
    if (argc < 1 || !mik__gpio_to_level(ctx, argv[0], &level))
        return JS_ThrowTypeError(ctx, "level must be 0 or 1");
    /* After end() the pin may belong to another owner, so a write does nothing.
     * gpio_set_level only fails for an invalid number, which the factory rejected. */
    mik__gpio_warn_after_end(s, "write() ignored");
    if (!s->released) gpio_set_level(static_cast<gpio_num_t>(s->gpio), level);
    return JS_UNDEFINED;
}

/* ── DigitalIn ───────────────────────────────────────────────────── */

static IRAM_ATTR void mik__gpio_isr(void* arg) {
    static_cast<MIKGpioState*>(arg)->pending.store(true, std::memory_order_relaxed);
}

static JSValue js_digital_in_read(JSContext* ctx, JSValueConst this_val, int argc,
                                  JSValueConst* argv) {
    MIKGpioState* s = mik__gpio_get(ctx, this_val, mik_digital_in_class_id);
    if (!s) return JS_EXCEPTION;
    /* Reading changes nothing, so it still reports the pad after end(). */
    mik__gpio_warn_after_end(s, "read()");
    return JS_NewInt32(ctx, mik__gpio_level(s));
}

static JSValue js_digital_in_get_on_change(JSContext* ctx, JSValueConst this_val) {
    MIKGpioState* s = mik__gpio_get(ctx, this_val, mik_digital_in_class_id);
    if (!s) return JS_EXCEPTION;
    if (!JS_IsUndefined(s->observable)) return JS_DupValue(ctx, s->observable);

    if (mik__observable_multicast_new(ctx, &s->observable, &s->next_fn, &s->complete_fn) < 0)
        return JS_EXCEPTION;

    if (s->released) {
        /* Subscribers to a released GPIO pin complete at once. */
        JSValue ret = JS_Call(ctx, s->complete_fn, JS_UNDEFINED, 0, nullptr);
        if (JS_IsException(ret)) return JS_EXCEPTION;
        JS_FreeValue(ctx, ret);
        return JS_DupValue(ctx, s->observable);
    }

    auto num = static_cast<gpio_num_t>(s->gpio);
    s->last_emitted = mik__gpio_level(s);
    esp_err_t err = gpio_set_intr_type(num, GPIO_INTR_ANYEDGE);
    if (err == ESP_OK) err = gpio_isr_handler_add(num, mik__gpio_isr, s);
    if (err != ESP_OK) {
        /* Drop the stream so a later read retries instead of caching a silent one. */
        JS_FreeValue(ctx, s->observable);
        JS_FreeValue(ctx, s->next_fn);
        JS_FreeValue(ctx, s->complete_fn);
        s->observable = s->next_fn = s->complete_fn = JS_UNDEFINED;
        return JS_ThrowInternalError(ctx, "gpio_isr_handler_add failed on GPIO %d: %s", s->gpio,
                                     esp_err_to_name(err));
    }
    s->isr_added = true;
    s->ctx = ctx;
    s->self = JS_DupValue(ctx, this_val);
    s->next_live = s_live_head;
    s_live_head = s;
    return JS_DupValue(ctx, s->observable);
}

/* ── AnalogIn ────────────────────────────────────────────────────── */

static JSValue mik__analog_read_raw(JSContext* ctx, MIKGpioState* s, int* raw) {
    esp_err_t err = adc_oneshot_read(s_adc_handle, s->channel, raw);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ReadFailed", "adc_oneshot_read failed on GPIO %d: %s",
                                     s->gpio, esp_err_to_name(err));
    return JS_UNDEFINED;
}

static JSValue js_analog_in_read(JSContext* ctx, JSValueConst this_val, int argc,
                                 JSValueConst* argv) {
    MIKGpioState* s = mik__gpio_get(ctx, this_val, mik_analog_in_class_id);
    if (!s) return JS_EXCEPTION;
    /* Like a digital read, this still reads the pin after end(). */
    mik__gpio_warn_after_end(s, "read()");
    int raw = 0;
    JSValue failed = mik__analog_read_raw(ctx, s, &raw);
    if (!JS_IsUndefined(failed)) return failed;
    return mik__result_ok(ctx, JS_NewInt32(ctx, raw));
}

static JSValue js_analog_in_read_millivolts(JSContext* ctx, JSValueConst this_val, int argc,
                                            JSValueConst* argv) {
    MIKGpioState* s = mik__gpio_get(ctx, this_val, mik_analog_in_class_id);
    if (!s) return JS_EXCEPTION;
    mik__gpio_warn_after_end(s, "readMillivolts()");
    adc_cali_handle_t cali = mik_adc_get_cali(s->atten);
    if (!cali) return mik__result_err_tag(ctx, "CalibrationUnavailable");
    int raw = 0;
    JSValue failed = mik__analog_read_raw(ctx, s, &raw);
    if (!JS_IsUndefined(failed)) return failed;
    int mv = 0;
    esp_err_t err = adc_cali_raw_to_voltage(cali, raw, &mv);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "ReadFailed",
                                     "adc_cali_raw_to_voltage failed on GPIO %d: %s", s->gpio,
                                     esp_err_to_name(err));
    return mik__result_ok(ctx, JS_NewInt32(ctx, mv));
}

/* ── Prototypes ──────────────────────────────────────────────────── */

#define MIK__GPIO_COMMON(kind)                                                     \
    JS_CGETSET_MAGIC_DEF("gpio", js_gpio_get_gpio, nullptr, kind),                   \
    MIK_CFUNC_MAGIC_DEF("end", 0, js_gpio_end, kind)

static const JSCFunctionListEntry mik_digital_out_proto_funcs[] = {
    MIK__GPIO_COMMON(MIK_GPIO_OUT),
    MIK_CFUNC_DEF("write", 1, js_digital_out_write),
};

static const JSCFunctionListEntry mik_digital_in_proto_funcs[] = {
    MIK__GPIO_COMMON(MIK_GPIO_IN),
    MIK_CFUNC_DEF("read", 0, js_digital_in_read),
    JS_CGETSET_DEF("onChange", js_digital_in_get_on_change, nullptr),
};

static const JSCFunctionListEntry mik_analog_in_proto_funcs[] = {
    MIK__GPIO_COMMON(MIK_GPIO_ADC),
    MIK_CFUNC_DEF("read", 0, js_analog_in_read),
    MIK_CFUNC_DEF("readMillivolts", 0, js_analog_in_read_millivolts),
};

/* ── Module ──────────────────────────────────────────────────────── */

static void mik__gpio_class_init(JSContext* ctx, JSClassID* id, const JSClassDef* def,
                                const JSCFunctionListEntry* funcs, int count) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    MIK_NewClassID(rt, id);
    JS_NewClass(rt, *id, def);
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, funcs, count);
    JS_SetClassProto(ctx, *id, proto);
}

static int mik__gpio_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "DigitalOut",
                       JS_NewCFunction(ctx, js_digital_out, "DigitalOut", 2));
    JS_SetModuleExport(ctx, m, "DigitalIn", JS_NewCFunction(ctx, js_digital_in, "DigitalIn", 2));
    JS_SetModuleExport(ctx, m, "AnalogIn", JS_NewCFunction(ctx, js_analog_in, "AnalogIn", 2));
    return 0;
}

static JSModuleDef* mik__gpio_init(JSContext* ctx) {
    mik__gpio_class_init(ctx, &mik_digital_out_class_id, &mik_digital_out_class,
                        mik_digital_out_proto_funcs, countof(mik_digital_out_proto_funcs));
    mik__gpio_class_init(ctx, &mik_digital_in_class_id, &mik_digital_in_class,
                        mik_digital_in_proto_funcs, countof(mik_digital_in_proto_funcs));
    mik__gpio_class_init(ctx, &mik_analog_in_class_id, &mik_analog_in_class,
                        mik_analog_in_proto_funcs, countof(mik_analog_in_proto_funcs));

    JSModuleDef* m = JS_NewCModule(ctx, "mikro/gpio", mik__gpio_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "DigitalOut");
    JS_AddModuleExport(ctx, m, "DigitalIn");
    JS_AddModuleExport(ctx, m, "AnalogIn");
    return m;
}

/* ── Event loop: edge delivery ───────────────────────────────────── */

static void mik__gpio_consume(JSContext* ctx) {
    bool any = false;
    for (MIKGpioState* s = s_live_head; s; s = s->next_live) {
        if (s->ctx == ctx && s->pending.load(std::memory_order_relaxed)) any = true;
    }
    if (!any) return;

    /* Emitting runs JS that may end() any handle, so walk a snapshot. */
    std::vector<JSValue> handles;
    for (MIKGpioState* s = s_live_head; s; s = s->next_live) {
        if (s->ctx == ctx) handles.push_back(JS_DupValue(ctx, s->self));
    }
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    for (JSValue h : handles) {
        auto* s = static_cast<MIKGpioState*>(JS_GetOpaque(h, mik_digital_in_class_id));
        /* Once a stop is requested, deliver nothing more; still drop every reference. */
        if (!(mik_rt && MIK_IsStopRequested(mik_rt)) && !s->released &&
            s->pending.exchange(false, std::memory_order_relaxed)) {
            int level = mik__gpio_level(s);
            if (level != s->last_emitted) {
                s->last_emitted = level;
                JSValue arg = JS_NewInt32(ctx, level);
                JSValue ret = JS_Call(ctx, s->next_fn, JS_UNDEFINED, 1, &arg);
                if (JS_IsException(ret)) {
                    /* Same path as a failed timer callback in mik__timers_consume. */
                    if (mik_rt && mik_rt->error_handler_fn && JS_HasException(ctx)) {
                        JSValue exc = JS_GetException(ctx);
                        mik_rt->error_handler_fn(ctx, exc, mik_rt->error_handler_opaque);
                        JS_Throw(ctx, exc);
                    }
                    mik_dump_error(ctx);
                    if (mik_rt) MIK_Stop(mik_rt);
                }
                JS_FreeValue(ctx, ret);
            }
        }
        JS_FreeValue(ctx, h);
    }
}

/* ── Light-sleep GPIO wake ───────────────────────────────────────── */

void mik__gpio_wake_prepare(int gpio) {
    gpio_intr_disable(static_cast<gpio_num_t>(gpio));
}

void mik__gpio_wake_done(int gpio) {
    auto num = static_cast<gpio_num_t>(gpio);
    gpio_wakeup_disable(num);
    for (MIKGpioState* s = s_live_head; s; s = s->next_live) {
        if (s->gpio != gpio || !s->isr_added) continue;
        gpio_set_intr_type(num, GPIO_INTR_ANYEDGE);
        /* The level may have changed while edges were off; let the consumer compare. */
        s->pending.store(true, std::memory_order_relaxed);
        /* Re-adding re-enables the interrupt on the service's core. */
        gpio_isr_handler_add(num, mik__gpio_isr, s);
        return;
    }
    gpio_set_intr_type(num, GPIO_INTR_DISABLE);
}

/* Runtime teardown: drop the `self` references so the handles can be
 * finalized (which releases their GPIO pins). */
static void mik__gpio_destroy(JSContext* ctx) {
    for (MIKGpioState** p = &s_live_head; *p;) {
        MIKGpioState* s = *p;
        if (s->ctx != ctx) {
            p = &s->next_live;
            continue;
        }
        *p = s->next_live;
        s->next_live = nullptr;
        mik__gpio_remove_isr(s);
        JSValue self = s->self;
        s->self = JS_UNDEFINED;
        JS_FreeValue(ctx, self);
    }
}

MIK__REGISTER_PUBLIC_MODULE(gpio, "mikro/gpio", mik__gpio_init, mik__gpio_consume,
                            mik__gpio_destroy)

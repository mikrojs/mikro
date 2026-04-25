#include "driver/gpio.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/* ── GPIO helpers ────────────────────────────────────────────────── */

static esp_err_t mik_gpio_reset_pin(const int pin) {
    return gpio_reset_pin(static_cast<gpio_num_t>(pin));
}

static esp_err_t mik_gpio_set_pin_mode(const int pin, const gpio_mode_t mode) {
    return gpio_set_direction(static_cast<gpio_num_t>(pin), mode);
}

static esp_err_t mik_gpio_digital_write(const int pin, const int value) {
    return gpio_set_level(static_cast<gpio_num_t>(pin), value);
}

static int mik_gpio_digital_read(const int pin) {
    return gpio_get_level(static_cast<gpio_num_t>(pin));
}

/* ── ADC helpers ─────────────────────────────────────────────────── */

static adc_oneshot_unit_handle_t s_adc_handle = NULL;
static adc_cali_handle_t s_adc_cali[4] = {};  // one per attenuation level

static esp_err_t mik_adc_ensure_init() {
    if (s_adc_handle) return ESP_OK;
    adc_oneshot_unit_init_cfg_t cfg = {.unit_id = ADC_UNIT_1};
    return adc_oneshot_new_unit(&cfg, &s_adc_handle);
}

static adc_channel_t mik_adc_pin_to_channel(int pin) {
    adc_channel_t channel;
    adc_unit_t unit;
    esp_err_t err = adc_oneshot_io_to_channel(pin, &unit, &channel);
    if (err != ESP_OK || unit != ADC_UNIT_1) return (adc_channel_t)-1;
    return channel;
}

static int mik_adc_read_raw(int pin, adc_atten_t atten) {
    adc_channel_t ch = mik_adc_pin_to_channel(pin);
    if (ch == (adc_channel_t)-1) return -1;

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = atten,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_oneshot_config_channel(s_adc_handle, ch, &chan_cfg) != ESP_OK) return -1;

    int raw = 0;
    if (adc_oneshot_read(s_adc_handle, ch, &raw) != ESP_OK) return -1;
    return raw;
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

static int mik_adc_read_millivolts(int pin, adc_atten_t atten) {
    int raw = mik_adc_read_raw(pin, atten);
    if (raw < 0) return -1;

    adc_cali_handle_t cali = mik_adc_get_cali(atten);
    if (!cali) return -1;

    int mv = 0;
    if (adc_cali_raw_to_voltage(cali, raw, &mv) != ESP_OK) return -1;
    return mv;
}

/* ── native:pin JS module ────────────────────────────────────────────── */

static JSValue mik__pin_mode(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t pin, mode;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &mode, argv[1])) return JS_EXCEPTION;

    esp_err_t err = mik_gpio_reset_pin(pin);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "InvalidPin", "failed to reset pin %d: %s", pin,
                                     esp_err_to_name(err));

    err = mik_gpio_set_pin_mode(pin, static_cast<gpio_mode_t>(mode));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "SetModeFailed",
                                     "failed to set mode on pin %d: %s", pin,
                                     esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

static JSValue mik__pin_digital_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t pin, value;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &value, argv[1])) return JS_EXCEPTION;

    esp_err_t err = mik_gpio_digital_write(pin, value);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WriteFailed", "failed to write to pin %d: %s", pin,
                                     esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

static JSValue mik__pin_digital_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t pin;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    return JS_NewInt32(ctx, mik_gpio_digital_read(pin));
}

static JSValue mik__pin_analog_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int32_t pin, atten;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &atten, argv[1])) return JS_EXCEPTION;

    esp_err_t err = mik_adc_ensure_init();
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "AdcInitFailed",
                                     "failed to initialize ADC unit: %s", esp_err_to_name(err));

    int raw = mik_adc_read_raw(pin, static_cast<adc_atten_t>(atten));
    if (raw < 0) return mik__result_err_tag(ctx, "InvalidAdcPin");

    return mik__result_ok(ctx, JS_NewInt32(ctx, raw));
}

static JSValue mik__pin_analog_read_millivolts(JSContext* ctx, JSValue this_val, int argc,
                                               JSValue* argv) {
    int32_t pin, atten;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &atten, argv[1])) return JS_EXCEPTION;

    esp_err_t err = mik_adc_ensure_init();
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "AdcInitFailed",
                                     "failed to initialize ADC unit: %s", esp_err_to_name(err));

    int mv = mik_adc_read_millivolts(pin, static_cast<adc_atten_t>(atten));
    if (mv < 0) return mik__result_err_tag(ctx, "InvalidAdcPin");

    return mik__result_ok(ctx, JS_NewInt32(ctx, mv));
}

static int mik__pin_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "pinMode",
                       JS_NewCFunction(ctx, mik__pin_mode, "pinMode", 2));
    JS_SetModuleExport(ctx, m, "digitalWrite",
                       JS_NewCFunction(ctx, mik__pin_digital_write, "digitalWrite", 2));
    JS_SetModuleExport(ctx, m, "digitalRead",
                       JS_NewCFunction(ctx, mik__pin_digital_read, "digitalRead", 1));
    JS_SetModuleExport(ctx, m, "analogRead",
                       JS_NewCFunction(ctx, mik__pin_analog_read, "analogRead", 2));
    JS_SetModuleExport(ctx, m, "analogReadMillivolts",
                       JS_NewCFunction(ctx, mik__pin_analog_read_millivolts,
                                       "analogReadMillivolts", 2));
    return 0;
}

static JSModuleDef* mik__pin_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:pin", mik__pin_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "pinMode");
    JS_AddModuleExport(ctx, m, "digitalWrite");
    JS_AddModuleExport(ctx, m, "digitalRead");
    JS_AddModuleExport(ctx, m, "analogRead");
    JS_AddModuleExport(ctx, m, "analogReadMillivolts");
    return m;
}

MIK_REGISTER_MODULE(pin, "native:pin", mik__pin_init, nullptr, nullptr)

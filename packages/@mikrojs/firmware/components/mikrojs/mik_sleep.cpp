#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "soc/soc_caps.h"

#include "mikrojs/private.h"
#include "mikrojs/utils.h"
#include "mikrojs_esp32.h"

/* For deep-sleep wakeup, the chip's digital pad config (set by `pinMode`)
 * doesn't persist — only the RTC-IO pad does. Without an explicit RTC
 * pull, EXT0/EXT1 pins float and trigger spurious wakes. Configure the
 * RTC pull to the opposite of the wake direction so the pin idles in
 * the non-trigger state and a button press flips it. */
static void mik__rtc_pull_for_wake(int pin, bool wake_on_high) {
#if SOC_RTCIO_INPUT_OUTPUT_SUPPORTED
    if (!rtc_gpio_is_valid_gpio(static_cast<gpio_num_t>(pin))) return;
    gpio_num_t g = static_cast<gpio_num_t>(pin);
    rtc_gpio_pullup_dis(g);
    rtc_gpio_pulldown_dis(g);
    if (wake_on_high) {
        rtc_gpio_pulldown_en(g);
    } else {
        rtc_gpio_pullup_en(g);
    }
#else
    (void)pin;
    (void)wake_on_high;
#endif
}

static const char* mik__wakeup_cause_str(uint32_t causes) {
    if (causes & BIT(ESP_SLEEP_WAKEUP_TIMER)) return "timer";
    if (causes & BIT(ESP_SLEEP_WAKEUP_EXT0)) return "ext0";
    if (causes & BIT(ESP_SLEEP_WAKEUP_EXT1)) return "ext1";
    if (causes & BIT(ESP_SLEEP_WAKEUP_GPIO)) return "gpio";
    if (causes & BIT(ESP_SLEEP_WAKEUP_TOUCHPAD)) return "touchpad";
    if (causes & BIT(ESP_SLEEP_WAKEUP_ULP)) return "ulp";
    return "undefined";
}

/* ── Wakeup source configuration ───────────────────────────────────── */

static bool mik__configure_timer(JSContext* ctx, JSValue sources) {
    JSValue v = JS_GetPropertyStr(ctx, sources, "timer");
    bool ok = true;
    if (!JS_IsUndefined(v)) {
        double ms;
        if (JS_ToFloat64(ctx, &ms, v)) {
            ok = false;
        } else if (ms < 0) {
            JS_ThrowRangeError(ctx, "timer must be >= 0");
            ok = false;
        } else {
            uint64_t us = static_cast<uint64_t>(ms * 1000.0);
            esp_err_t err = esp_sleep_enable_timer_wakeup(us);
            if (err != ESP_OK) {
                JS_ThrowInternalError(ctx, "timer wakeup failed: %s", esp_err_to_name(err));
                ok = false;
            }
        }
    }
    JS_FreeValue(ctx, v);
    return ok;
}

static bool mik__read_level(JSContext* ctx, JSValue obj, const char* key, int* out_level) {
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    const char* s = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!s) return false;
    bool ok = true;
    if (strcmp(s, "high") == 0)
        *out_level = 1;
    else if (strcmp(s, "low") == 0)
        *out_level = 0;
    else {
        JS_ThrowRangeError(ctx, "%s must be 'high' or 'low'", key);
        ok = false;
    }
    JS_FreeCString(ctx, s);
    return ok;
}

static bool mik__configure_gpio(JSContext* ctx, JSValue sources) {
    JSValue gpio = JS_GetPropertyStr(ctx, sources, "gpio");
    if (JS_IsUndefined(gpio)) {
        JS_FreeValue(ctx, gpio);
        return true;
    }

    JSValue pin_val = JS_GetPropertyStr(ctx, gpio, "pin");
    int32_t pin;
    bool ok = !JS_ToInt32(ctx, &pin, pin_val);
    JS_FreeValue(ctx, pin_val);

    int level = 0;
    if (ok) ok = mik__read_level(ctx, gpio, "level", &level);
    JS_FreeValue(ctx, gpio);
    if (!ok) return false;

    gpio_int_type_t intr = (level == 1) ? GPIO_INTR_HIGH_LEVEL : GPIO_INTR_LOW_LEVEL;
    esp_err_t err = gpio_wakeup_enable(static_cast<gpio_num_t>(pin), intr);
    if (err != ESP_OK) {
        JS_ThrowInternalError(ctx, "GPIO wakeup on pin %d failed: %s", pin, esp_err_to_name(err));
        return false;
    }
    err = esp_sleep_enable_gpio_wakeup();
    if (err != ESP_OK) {
        JS_ThrowInternalError(ctx, "GPIO wakeup source failed: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}

static bool mik__configure_ext0(JSContext* ctx, JSValue sources) {
    JSValue ext0 = JS_GetPropertyStr(ctx, sources, "ext0");
    if (JS_IsUndefined(ext0)) {
        JS_FreeValue(ctx, ext0);
        return true;
    }
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    JSValue pin_val = JS_GetPropertyStr(ctx, ext0, "pin");
    int32_t pin;
    bool ok = !JS_ToInt32(ctx, &pin, pin_val);
    JS_FreeValue(ctx, pin_val);

    int level = 0;
    if (ok) ok = mik__read_level(ctx, ext0, "level", &level);
    JS_FreeValue(ctx, ext0);
    if (!ok) return false;

    mik__rtc_pull_for_wake(pin, level == 1);
    esp_err_t err = esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(pin), level);
    if (err != ESP_OK) {
        JS_ThrowInternalError(ctx, "EXT0 wakeup on pin %d failed: %s", pin, esp_err_to_name(err));
        return false;
    }
    return true;
#else
    JS_FreeValue(ctx, ext0);
    JS_ThrowInternalError(ctx, "EXT0 wakeup is not supported on this chip");
    return false;
#endif
}

static bool mik__configure_ext1(JSContext* ctx, JSValue sources) {
    JSValue ext1 = JS_GetPropertyStr(ctx, sources, "ext1");
    if (JS_IsUndefined(ext1)) {
        JS_FreeValue(ctx, ext1);
        return true;
    }
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    JSValue pins_val = JS_GetPropertyStr(ctx, ext1, "pins");
    JSValue len_val = JS_GetPropertyStr(ctx, pins_val, "length");
    uint32_t pin_count;
    bool ok = !JS_ToUint32(ctx, &pin_count, len_val);
    JS_FreeValue(ctx, len_val);

    uint64_t pin_mask = 0;
    for (uint32_t i = 0; ok && i < pin_count; i++) {
        JSValue pin_val = JS_GetPropertyUint32(ctx, pins_val, i);
        int32_t pin;
        if (JS_ToInt32(ctx, &pin, pin_val))
            ok = false;
        else
            pin_mask |= (1ULL << pin);
        JS_FreeValue(ctx, pin_val);
    }
    JS_FreeValue(ctx, pins_val);

    int mode_value = 0;
    if (ok) {
        JSValue mode_val = JS_GetPropertyStr(ctx, ext1, "mode");
        const char* mode_str = JS_ToCString(ctx, mode_val);
        JS_FreeValue(ctx, mode_val);
        if (!mode_str) {
            ok = false;
        } else {
            if (strcmp(mode_str, "any-low") == 0) {
                // ESP32's EXT1 only ships ALL_LOW (wake when every selected pin
                // is low); newer chips ship ANY_LOW. The two are equivalent for
                // a single-pin mask, so we accept that case on ESP32 and route
                // it through ALL_LOW. Multi-pin "any-low" can't be honored on
                // ESP32 — the hardware always requires every pin to be low —
                // so we reject it loudly rather than silently changing the
                // wake condition.
#if CONFIG_IDF_TARGET_ESP32
                if (pin_count > 1) {
                    JS_ThrowTypeError(
                        ctx,
                        "'any-low' with multiple pins is not supported on ESP32: "
                        "hardware can only wake when all selected pins are low. "
                        "Use one pin per ext1 source, or use 'any-high' mode.");
                    ok = false;
                } else {
                    mode_value = ESP_EXT1_WAKEUP_ALL_LOW;
                }
#else
                mode_value = ESP_EXT1_WAKEUP_ANY_LOW;
#endif
            } else if (strcmp(mode_str, "any-high") == 0) {
                mode_value = ESP_EXT1_WAKEUP_ANY_HIGH;
            } else {
                JS_ThrowRangeError(ctx, "ext1.mode must be 'any-low' or 'any-high'");
                ok = false;
            }
            JS_FreeCString(ctx, mode_str);
        }
    }
    JS_FreeValue(ctx, ext1);
    if (!ok) return false;

    const bool wake_on_high = mode_value == ESP_EXT1_WAKEUP_ANY_HIGH;
    for (int pin = 0; pin < 64; pin++) {
        if (pin_mask & (1ULL << pin)) {
            mik__rtc_pull_for_wake(pin, wake_on_high);
        }
    }
    esp_err_t err = esp_sleep_enable_ext1_wakeup(
        pin_mask, static_cast<esp_sleep_ext1_wakeup_mode_t>(mode_value));
    if (err != ESP_OK) {
        JS_ThrowInternalError(ctx, "EXT1 wakeup failed: %s", esp_err_to_name(err));
        return false;
    }
    return true;
#else
    JS_FreeValue(ctx, ext1);
    JS_ThrowInternalError(ctx, "EXT1 wakeup is not supported on this chip");
    return false;
#endif
}

/* Clears any previously-configured sources, then applies the ones in
 * `sources`. Throws and returns false on any error. */
static bool mik__configure_wakeup_sources(JSContext* ctx, JSValue sources) {
    if (!JS_IsObject(sources)) {
        JS_ThrowTypeError(ctx, "wakeup sources must be an object");
        return false;
    }
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
    if (!mik__configure_timer(ctx, sources)) return false;
    if (!mik__configure_gpio(ctx, sources)) return false;
    if (!mik__configure_ext0(ctx, sources)) return false;
    if (!mik__configure_ext1(ctx, sources)) return false;
    return true;
}

/* ── native:sleep JS module ─────────────────────────────────────────── */

static JSValue mik__sleep_deep(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!mik__configure_wakeup_sources(ctx, argv[0])) return JS_EXCEPTION;

    /* Note: we intentionally do NOT call MIK_FreeRuntime() here.  We are inside
     * a JS function call, so the runtime still has live GC objects on the call
     * stack — freeing it would trigger a QuickJS assert.  Since deep sleep
     * reboots the chip, all memory is reclaimed anyway. */
    esp_deep_sleep_start();
    /* Never reached */
    __builtin_unreachable();
}

static JSValue mik__sleep_light(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (!mik__configure_wakeup_sources(ctx, argv[0])) return JS_EXCEPTION;

    /* Tear down USB before sleeping so the host sees a clean unplug,
     * not a silent enumerated-but-asleep device. This lets `mikro dev`
     * trigger its existing reconnect path. Restored after wake. */
    mik__serial_io_detach_usb();
    esp_err_t err = esp_light_sleep_start();
    mik__serial_io_attach_usb();

    if (err != ESP_OK)
        return JS_ThrowInternalError(ctx, "light sleep failed: %s", esp_err_to_name(err));

    return JS_UNDEFINED;
}

static JSValue mik__sleep_get_wakeup_cause(JSContext* ctx, JSValue this_val, int argc,
                                            JSValue* argv) {
    uint32_t causes = esp_sleep_get_wakeup_causes();
    return JS_NewString(ctx, mik__wakeup_cause_str(causes));
}

static JSValue mik__sleep_can_wake_from_ext0(JSContext* ctx, JSValue this_val, int argc,
                                              JSValue* argv) {
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    return JS_TRUE;
#else
    return JS_FALSE;
#endif
}

static JSValue mik__sleep_can_wake_from_ext1(JSContext* ctx, JSValue this_val, int argc,
                                              JSValue* argv) {
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    return JS_TRUE;
#else
    return JS_FALSE;
#endif
}

/* ── Module init ─────────────────────────────────────────────────── */

static int mik__sleep_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "deepSleep",
                       JS_NewCFunction(ctx, mik__sleep_deep, "deepSleep", 1));
    JS_SetModuleExport(ctx, m, "lightSleep",
                       JS_NewCFunction(ctx, mik__sleep_light, "lightSleep", 1));
    JS_SetModuleExport(ctx, m, "getWakeupCause",
                       JS_NewCFunction(ctx, mik__sleep_get_wakeup_cause, "getWakeupCause", 0));
    JS_SetModuleExport(
        ctx, m, "canWakeFromExt0",
        JS_NewCFunction(ctx, mik__sleep_can_wake_from_ext0, "canWakeFromExt0", 0));
    JS_SetModuleExport(
        ctx, m, "canWakeFromExt1",
        JS_NewCFunction(ctx, mik__sleep_can_wake_from_ext1, "canWakeFromExt1", 0));
    return 0;
}

static JSModuleDef* mik__sleep_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:sleep", mik__sleep_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "deepSleep");
    JS_AddModuleExport(ctx, m, "lightSleep");
    JS_AddModuleExport(ctx, m, "getWakeupCause");
    JS_AddModuleExport(ctx, m, "canWakeFromExt0");
    JS_AddModuleExport(ctx, m, "canWakeFromExt1");
    return m;
}

MIK_REGISTER_MODULE(sleep, "native:sleep", mik__sleep_init, nullptr, nullptr)

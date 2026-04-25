#include "driver/gpio.h"
#include "esp_sleep.h"
#include "soc/soc_caps.h"

#include "mikrojs/private.h"
#include "mikrojs/utils.h"

static const char* mik__wakeup_cause_str(uint32_t causes) {
    if (causes & BIT(ESP_SLEEP_WAKEUP_TIMER)) return "timer";
    if (causes & BIT(ESP_SLEEP_WAKEUP_EXT0)) return "ext0";
    if (causes & BIT(ESP_SLEEP_WAKEUP_EXT1)) return "ext1";
    if (causes & BIT(ESP_SLEEP_WAKEUP_GPIO)) return "gpio";
    if (causes & BIT(ESP_SLEEP_WAKEUP_TOUCHPAD)) return "touchpad";
    if (causes & BIT(ESP_SLEEP_WAKEUP_ULP)) return "ulp";
    return "undefined";
}

/* ── native:sleep JS module ─────────────────────────────────────────── */

static JSValue mik__sleep_deep(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int64_t ms;
    if (JS_ToInt64(ctx, &ms, argv[0])) return JS_EXCEPTION;

    if (ms > 0) {
        esp_err_t err = esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(ms) * 1000);
        if (err != ESP_OK)
            return JS_ThrowInternalError(ctx, "timer wakeup failed: %s", esp_err_to_name(err));
    }

    /* Note: we intentionally do NOT call MIK_FreeRuntime() here.  We are inside
     * a JS function call, so the runtime still has live GC objects on the call
     * stack — freeing it would trigger a QuickJS assert.  Since deep sleep
     * reboots the chip, all memory is reclaimed anyway. */
    esp_deep_sleep_start();
    /* Never reached */
    __builtin_unreachable();
}

static JSValue mik__sleep_light(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int64_t ms;
    if (JS_ToInt64(ctx, &ms, argv[0])) return JS_EXCEPTION;

    if (ms > 0) {
        esp_err_t err = esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(ms) * 1000);
        if (err != ESP_OK)
            return mik__result_err_named(ctx, "WakeupConfigFailed",
                                         "failed to enable timer wakeup: %s",
                                         esp_err_to_name(err));
    }

    esp_err_t err = esp_light_sleep_start();
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "LightSleepFailed",
                                     "light sleep failed: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

static JSValue mik__sleep_get_wakeup_cause(JSContext* ctx, JSValue this_val, int argc,
                                            JSValue* argv) {
    uint32_t causes = esp_sleep_get_wakeup_causes();
    return JS_NewString(ctx, mik__wakeup_cause_str(causes));
}

static JSValue mik__sleep_enable_timer_wakeup(JSContext* ctx, JSValue this_val, int argc,
                                               JSValue* argv) {
    int64_t us;
    if (JS_ToInt64(ctx, &us, argv[0])) return JS_EXCEPTION;

    esp_err_t err = esp_sleep_enable_timer_wakeup(static_cast<uint64_t>(us));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WakeupConfigFailed",
                                     "failed to enable timer wakeup: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

static JSValue mik__sleep_enable_gpio_wakeup(JSContext* ctx, JSValue this_val, int argc,
                                              JSValue* argv) {
    int32_t pin, level;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &level, argv[1])) return JS_EXCEPTION;

    esp_err_t err =
        gpio_wakeup_enable(static_cast<gpio_num_t>(pin), static_cast<gpio_int_type_t>(level));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WakeupConfigFailed",
                                     "failed to enable GPIO wakeup on pin %d: %s", pin,
                                     esp_err_to_name(err));

    err = esp_sleep_enable_gpio_wakeup();
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WakeupConfigFailed",
                                     "failed to enable GPIO wakeup source: %s",
                                     esp_err_to_name(err));

    return mik__result_ok_void(ctx);
}

/* EXT0 / EXT1 wakeup is chip-specific (not on ESP32-C3, C6, H2). We still
 * register the JS exports unconditionally so `mikrojs/sleep`'s static
 * re-exports resolve on every target; the function bodies return a
 * `WakeupConfigFailed` error on chips where the capability is missing. */
static JSValue mik__sleep_enable_ext0_wakeup(JSContext* ctx, JSValue this_val, int argc,
                                             JSValue* argv) {
#if SOC_PM_SUPPORT_EXT0_WAKEUP
    int32_t pin, level;
    if (JS_ToInt32(ctx, &pin, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &level, argv[1])) return JS_EXCEPTION;

    esp_err_t err = esp_sleep_enable_ext0_wakeup(static_cast<gpio_num_t>(pin), level);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WakeupConfigFailed",
                                     "failed to enable EXT0 wakeup on pin %d: %s", pin,
                                     esp_err_to_name(err));

    return mik__result_ok_void(ctx);
#else
    return mik__result_err_named(ctx, "WakeupConfigFailed",
                                 "EXT0 wakeup is not supported on this chip");
#endif
}

static JSValue mik__sleep_enable_ext1_wakeup(JSContext* ctx, JSValue this_val, int argc,
                                             JSValue* argv) {
#if SOC_PM_SUPPORT_EXT1_WAKEUP
    int64_t pin_mask;
    int32_t mode;
    if (JS_ToInt64(ctx, &pin_mask, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &mode, argv[1])) return JS_EXCEPTION;

    esp_err_t err = esp_sleep_enable_ext1_wakeup(static_cast<uint64_t>(pin_mask),
                                                  static_cast<esp_sleep_ext1_wakeup_mode_t>(mode));
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "WakeupConfigFailed",
                                     "failed to enable EXT1 wakeup: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
#else
    return mik__result_err_named(ctx, "WakeupConfigFailed",
                                 "EXT1 wakeup is not supported on this chip");
#endif
}

static JSValue mik__sleep_disable_wakeup_source(JSContext* ctx, JSValue this_val, int argc,
                                                 JSValue* argv) {
    esp_sleep_source_t source = ESP_SLEEP_WAKEUP_ALL;

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        const char* str = JS_ToCString(ctx, argv[0]);
        if (!str) return JS_EXCEPTION;

        bool valid = true;
        if (strcmp(str, "timer") == 0)
            source = ESP_SLEEP_WAKEUP_TIMER;
        else if (strcmp(str, "ext0") == 0)
            source = ESP_SLEEP_WAKEUP_EXT0;
        else if (strcmp(str, "ext1") == 0)
            source = ESP_SLEEP_WAKEUP_EXT1;
        else if (strcmp(str, "gpio") == 0)
            source = ESP_SLEEP_WAKEUP_GPIO;
        else if (strcmp(str, "touchpad") == 0)
            source = ESP_SLEEP_WAKEUP_TOUCHPAD;
        else if (strcmp(str, "ulp") == 0)
            source = ESP_SLEEP_WAKEUP_ULP;
        else
            valid = false;

        if (!valid) {
            JSValue err = JS_ThrowRangeError(ctx, "unknown wakeup source: %s", str);
            JS_FreeCString(ctx, str);
            return err;
        }
        JS_FreeCString(ctx, str);
    }

    esp_err_t err = esp_sleep_disable_wakeup_source(source);
    if (err != ESP_OK)
        return mik__result_err_named(ctx, "DisableWakeupFailed",
                                     "failed to disable wakeup source: %s", esp_err_to_name(err));

    return mik__result_ok_void(ctx);
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
        ctx, m, "enableTimerWakeup",
        JS_NewCFunction(ctx, mik__sleep_enable_timer_wakeup, "enableTimerWakeup", 1));
    JS_SetModuleExport(
        ctx, m, "enableGpioWakeup",
        JS_NewCFunction(ctx, mik__sleep_enable_gpio_wakeup, "enableGpioWakeup", 2));
    JS_SetModuleExport(
        ctx, m, "enableExt0Wakeup",
        JS_NewCFunction(ctx, mik__sleep_enable_ext0_wakeup, "enableExt0Wakeup", 2));
    JS_SetModuleExport(
        ctx, m, "enableExt1Wakeup",
        JS_NewCFunction(ctx, mik__sleep_enable_ext1_wakeup, "enableExt1Wakeup", 2));
    JS_SetModuleExport(
        ctx, m, "disableWakeupSource",
        JS_NewCFunction(ctx, mik__sleep_disable_wakeup_source, "disableWakeupSource", 1));
    return 0;
}

static JSModuleDef* mik__sleep_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:sleep", mik__sleep_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "deepSleep");
    JS_AddModuleExport(ctx, m, "lightSleep");
    JS_AddModuleExport(ctx, m, "getWakeupCause");
    JS_AddModuleExport(ctx, m, "enableTimerWakeup");
    JS_AddModuleExport(ctx, m, "enableGpioWakeup");
    JS_AddModuleExport(ctx, m, "enableExt0Wakeup");
    JS_AddModuleExport(ctx, m, "enableExt1Wakeup");
    JS_AddModuleExport(ctx, m, "disableWakeupSource");
    return m;
}

MIK_REGISTER_MODULE(sleep, "native:sleep", mik__sleep_init, nullptr, nullptr)

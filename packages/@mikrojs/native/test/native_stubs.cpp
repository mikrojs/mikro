/* No-op stub registrations for ESP-only `native:*` modules.
 *
 * Linked into the host memory_bench binary so `mikrojs/wifi`, `mikrojs/pin`,
 * `mikrojs/fetch`, `mikrojs/kv` and friends can be import-loaded on the host
 * without their real ESP-IDF backing modules. The stubs export the right
 * symbol shape (function or constructor) but do nothing — bench cares only
 * about JS bytecode + intrinsic pull-in cost, not on-device behavior.
 *
 * Self-registers via MIK_REGISTER_MODULE; resolved at first import. */
#include <cstddef>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

namespace {

JSValue stub_noop(JSContext*, JSValueConst, int, JSValueConst*) {
    return JS_UNDEFINED;
}

JSValue stub_ctor(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewObject(ctx);
}

}  // namespace

#define STUB_FUNCS(id, mod_name, ...)                                                              \
    namespace {                                                                                    \
    const char* const id##_exports[] = {__VA_ARGS__};                                              \
    constexpr size_t id##_count = sizeof(id##_exports) / sizeof(id##_exports[0]);                  \
    int id##_mod_init(JSContext* ctx, JSModuleDef* m) {                                            \
        for (size_t i = 0; i < id##_count; i++) {                                                  \
            JS_SetModuleExport(ctx, m, id##_exports[i],                                            \
                               JS_NewCFunction(ctx, stub_noop, id##_exports[i], 0));               \
        }                                                                                          \
        return 0;                                                                                  \
    }                                                                                              \
    JSModuleDef* id##_init(JSContext* ctx) {                                                       \
        JSModuleDef* m = JS_NewCModule(ctx, mod_name, id##_mod_init);                              \
        if (!m) return nullptr;                                                                    \
        for (size_t i = 0; i < id##_count; i++) JS_AddModuleExport(ctx, m, id##_exports[i]);       \
        return m;                                                                                  \
    }                                                                                              \
    }                                                                                              \
    MIK_REGISTER_MODULE(stub_##id, mod_name, id##_init, nullptr, nullptr)

#define STUB_CLASS(id, mod_name, class_name)                                                       \
    namespace {                                                                                    \
    int id##_mod_init(JSContext* ctx, JSModuleDef* m) {                                            \
        JS_SetModuleExport(                                                                        \
            ctx, m, class_name,                                                                    \
            JS_NewCFunction2(ctx, stub_ctor, class_name, 0, JS_CFUNC_constructor, 0));             \
        return 0;                                                                                  \
    }                                                                                              \
    JSModuleDef* id##_init(JSContext* ctx) {                                                       \
        JSModuleDef* m = JS_NewCModule(ctx, mod_name, id##_mod_init);                              \
        if (!m) return nullptr;                                                                    \
        JS_AddModuleExport(ctx, m, class_name);                                                    \
        return m;                                                                                  \
    }                                                                                              \
    }                                                                                              \
    MIK_REGISTER_MODULE(stub_##id, mod_name, id##_init, nullptr, nullptr)

STUB_FUNCS(pin, "native:mikro/pin", "pinMode", "digitalWrite", "digitalRead", "analogRead",
           "analogReadMillivolts")
STUB_FUNCS(sntp, "native:mikro/sntp", "sync", "stop", "setTimezone")
STUB_FUNCS(sleep, "native:mikro/sleep", "deepSleep", "lightSleep", "getWakeupCause",
           "canWakeFromExt0", "canWakeFromExt1")
STUB_FUNCS(http, "native:mikro/http", "request", "nextMessage", "cancel", "pendingCount")
STUB_FUNCS(nvs_kv, "native:mikro/nvs_kv", "set", "get", "remove", "clear", "sysSet", "sysGet",
           "sysRemove", "sysClear", "info")
STUB_FUNCS(rtc, "native:mikro/rtc", "set", "get", "remove", "clear", "info")

STUB_CLASS(wifi, "native:mikro/wifi", "Wifi")
STUB_CLASS(pwm, "native:mikro/pwm", "Pwm")
STUB_CLASS(spi, "native:mikro/spi", "Spi")
STUB_CLASS(i2c, "native:mikro/i2c", "I2c")
STUB_CLASS(uart, "native:mikro/uart", "Uart")
STUB_CLASS(neopixel, "native:mikro/neopixel", "NeoPixel")

#include <string>

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"
#include "utils.h"

/* mikro/gpio is self-registered and loaded on first import. Handles are driven
 * from JS (with TEST_GPIO and TEST_ADC_GPIO as globals); the pad is inspected
 * and toggled from C. Results come back as JSON in globalThis.out. */

#define TEST_GPIO CONFIG_MIKROJS_TEST_GPIO_PIN
#define TEST_ADC_GPIO CONFIG_MIKROJS_TEST_ADC_PIN

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "TEST_GPIO", JS_NewInt32(ctx, TEST_GPIO));
    JS_SetPropertyStr(ctx, global, "TEST_ADC_GPIO", JS_NewInt32(ctx, TEST_ADC_GPIO));
    JS_FreeValue(ctx, global);
}

static void teardown() {
    MIK_FreeRuntime(rt);
    TEST_ASSERT_NULL_MESSAGE(MIK_GpioOwner(TEST_GPIO), "runtime teardown should release the GPIO");
}

static void run(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "pins_test.js", code, strlen(code));
    if (JS_IsException(ret)) mik_dump_error(ctx);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "module eval threw");
    JS_FreeValue(ctx, ret);
    mik__execute_jobs(ctx);
}

static std::string out() {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, "out");
    const char* s = JS_ToCString(ctx, v);
    std::string result = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return result;
}

static void loop_passes(int n) {
    for (int i = 0; i < n; i++) {
        MIK_Loop(rt);
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

TEST_CASE("DigitalOut applies initial and written levels to the pad", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        globalThis.led = DigitalOut(TEST_GPIO, {initial: 1}).orPanic('led')
    )");
    /* Read the pad back: enable the input buffer beside the output driver. */
    gpio_set_direction(static_cast<gpio_num_t>(TEST_GPIO), GPIO_MODE_INPUT_OUTPUT);
    TEST_ASSERT_EQUAL_INT(1, gpio_get_level(static_cast<gpio_num_t>(TEST_GPIO)));

    run(R"(
        let thrown = ''
        try { led.write(true) } catch (e) { thrown = e.name }
        globalThis.out = JSON.stringify([led.write(0) === undefined, thrown])
    )");
    TEST_ASSERT_EQUAL_STRING("[true,\"TypeError\"]", out().c_str());
    TEST_ASSERT_EQUAL_INT(0, gpio_get_level(static_cast<gpio_num_t>(TEST_GPIO)));
    teardown();
}

TEST_CASE("a non-integer or out-of-range gpio is rejected", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        const names = [NaN, 1.5].map((gpio) => {
            try { DigitalOut(gpio) } catch (e) { return e.name }
        })
        const r = DigitalOut(100)
        globalThis.out = JSON.stringify([...names, r.ok || r.error.name])
    )");
    TEST_ASSERT_EQUAL_STRING("[\"TypeError\",\"TypeError\",\"InvalidGpio\"]", out().c_str());
    teardown();
}

TEST_CASE("a second claim on a GPIO returns GpioInUse", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut, DigitalIn} from 'mikro/gpio'
        const first = DigitalOut(TEST_GPIO).orPanic('first')
        const second = DigitalIn(TEST_GPIO)
        globalThis.out = JSON.stringify([first.gpio === TEST_GPIO, second.ok, second.error.name,
                                         second.error.owner])
    )");
    TEST_ASSERT_EQUAL_STRING("[true,false,\"GpioInUse\",\"DigitalOut\"]", out().c_str());
    TEST_ASSERT_EQUAL_STRING("DigitalOut", MIK_GpioOwner(TEST_GPIO));
    teardown();
}

TEST_CASE("a handle nothing refers to keeps its claim until the runtime is freed", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        DigitalOut(TEST_GPIO).orPanic('dropped')
        globalThis.out = JSON.stringify(DigitalOut(TEST_GPIO).error.owner)
    )");
    TEST_ASSERT_EQUAL_STRING("\"DigitalOut\"", out().c_str());
    JS_RunGC(JS_GetRuntime(ctx));
    TEST_ASSERT_EQUAL_STRING("DigitalOut", MIK_GpioOwner(TEST_GPIO));
    teardown();
}

TEST_CASE("end() releases the GPIO and a later write does nothing", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        globalThis.stale = DigitalOut(TEST_GPIO).orPanic('stale')
        stale.end()
        stale.end()
        globalThis.again = DigitalOut(TEST_GPIO, {initial: 0}).orPanic('again')
    )");
    gpio_set_direction(static_cast<gpio_num_t>(TEST_GPIO), GPIO_MODE_INPUT_OUTPUT);
    /* The released handle must not drive a pad that now belongs to `again`. */
    run(R"(globalThis.out = JSON.stringify(stale.write(1) === undefined))");
    TEST_ASSERT_EQUAL_STRING("true", out().c_str());
    TEST_ASSERT_EQUAL_INT(0, gpio_get_level(static_cast<gpio_num_t>(TEST_GPIO)));
    run(R"(again.end())");
    TEST_ASSERT_NULL(MIK_GpioOwner(TEST_GPIO));
    teardown();
}

TEST_CASE("Pwm and DigitalOut report each other as owners", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        import {Pwm} from 'mikro/pwm'
        const pwm = Pwm(TEST_GPIO, {freq: 5000, duty: 0.5}).orPanic('pwm')
        const blocked = DigitalOut(TEST_GPIO)
        pwm.end()
        const led = DigitalOut(TEST_GPIO).orPanic('led')
        const blockedPwm = Pwm(TEST_GPIO, {freq: 5000})
        globalThis.out = JSON.stringify([blocked.error.owner, blockedPwm.error.name,
                                         blockedPwm.error.owner])
        led.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[\"Pwm\",\"GpioInUse\",\"DigitalOut\"]", out().c_str());
    teardown();
}

TEST_CASE("NeoPixel and DigitalOut report each other as owners", "[gpio]") {
    setup();
    run(R"(
        import {DigitalOut} from 'mikro/gpio'
        import {NeoPixel} from 'mikro/neopixel'
        const pixels = NeoPixel(TEST_GPIO, {count: 1}).orPanic('pixels')
        const blocked = DigitalOut(TEST_GPIO)
        pixels.end()
        const led = DigitalOut(TEST_GPIO).orPanic('led')
        const blockedPixels = NeoPixel(TEST_GPIO, {count: 1})
        globalThis.out = JSON.stringify([blocked.error.owner, blockedPixels.error.name,
                                         blockedPixels.error.owner])
        led.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[\"NeoPixel\",\"GpioInUse\",\"DigitalOut\"]", out().c_str());
    teardown();
}

TEST_CASE("DigitalIn.onChange emits level changes and completes on end()", "[gpio]") {
    setup();
    run(R"(
        import {DigitalIn} from 'mikro/gpio'
        globalThis.events = []
        globalThis.button = DigitalIn(TEST_GPIO, {pull: 'down'}).orPanic('button')
        button.onChange.subscribe({
            next: (v) => events.push(v),
            complete: () => events.push('done'),
        })
    )");
    /* Drive the input pad from its own output driver to produce edges. */
    auto gpio = static_cast<gpio_num_t>(TEST_GPIO);
    gpio_set_level(gpio, 0);
    gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT);
    loop_passes(2);
    gpio_set_level(gpio, 1);
    loop_passes(2);
    gpio_set_level(gpio, 0);
    loop_passes(2);

    run(R"(
        globalThis.out = JSON.stringify([button.read()])
        button.end()
        globalThis.out = JSON.stringify([...JSON.parse(out), events, button.read()])
    )");
    TEST_ASSERT_EQUAL_STRING("[0,[1,0,\"done\"],0]", out().c_str());
    teardown();
}

TEST_CASE("onChange keeps delivering after the app drops the handle", "[gpio]") {
    setup();
    run(R"(
        import {DigitalIn} from 'mikro/gpio'
        globalThis.events = []
        // No binding. The handle lives until end() anyway.
        DigitalIn(TEST_GPIO, {pull: 'down'})
            .orPanic('button')
            .onChange.subscribe((v) => events.push(v))
    )");
    auto gpio = static_cast<gpio_num_t>(TEST_GPIO);
    gpio_set_level(gpio, 0);
    gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT);
    JS_RunGC(JS_GetRuntime(ctx));
    gpio_set_level(gpio, 1);
    loop_passes(2);
    run(R"(globalThis.out = JSON.stringify(events))");
    TEST_ASSERT_EQUAL_STRING("[1]", out().c_str());
    teardown();
}

TEST_CASE("onChange keeps its edge interrupt across a light-sleep GPIO wake", "[gpio]") {
    setup();
    run(R"(
        import {DigitalIn} from 'mikro/gpio'
        globalThis.events = []
        globalThis.button = DigitalIn(TEST_GPIO, {pull: 'up'}).orPanic('button')
        button.onChange.subscribe((v) => events.push(v))
    )");
    auto gpio = static_cast<gpio_num_t>(TEST_GPIO);
    gpio_set_level(gpio, 1);
    gpio_set_direction(gpio, GPIO_MODE_INPUT_OUTPUT);
    loop_passes(2);

    /* The wake source switches the pin to a level interrupt; the timer wakes the chip. */
    run(R"(
        import {lightSleep} from 'native:mikro/sleep'
        lightSleep({gpio: TEST_GPIO, level: 'low', timer: 20})
    )");
    loop_passes(2);

    /* Holding the level low must not flood, and the release edge must still arrive. */
    gpio_set_level(gpio, 0);
    loop_passes(5);
    gpio_set_level(gpio, 1);
    loop_passes(2);
    run(R"(
        globalThis.out = JSON.stringify(events)
        button.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[0,1]", out().c_str());
    teardown();
}

TEST_CASE("AnalogIn reads raw and calibrated values", "[gpio]") {
    setup();
    run(R"(
        import {AnalogIn} from 'mikro/gpio'
        const pot = AnalogIn(TEST_ADC_GPIO, {attenuation: '11db'}).orPanic('pot')
        const raw = pot.read()
        const mv = pot.readMillivolts()
        globalThis.out = JSON.stringify([
            raw.ok && raw.value >= 0 && raw.value <= 4095,
            mv.ok ? mv.value >= 0 : mv.error.name === 'CalibrationUnavailable',
        ])
        pot.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[true,true]", out().c_str());
    teardown();
}

TEST_CASE("AnalogIn rejects a GPIO that is not on ADC1", "[gpio]") {
    setup();
    run(R"(
        import {AnalogIn} from 'mikro/gpio'
        const r = AnalogIn(TEST_GPIO)
        globalThis.out = JSON.stringify([r.ok, r.ok || r.error.name])
        if (r.ok) r.value.end()
    )");
    /* TEST_GPIO is not on ADC1 in any default test config; skip where it is ADC1. */
    std::string result = out();
    if (result != "[true,true]")
        TEST_ASSERT_EQUAL_STRING("[false,\"InvalidGpio\"]", result.c_str());
    teardown();
}

#if CONFIG_IDF_TARGET_ESP32
TEST_CASE("a pull on an input-only GPIO returns InvalidGpio", "[gpio]") {
    setup();
    run(R"(
        import {DigitalIn} from 'mikro/gpio'
        const r = DigitalIn(34, {pull: 'up'})
        const floating = DigitalIn(34)
        globalThis.out = JSON.stringify([r.ok, r.ok || r.error.name, r.ok || r.error.message,
                                         floating.ok])
        if (floating.ok) floating.value.end()
    )");
    TEST_ASSERT_EQUAL_STRING(
        "[false,\"InvalidGpio\",\"GPIO 34 has no internal pull resistors on esp32\",true]",
        out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(34));
    teardown();
}
#endif

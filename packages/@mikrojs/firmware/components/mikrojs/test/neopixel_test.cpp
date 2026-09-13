#include "js_harness.h"

using namespace js_harness;

TEST_CASE("NeoPixel returns a handle that fills, sets and shows", "[neopixel]") {
    setup();
    run(R"(
        import {NeoPixel} from 'mikro/neopixel'
        const pixels = NeoPixel(TEST_GPIO, {count: 4, rgbw: true}).orPanic('pixels')
        const results = [pixels.fill(1, 2, 3, 4), pixels.setPixel(3, 255, 0, 0), pixels.show(),
                         pixels.clear()]
        const outOfRange = pixels.setPixel(4, 0, 0, 0)
        globalThis.out = JSON.stringify([results.every((r) => r.ok), outOfRange.error.name])
        pixels.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[true,\"IndexOutOfRange\"]", out().c_str());
    teardown();
}

TEST_CASE("NeoPixel throws on wrong types and returns Results for bad values", "[neopixel]") {
    setup();
    run(R"(
        import {NeoPixel} from 'mikro/neopixel'
        const thrown = [() => NeoPixel(1.5, {count: 1}), () => NeoPixel(TEST_GPIO),
                        () => NeoPixel(TEST_GPIO, {count: '4'}),
                        () => NeoPixel(TEST_GPIO, {count: 4, rgbw: 1})].map((f) => {
            try { f() } catch (e) { return e.name }
        })
        const errors = [NeoPixel(TEST_GPIO, {count: 0}), NeoPixel(100, {count: 1})]
            .map((r) => r.error.name)
        globalThis.out = JSON.stringify([...thrown, ...errors])
    )");
    TEST_ASSERT_EQUAL_STRING(
        "[\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\",\"InvalidParam\",\"InvalidGpio\"]",
        out().c_str());
    teardown();
}

TEST_CASE("NeoPixel end() releases the GPIO and later calls do nothing", "[neopixel]") {
    setup();
    run(R"(
        import {NeoPixel} from 'mikro/neopixel'
        const stale = NeoPixel(TEST_GPIO, {count: 2}).orPanic('stale')
        const ended = [stale.end(), stale.end()]
        const again = NeoPixel(TEST_GPIO, {count: 2}).orPanic('again')
        const after = [stale.setPixel(9, 0, 0, 0), stale.fill(0, 0, 0), stale.show(), stale.clear()]
        globalThis.out = JSON.stringify([ended, after.every((r) => r.ok)])
        again.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[[null,null],true]", out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(TEST_GPIO));
    teardown();
}

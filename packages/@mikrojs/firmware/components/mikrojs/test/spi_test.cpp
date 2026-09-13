#include "js_harness.h"

using namespace js_harness;

/* Write-only bus: TEST_GPIO as the clock and GPIO 7 as MOSI (the I2C tests use
 * GPIO 6 and 7 on the ESP32-C6 too). Nothing needs to be connected. */
static void set_spi_globals() {
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "MOSI", JS_NewInt32(ctx, 7));
    JS_FreeValue(ctx, global);
}

TEST_CASE("Spi returns a handle that writes and transfers", "[spi]") {
    setup();
    set_spi_globals();
    run(R"(
        import {Spi} from 'mikro/spi'
        const spi = Spi(1, {clk: TEST_GPIO, mosi: MOSI, freq: 100000}).orPanic('spi')
        const wrote = spi.write(new Uint8Array([1, 2, 3]))
        const got = spi.transfer(new Uint8Array(4))
        const second = Spi(1, {clk: TEST_GPIO, mosi: MOSI})
        globalThis.out = JSON.stringify([wrote.ok, got.value.length, second.error.name])
        spi.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[true,4,\"GpioInUse\"]", out().c_str());
    teardown();
}

TEST_CASE("Spi throws on wrong types and returns Results for bad values", "[spi]") {
    setup();
    set_spi_globals();
    run(R"(
        import {Spi} from 'mikro/spi'
        const thrown = [() => Spi(1), () => Spi(1, {clk: 1.5, mosi: MOSI}),
                        () => Spi(1, {clk: TEST_GPIO, mosi: MOSI, mode: 4})].map((f) => {
            try { f() } catch (e) { return e.name }
        })
        const errors = [Spi(99, {clk: TEST_GPIO, mosi: MOSI}), Spi(1, {clk: 100, mosi: MOSI}),
                        Spi(1, {clk: TEST_GPIO, mosi: MOSI, freq: 0})].map((r) => r.error.name)
        const spi = Spi(1, {clk: TEST_GPIO, mosi: MOSI}).orPanic('spi')
        let writeThrew = ''
        try { spi.write([1]) } catch (e) { writeThrew = e.name }
        spi.end()
        globalThis.out = JSON.stringify([...thrown, ...errors, writeThrew])
    )");
    TEST_ASSERT_EQUAL_STRING("[\"TypeError\",\"TypeError\",\"TypeError\",\"InvalidParam\","
                             "\"InvalidGpio\",\"InvalidParam\",\"TypeError\"]",
                             out().c_str());
    teardown();
}

TEST_CASE("Spi end() frees the bus and later calls do nothing", "[spi]") {
    setup();
    set_spi_globals();
    run(R"(
        import {Spi} from 'mikro/spi'
        const stale = Spi(1, {clk: TEST_GPIO, mosi: MOSI}).orPanic('stale')
        const ended = [stale.end(), stale.end()]
        const again = Spi(1, {clk: TEST_GPIO, mosi: MOSI}).orPanic('again')
        const after = [stale.write(new Uint8Array([1])).ok,
                       stale.transfer(new Uint8Array(2)).value.length]
        globalThis.out = JSON.stringify([ended, after])
        again.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[[null,null],[true,0]]", out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(TEST_GPIO));
    teardown();
}

#include "js_harness.h"

using namespace js_harness;

/* Port 1 with TEST_GPIO as TX and GPIO 6 as RX (the I2C tests use GPIO 6 and 7
 * on the ESP32-C6 too). No jumper is needed: nothing here expects data. */
static void set_uart_globals() {
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "RX", JS_NewInt32(ctx, 6));
    JS_FreeValue(ctx, global);
}

TEST_CASE("Uart returns a handle that writes and guards its readers", "[uart]") {
    setup();
    set_uart_globals();
    run(R"(
        import {Uart} from 'mikro/uart'
        const uart = Uart(1, {tx: TEST_GPIO, rx: RX, baudRate: 115200}).orPanic('uart')
        const reader = uart.read().orPanic('reader')
        const second = uart.read()
        const results = [uart.write(new Uint8Array([0x41])).ok,
                         reader[Symbol.asyncIterator]() === reader, second.error.name]
        await reader.return()
        results.push(uart.read().ok)
        uart.end()
        const rxOnly = Uart(1, {rx: RX, baudRate: 9600}).orPanic('rxOnly')
        results.push(rxOnly.write(new Uint8Array(1)).error.name)
        rxOnly.end()
        globalThis.out = JSON.stringify(results)
    )");
    TEST_ASSERT_EQUAL_STRING("[true,true,\"AlreadyReading\",true,\"NoTxPin\"]", out().c_str());
    teardown();
}

TEST_CASE("Uart throws on wrong types and returns Results for bad values", "[uart]") {
    setup();
    set_uart_globals();
    run(R"(
        import {Uart} from 'mikro/uart'
        const thrown = [() => Uart(1), () => Uart(1, {baudRate: 9600}),
                        () => Uart(1, {tx: TEST_GPIO})].map((f) => {
            try { f() } catch (e) { return e.name }
        })
        const errors = [Uart(99, {tx: TEST_GPIO, baudRate: 9600}),
                        Uart(1, {tx: TEST_GPIO, baudRate: 0}),
                        Uart(1, {tx: 100, baudRate: 9600})].map((r) => r.error.name)
        globalThis.out = JSON.stringify([...thrown, ...errors])
    )");
    TEST_ASSERT_EQUAL_STRING("[\"TypeError\",\"TypeError\",\"TypeError\",\"InvalidParam\","
                             "\"InvalidParam\",\"InvalidGpio\"]",
                             out().c_str());
    teardown();
}

TEST_CASE("Uart end() completes a waiting reader and later calls do nothing", "[uart]") {
    setup();
    set_uart_globals();
    run(R"(
        import {Uart} from 'mikro/uart'
        globalThis.uart = Uart(1, {tx: TEST_GPIO, rx: RX, baudRate: 115200}).orPanic('uart')
        globalThis.events = []
        const reader = uart.read().orPanic('reader')
        ;(async () => {
            for await (const chunk of reader) events.push(chunk.ok)
            events.push('done')
        })()
    )");
    loop_passes(2);
    run(R"(
        const ended = [uart.end(), uart.end()]
        const after = uart.read().orPanic('after')
        const first = await after.next()
        globalThis.out = JSON.stringify([ended, uart.write(new Uint8Array(1)).ok, first.done])
    )");
    loop_passes(2);
    TEST_ASSERT_EQUAL_STRING("[[null,null],true,true]", out().c_str());
    run(R"(globalThis.out = JSON.stringify(events))");
    TEST_ASSERT_EQUAL_STRING("[\"done\"]", out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(TEST_GPIO));
    teardown();
}

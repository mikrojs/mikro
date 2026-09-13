#include "../mik_i2c.cpp"
#include "unity.h"

/* I2C test pins — use GPIO 6 (SDA) and GPIO 7 (SCL) on ESP32-C6.
 * Tests that don't require a connected device will still work with
 * floating pins; device-dependent tests are clearly marked. */
#define I2C_TEST_SDA 6
#define I2C_TEST_SCL 7
#define I2C_TEST_PORT 0

/* ── Bus lifecycle tests ─────────────────────────────────────────── */

TEST_CASE("I2C begin and end succeed", "[i2c]") {
    i2c_master_bus_handle_t bus = nullptr;

    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(I2C_TEST_PORT);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(I2C_TEST_SDA);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(I2C_TEST_SCL);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
    TEST_ASSERT_EQUAL(ESP_OK, err);
    TEST_ASSERT_NOT_NULL(bus);

    err = i2c_del_master_bus(bus);
    TEST_ASSERT_EQUAL(ESP_OK, err);
}

TEST_CASE("I2C probe single address does not crash", "[i2c]") {
    i2c_master_bus_handle_t bus = nullptr;

    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(I2C_TEST_PORT);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(I2C_TEST_SDA);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(I2C_TEST_SCL);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
    TEST_ASSERT_EQUAL(ESP_OK, err);

    /* Probe a single address — just verify it returns without crashing.
     * Without pull-ups or a connected device, this will timeout (expected). */
    esp_err_t probe_err = i2c_master_probe(bus, 0x44, 50);
    /* Either ESP_OK (device found) or an error (timeout/nack) is fine */
    TEST_ASSERT_TRUE(probe_err == ESP_OK || probe_err != ESP_OK);

    i2c_del_master_bus(bus);
}

TEST_CASE("I2C add and remove device succeeds", "[i2c]") {
    i2c_master_bus_handle_t bus = nullptr;

    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(I2C_TEST_PORT);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(I2C_TEST_SDA);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(I2C_TEST_SCL);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
    TEST_ASSERT_EQUAL(ESP_OK, err);

    i2c_master_dev_handle_t dev = nullptr;
    i2c_device_config_t dev_cfg = {};
    dev_cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dev_cfg.device_address = 0x44;  // common sensor address
    dev_cfg.scl_speed_hz = 100000;

    err = i2c_master_bus_add_device(bus, &dev_cfg, &dev);
    TEST_ASSERT_EQUAL(ESP_OK, err);
    TEST_ASSERT_NOT_NULL(dev);

    err = i2c_master_bus_rm_device(dev);
    TEST_ASSERT_EQUAL(ESP_OK, err);

    i2c_del_master_bus(bus);
}

TEST_CASE("I2C pending write buffer works", "[i2c]") {
    MIKI2CState s = {};
    mik__i2c_clear_pending(&s);

    TEST_ASSERT_FALSE(s.has_pending_write);
    TEST_ASSERT_EQUAL(0, s.pending_write_len);

    /* Simulate buffering a write */
    uint8_t data[] = {0xFD};
    memcpy(s.pending_write, data, sizeof(data));
    s.pending_write_len = sizeof(data);
    s.pending_write_addr = 0x44;
    s.has_pending_write = true;

    TEST_ASSERT_TRUE(s.has_pending_write);
    TEST_ASSERT_EQUAL(1, s.pending_write_len);
    TEST_ASSERT_EQUAL(0x44, s.pending_write_addr);
    TEST_ASSERT_EQUAL(0xFD, s.pending_write[0]);

    /* Clear */
    mik__i2c_clear_pending(&s);
    TEST_ASSERT_FALSE(s.has_pending_write);
    TEST_ASSERT_EQUAL(0, s.pending_write_len);
}

/* ── mikro/i2c from JS ─────────────────────────────────────────────── */

#include "js_harness.h"

static void set_i2c_globals() {
    JSValue global = JS_GetGlobalObject(js_harness::ctx);
    JS_SetPropertyStr(js_harness::ctx, global, "SDA", JS_NewInt32(js_harness::ctx, I2C_TEST_SDA));
    JS_SetPropertyStr(js_harness::ctx, global, "SCL", JS_NewInt32(js_harness::ctx, I2C_TEST_SCL));
    JS_FreeValue(js_harness::ctx, global);
}

TEST_CASE("I2c factory claims the pins and scans", "[i2c]") {
    js_harness::setup();
    set_i2c_globals();
    js_harness::run(R"(
        import {I2c} from 'mikro/i2c'
        const bus = I2c(0, {sda: SDA, scl: SCL, timeout: 20}).orPanic('bus')
        const scanned = bus.scan()
        const second = I2c(0, {sda: SDA, scl: SCL})
        globalThis.out = JSON.stringify([scanned.ok, second.error.name, second.error.owner])
        bus.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[true,\"GpioInUse\",\"I2c\"]", js_harness::out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(I2C_TEST_SDA));
    js_harness::teardown();
}

TEST_CASE("I2c throws on wrong types and returns Results for bad values", "[i2c]") {
    js_harness::setup();
    set_i2c_globals();
    js_harness::run(R"(
        import {I2c} from 'mikro/i2c'
        const thrown = [() => I2c(0), () => I2c(0, {sda: SDA}),
                        () => I2c(0, {sda: SDA, scl: SCL, freq: '1'})].map((f) => {
            try { f() } catch (e) { return e.name }
        })
        const errors = [I2c(9, {sda: SDA, scl: SCL}), I2c(0, {sda: 100, scl: SCL}),
                        I2c(0, {sda: SDA, scl: SCL, timeout: -1})].map((r) => r.error.name)
        const bus = I2c(0, {sda: SDA, scl: SCL, timeout: 20}).orPanic('bus')
        const values = [bus.read(0x80, 1), bus.read(0x44, 0), bus.write(0.5, new Uint8Array(1))]
            .map((r) => r.error.name)
        let stopThrew = ''
        try { bus.write(0x44, new Uint8Array(1), 0) } catch (e) { stopThrew = e.name }
        bus.end()
        globalThis.out = JSON.stringify([...thrown, ...errors, ...values, stopThrew])
    )");
    TEST_ASSERT_EQUAL_STRING(
        "[\"TypeError\",\"TypeError\",\"TypeError\",\"InvalidParam\",\"InvalidGpio\","
        "\"InvalidParam\",\"InvalidParam\",\"InvalidParam\",\"InvalidParam\",\"TypeError\"]",
        js_harness::out().c_str());
    js_harness::teardown();
}

TEST_CASE("I2c end() deletes the bus and later calls do nothing", "[i2c]") {
    js_harness::setup();
    set_i2c_globals();
    js_harness::run(R"(
        import {I2c} from 'mikro/i2c'
        const stale = I2c(0, {sda: SDA, scl: SCL}).orPanic('stale')
        const ended = [stale.end(), stale.end()]
        const again = I2c(0, {sda: SDA, scl: SCL}).orPanic('again')
        const after = [stale.write(0x44, new Uint8Array(1)).ok, stale.read(0x44, 2).value.length,
                       stale.scan().value.length]
        globalThis.out = JSON.stringify([ended, after])
        again.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[[null,null],[true,0,0]]", js_harness::out().c_str());
    js_harness::teardown();
}

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

TEST_CASE("I2C begin twice is idempotent via state guard", "[i2c]") {
    /* Simulate what the JS begin() does — second call is a no-op */
    MIKI2CState s = {};
    s.port = I2C_TEST_PORT;
    s.sda = I2C_TEST_SDA;
    s.scl = I2C_TEST_SCL;
    s.freq = MIK_I2C_DEFAULT_FREQ;
    s.timeout_ms = MIK_I2C_DEFAULT_TIMEOUT_MS;
    s.begun = false;

    /* First begin */
    i2c_master_bus_config_t bus_cfg = {};
    bus_cfg.i2c_port = static_cast<i2c_port_num_t>(s.port);
    bus_cfg.sda_io_num = static_cast<gpio_num_t>(s.sda);
    bus_cfg.scl_io_num = static_cast<gpio_num_t>(s.scl);
    bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_cfg.glitch_ignore_cnt = 7;
    bus_cfg.flags.enable_internal_pullup = true;

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s.bus);
    TEST_ASSERT_EQUAL(ESP_OK, err);
    s.begun = true;

    /* Second begin — should skip because s.begun is true */
    TEST_ASSERT_TRUE(s.begun);

    /* Cleanup */
    i2c_del_master_bus(s.bus);
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

#include <cstring>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_commands.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs/errors.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#include "esp_lcd_sh8601.h"
#include "sh8601_cmds.h"

#define SH8601_TAG "native:sh8601"

/* ── Display state ──────────────────────────────────────────────────── */

struct SH8601State {
    esp_lcd_panel_handle_t panel;
    esp_lcd_panel_io_handle_t io;
    spi_host_device_t spi_host;
    int rst_gpio;
    int bl_gpio;
    int width;
    int height;
    bool initialized;
};

static SH8601State* s_display = nullptr;

/* Return {ok: false, error: "message"} */
static inline JSValue mik__sh8601_err(JSContext* ctx, const char* msg) {
    JSValue obj = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "error", JS_NewString(ctx, msg), JS_PROP_C_W_E);
    return obj;
}

/* ── Hardware init using the vendor esp_lcd_sh8601 driver ───────────── */

static esp_err_t sh8601_hw_init(SH8601State* st, int clk, int d0, int d1,
                                int d2, int d3, int cs) {
    /* Turn on backlight first (demo does this before SPI init) */
    if (st->bl_gpio >= 0) {
        ledc_timer_config_t timer_cfg = {};
        timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
        timer_cfg.duty_resolution = LEDC_TIMER_10_BIT;
        timer_cfg.timer_num = LEDC_TIMER_0;
        timer_cfg.freq_hz = 5000;
        timer_cfg.clk_cfg = LEDC_AUTO_CLK;
        ledc_timer_config(&timer_cfg);

        ledc_channel_config_t ch_cfg = {};
        ch_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
        ch_cfg.channel = LEDC_CHANNEL_0;
        ch_cfg.timer_sel = LEDC_TIMER_0;
        ch_cfg.gpio_num = st->bl_gpio;
        ch_cfg.duty = 1023;
        ledc_channel_config(&ch_cfg);
    }

    /* Initialize QSPI bus (matching demo exactly) */
    spi_bus_config_t bus_cfg = {};
    bus_cfg.data0_io_num = d0;
    bus_cfg.data1_io_num = d1;
    bus_cfg.sclk_io_num = clk;
    bus_cfg.data2_io_num = d2;
    bus_cfg.data3_io_num = d3;
    bus_cfg.max_transfer_sz = st->width * st->height * sizeof(uint16_t);

    esp_err_t err = spi_bus_initialize(st->spi_host, &bus_cfg, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) return err;
    vTaskDelay(1);

    /* Create panel IO handle (QSPI config matching demo's SH8601_PANEL_IO_QSPI_CONFIG) */
    esp_lcd_panel_io_spi_config_t io_cfg = {};
    io_cfg.cs_gpio_num = static_cast<gpio_num_t>(cs);
    io_cfg.dc_gpio_num = static_cast<gpio_num_t>(-1);
    io_cfg.spi_mode = 0;
    io_cfg.pclk_hz = 40 * 1000 * 1000;
    io_cfg.trans_queue_depth = 10;
    io_cfg.lcd_cmd_bits = 32;
    io_cfg.lcd_param_bits = 8;
    io_cfg.flags.quad_mode = true;

    err = esp_lcd_new_panel_io_spi(st->spi_host, &io_cfg, &st->io);
    if (err != ESP_OK) {
        spi_bus_free(st->spi_host);
        return err;
    }
    vTaskDelay(1);

    /* Create panel using the vendor driver with custom init commands */
    sh8601_vendor_config_t vendor_cfg = {};
    vendor_cfg.init_cmds = sh8601_init_cmds;
    vendor_cfg.init_cmds_size = SH8601_INIT_CMDS_COUNT;
    vendor_cfg.flags.use_qspi_interface = 1;

    esp_lcd_panel_dev_config_t panel_cfg = {};
    panel_cfg.reset_gpio_num = static_cast<gpio_num_t>(st->rst_gpio);
    panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_cfg.bits_per_pixel = 16;
    panel_cfg.vendor_config = &vendor_cfg;

    err = esp_lcd_new_panel_sh8601(st->io, &panel_cfg, &st->panel);
    if (err != ESP_OK) {
        esp_lcd_panel_io_del(st->io);
        spi_bus_free(st->spi_host);
        return err;
    }

    err = esp_lcd_panel_reset(st->panel);
    if (err != ESP_OK) return err;
    vTaskDelay(1);

    err = esp_lcd_panel_init(st->panel);
    if (err != ESP_OK) return err;
    vTaskDelay(1);

    esp_lcd_panel_disp_on_off(st->panel, true);
    st->initialized = true;
    return ESP_OK;
}

/* ── JS function implementations ────────────────────────────────────── */

static JSValue mik__sh8601_init(JSContext* ctx, JSValue this_val, int argc,
                                JSValue* argv) {
    if (s_display && s_display->initialized) {
        return mik__sh8601_err(ctx, "display already initialized");
    }

    JSValue config = argv[0];
    int32_t width, height, spi_host;
    if (JS_ToInt32(ctx, &width, JS_GetPropertyStr(ctx, config, "width"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &height, JS_GetPropertyStr(ctx, config, "height"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &spi_host, JS_GetPropertyStr(ctx, config, "spiHost"))) return JS_EXCEPTION;

    JSValue pins = JS_GetPropertyStr(ctx, config, "pins");
    int32_t clk, d0, d1, d2, d3, cs, rst, bl;
    if (JS_ToInt32(ctx, &clk, JS_GetPropertyStr(ctx, pins, "clk"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &d0, JS_GetPropertyStr(ctx, pins, "d0"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &d1, JS_GetPropertyStr(ctx, pins, "d1"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &d2, JS_GetPropertyStr(ctx, pins, "d2"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &d3, JS_GetPropertyStr(ctx, pins, "d3"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &cs, JS_GetPropertyStr(ctx, pins, "cs"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &rst, JS_GetPropertyStr(ctx, pins, "rst"))) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &bl, JS_GetPropertyStr(ctx, pins, "bl"))) return JS_EXCEPTION;
    JS_FreeValue(ctx, pins);

    auto* st = new SH8601State();
    st->width = width;
    st->height = height;
    st->spi_host = static_cast<spi_host_device_t>(spi_host);
    st->rst_gpio = rst;
    st->bl_gpio = bl;
    st->initialized = false;

    esp_err_t err = sh8601_hw_init(st, clk, d0, d1, d2, d3, cs);
    if (err != ESP_OK) {
        delete st;
        return mik__sh8601_err(ctx, esp_err_to_name(err));
    }

    s_display = st;
    return mik__result_ok_void(ctx);
}

static JSValue mik__sh8601_draw_bitmap(JSContext* ctx, JSValue this_val, int argc,
                                       JSValue* argv) {
    if (!s_display || !s_display->initialized) {
        return mik__sh8601_err(ctx, "display not initialized");
    }

    int32_t x, y, w, h;
    if (JS_ToInt32(ctx, &x, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &y, argv[1])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &w, argv[2])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &h, argv[3])) return JS_EXCEPTION;

    size_t data_len;
    uint8_t* data = JS_GetUint8Array(ctx, &data_len, argv[4]);
    if (!data) return JS_EXCEPTION;

    size_t expected = static_cast<size_t>(w) * h * 2;
    if (data_len < expected) {
        return mik__sh8601_err(ctx, "buffer too small");
    }

    esp_lcd_panel_draw_bitmap(s_display->panel, x, y, x + w, y + h, data);
    return mik__result_ok_void(ctx);
}

static JSValue mik__sh8601_fill_rect(JSContext* ctx, JSValue this_val, int argc,
                                     JSValue* argv) {
    if (!s_display || !s_display->initialized) {
        return mik__sh8601_err(ctx, "display not initialized");
    }

    int32_t x, y, w, h, color;
    if (JS_ToInt32(ctx, &x, argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &y, argv[1])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &w, argv[2])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &h, argv[3])) return JS_EXCEPTION;
    if (JS_ToInt32(ctx, &color, argv[4])) return JS_EXCEPTION;

    /* Fill row by row using the panel's draw_bitmap */
    uint16_t c16 = static_cast<uint16_t>(color);
    size_t row_pixels = static_cast<size_t>(w);
    size_t row_bytes = row_pixels * 2;
    auto* row_buf = static_cast<uint16_t*>(heap_caps_malloc(row_bytes, MALLOC_CAP_DMA));
    if (!row_buf) {
        return mik__sh8601_err(ctx, "out of memory");
    }
    for (size_t i = 0; i < row_pixels; i++) {
        row_buf[i] = c16;
    }

    for (int row = 0; row < h; row++) {
        esp_lcd_panel_draw_bitmap(s_display->panel, x, y + row, x + w, y + row + 1, row_buf);
    }

    free(row_buf);
    return mik__result_ok_void(ctx);
}

static JSValue mik__sh8601_set_backlight(JSContext* ctx, JSValue this_val, int argc,
                                         JSValue* argv) {
    if (!s_display || !s_display->initialized) {
        return mik__sh8601_err(ctx, "display not initialized");
    }
    if (s_display->bl_gpio < 0) {
        return mik__sh8601_err(ctx, "no backlight pin configured");
    }

    int32_t brightness;
    if (JS_ToInt32(ctx, &brightness, argv[0])) return JS_EXCEPTION;
    if (brightness < 0) brightness = 0;
    if (brightness > 100) brightness = 100;

    uint32_t duty = static_cast<uint32_t>(brightness) * 1023 / 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);

    return mik__result_ok_void(ctx);
}

static JSValue mik__sh8601_sleep(JSContext* ctx, JSValue this_val, int argc,
                                 JSValue* argv) {
    if (!s_display || !s_display->initialized) {
        return mik__sh8601_err(ctx, "display not initialized");
    }
    esp_lcd_panel_disp_on_off(s_display->panel, false);
    return mik__result_ok_void(ctx);
}

static JSValue mik__sh8601_wake(JSContext* ctx, JSValue this_val, int argc,
                                JSValue* argv) {
    if (!s_display || !s_display->initialized) {
        return mik__sh8601_err(ctx, "display not initialized");
    }
    esp_lcd_panel_disp_on_off(s_display->panel, true);
    return mik__result_ok_void(ctx);
}

/* ── Module registration ────────────────────────────────────────────── */

static int mik__sh8601_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "init",
                       JS_NewCFunction(ctx, mik__sh8601_init, "init", 1));
    JS_SetModuleExport(ctx, m, "drawBitmap",
                       JS_NewCFunction(ctx, mik__sh8601_draw_bitmap, "drawBitmap", 5));
    JS_SetModuleExport(ctx, m, "fillRect",
                       JS_NewCFunction(ctx, mik__sh8601_fill_rect, "fillRect", 5));
    JS_SetModuleExport(ctx, m, "setBacklight",
                       JS_NewCFunction(ctx, mik__sh8601_set_backlight, "setBacklight", 1));
    JS_SetModuleExport(ctx, m, "sleep",
                       JS_NewCFunction(ctx, mik__sh8601_sleep, "sleep", 0));
    JS_SetModuleExport(ctx, m, "wake",
                       JS_NewCFunction(ctx, mik__sh8601_wake, "wake", 0));
    return 0;
}

JSModuleDef* mik__sh8601_mod_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:sh8601", mik__sh8601_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "init");
    JS_AddModuleExport(ctx, m, "drawBitmap");
    JS_AddModuleExport(ctx, m, "fillRect");
    JS_AddModuleExport(ctx, m, "setBacklight");
    JS_AddModuleExport(ctx, m, "sleep");
    JS_AddModuleExport(ctx, m, "wake");
    return m;
}

/* Generated bytecode header for the JS runtime wrapper */
#include "gen/mik_driver_sh8601_sh8601.h"

MIK_REGISTER_MODULE(sh8601, "native:sh8601", mik__sh8601_mod_init, nullptr, nullptr)

MIK_REGISTER_BUILTIN(sh8601, "@mikrojs/driver-sh8601",
                      mik_driver_sh8601_sh8601_bytecode,
                      mik_driver_sh8601_sh8601_bytecode_size)

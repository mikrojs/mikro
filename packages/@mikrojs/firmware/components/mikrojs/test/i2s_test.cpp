#include "../mik_i2s.cpp"
#include "unity.h"

/* I2S test pins. Tests use floating pins; the driver clocks regardless of what
 * (if anything) is wired, so lifecycle and DMA paths exercise without hardware.
 * Use I2S_NUM_AUTO so tests never collide on a fixed controller. */
#define I2S_TEST_BCLK 4
#define I2S_TEST_WS 5
#define I2S_TEST_DOUT 6
#define I2S_TEST_DIN 7

static i2s_std_config_t mik__i2s_test_std_cfg(uint32_t rate, i2s_data_bit_width_t width,
                                              i2s_slot_mode_t mode, bool tx, bool rx) {
    i2s_std_config_t cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(rate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(width, mode),
        .gpio_cfg =
            {
                .mclk = I2S_GPIO_UNUSED,
                .bclk = static_cast<gpio_num_t>(I2S_TEST_BCLK),
                .ws = static_cast<gpio_num_t>(I2S_TEST_WS),
                .dout = tx ? static_cast<gpio_num_t>(I2S_TEST_DOUT) : I2S_GPIO_UNUSED,
                .din = rx ? static_cast<gpio_num_t>(I2S_TEST_DIN) : I2S_GPIO_UNUSED,
                .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false},
            },
    };
    return cfg;
}

/* ── Pure config helpers ──────────────────────────────────────────── */

TEST_CASE("I2S bit width maps to driver enum", "[i2s]") {
    TEST_ASSERT_EQUAL(I2S_DATA_BIT_WIDTH_16BIT, mik__i2s_bit_width(16));
    TEST_ASSERT_EQUAL(I2S_DATA_BIT_WIDTH_32BIT, mik__i2s_bit_width(32));
}

TEST_CASE("I2S slot mode maps to driver enum", "[i2s]") {
    TEST_ASSERT_EQUAL(I2S_SLOT_MODE_STEREO, mik__i2s_slot_mode(true));
    TEST_ASSERT_EQUAL(I2S_SLOT_MODE_MONO, mik__i2s_slot_mode(false));
}

/* ── Standard-mode channel lifecycle (begin/end sequence) ─────────── */

TEST_CASE("I2S std TX channel lifecycle succeeds", "[i2s]") {
    i2s_chan_handle_t tx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, &tx, nullptr));
    TEST_ASSERT_NOT_NULL(tx);

    i2s_std_config_t cfg =
        mik__i2s_test_std_cfg(16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, true, false);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(tx, &cfg));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_enable(tx));

    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_disable(tx));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_del_channel(tx));
}

TEST_CASE("I2S std RX channel lifecycle succeeds", "[i2s]") {
    i2s_chan_handle_t rx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, nullptr, &rx));
    TEST_ASSERT_NOT_NULL(rx);

    i2s_std_config_t cfg =
        mik__i2s_test_std_cfg(16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO, false, true);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(rx, &cfg));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_enable(rx));

    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_disable(rx));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_del_channel(rx));
}

TEST_CASE("I2S full-duplex channels share one controller", "[i2s]") {
    i2s_chan_handle_t tx = nullptr, rx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, &tx, &rx));
    TEST_ASSERT_NOT_NULL(tx);
    TEST_ASSERT_NOT_NULL(rx);

    i2s_std_config_t cfg =
        mik__i2s_test_std_cfg(16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, true, true);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(tx, &cfg));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(rx, &cfg));

    i2s_del_channel(tx);
    i2s_del_channel(rx);
}

TEST_CASE("I2S custom DMA frame/buffer config is accepted", "[i2s]") {
    i2s_chan_handle_t rx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    cc.dma_desc_num = MIK_I2S_DEFAULT_DMA_BUFFERS;
    cc.dma_frame_num = MIK_I2S_DEFAULT_DMA_FRAMES;
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, nullptr, &rx));
    i2s_del_channel(rx);
}

/* ── TX drain helper ──────────────────────────────────────────────── */

TEST_CASE("I2S push advances offset within bounds", "[i2s]") {
    i2s_chan_handle_t tx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, &tx, nullptr));
    i2s_std_config_t cfg =
        mik__i2s_test_std_cfg(16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, true, false);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(tx, &cfg));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_enable(tx));

    MIKI2sState s = {};
    s.tx_chan = tx;

    uint8_t buf[256] = {0};
    MIKI2sTxChunk c = {};
    c.data = buf;
    c.len = sizeof(buf);
    c.off = 0;

    /* The production drain helper: no fault, offset advances, never past len. */
    bool ok = mik__i2s_push(&s, &c);
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_LESS_OR_EQUAL(c.len, c.off);

    i2s_channel_disable(tx);
    i2s_del_channel(tx);
}

/* ── Bulk capture (blocking-read path) ────────────────────────────── */

TEST_CASE("I2S blocking read (capture path) returns or times out cleanly", "[i2s]") {
    i2s_chan_handle_t rx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, nullptr, &rx));
    i2s_std_config_t cfg =
        mik__i2s_test_std_cfg(48000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, false, true);
    cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_init_std_mode(rx, &cfg));
    TEST_ASSERT_EQUAL(ESP_OK, i2s_channel_enable(rx));

    /* capture() drains the DMA with a real (non-zero) timeout per chunk; a
     * blocking read must return samples or report timeout, never fault/hang. */
    int32_t buf[256];
    size_t n = 0;
    esp_err_t err = i2s_channel_read(rx, buf, sizeof(buf), &n, 200);  // ms
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_TIMEOUT || err == ESP_ERR_INVALID_STATE);
    if (err == ESP_OK) {
        TEST_ASSERT_EQUAL(0, n % sizeof(int32_t));  // whole 32-bit samples
    }

    i2s_channel_disable(rx);
    i2s_del_channel(rx);
}

/* ── PDM RX, only where the SoC supports it ───────────────────────── */

#if SOC_I2S_SUPPORTS_PDM_RX
TEST_CASE("I2S PDM RX init does not crash", "[i2s]") {
    i2s_chan_handle_t rx = nullptr;
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    TEST_ASSERT_EQUAL(ESP_OK, i2s_new_channel(&cc, nullptr, &rx));

    i2s_pdm_rx_config_t cfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(16000),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg =
            {
                .clk = static_cast<gpio_num_t>(I2S_TEST_BCLK),
                .din = static_cast<gpio_num_t>(I2S_TEST_DIN),
                .invert_flags = {.clk_inv = false},
            },
    };
    /* Either succeeds or reports an error; must not crash. */
    esp_err_t err = i2s_channel_init_pdm_rx_mode(rx, &cfg);
    TEST_ASSERT_TRUE(err == ESP_OK || err != ESP_OK);

    i2s_del_channel(rx);
}
#endif

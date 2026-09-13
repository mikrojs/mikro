#include "../mik_pwm.cpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define PWM_PIN CONFIG_MIKROJS_TEST_PWM_PIN

TEST_CASE("PWM channel alloc and release", "[pwm]") {
    int ch = mik__pwm_alloc_channel();
    TEST_ASSERT_GREATER_OR_EQUAL(0, ch);
    mik__pwm_free_channel(ch);
}

TEST_CASE("PWM timer alloc shares same frequency", "[pwm]") {
    int t1 = mik__pwm_alloc_timer(5000);
    int t2 = mik__pwm_alloc_timer(5000);
    TEST_ASSERT_GREATER_OR_EQUAL(0, t1);
    TEST_ASSERT_EQUAL(t1, t2);  // same frequency shares timer
    mik__pwm_free_timer(t1);
    mik__pwm_free_timer(t2);
}

TEST_CASE("PWM timer alloc different frequencies", "[pwm]") {
    int t1 = mik__pwm_alloc_timer(5000);
    int t2 = mik__pwm_alloc_timer(1000);
    TEST_ASSERT_GREATER_OR_EQUAL(0, t1);
    TEST_ASSERT_GREATER_OR_EQUAL(0, t2);
    TEST_ASSERT_NOT_EQUAL(t1, t2);  // different frequency = different timer
    mik__pwm_free_timer(t1);
    mik__pwm_free_timer(t2);
}

TEST_CASE("PWM best resolution for common frequencies", "[pwm]") {
    /* 5 kHz → 80 MHz / 5000 = 16000, log2(16000) ≈ 13 */
    ledc_timer_bit_t res = mik__pwm_best_resolution(5000);
    TEST_ASSERT_GREATER_OR_EQUAL(10, res);
    TEST_ASSERT_LESS_OR_EQUAL(LEDC_TIMER_14_BIT, res);

    /* 1 MHz → 80 MHz / 1000000 = 80, log2(80) ≈ 6 */
    res = mik__pwm_best_resolution(1000000);
    TEST_ASSERT_GREATER_OR_EQUAL(4, res);
    TEST_ASSERT_LESS_OR_EQUAL(8, res);
}

TEST_CASE("PWM duty to raw conversion", "[pwm]") {
    /* 13-bit resolution: max = 8191 */
    TEST_ASSERT_EQUAL(0, mik__pwm_duty_to_raw(0.0, LEDC_TIMER_13_BIT));
    TEST_ASSERT_EQUAL(8191, mik__pwm_duty_to_raw(1.0, LEDC_TIMER_13_BIT));

    uint32_t half = mik__pwm_duty_to_raw(0.5, LEDC_TIMER_13_BIT);
    TEST_ASSERT_GREATER_OR_EQUAL(4090, half);
    TEST_ASSERT_LESS_OR_EQUAL(4100, half);
}

TEST_CASE("PWM channel exhaustion", "[pwm]") {
    int channels[MIK_PWM_MAX_CHANNELS];
    for (int i = 0; i < MIK_PWM_MAX_CHANNELS; i++) {
        channels[i] = mik__pwm_alloc_channel();
        TEST_ASSERT_GREATER_OR_EQUAL(0, channels[i]);
    }
    /* Next alloc should fail */
    TEST_ASSERT_EQUAL(-1, mik__pwm_alloc_channel());

    /* Release all */
    for (int i = 0; i < MIK_PWM_MAX_CHANNELS; i++) {
        mik__pwm_free_channel(channels[i]);
    }
    /* Should be able to alloc again */
    int ch = mik__pwm_alloc_channel();
    TEST_ASSERT_GREATER_OR_EQUAL(0, ch);
    mik__pwm_free_channel(ch);
}

TEST_CASE("PWM LEDC set duty produces output", "[pwm]") {
    int ch = mik__pwm_alloc_channel();
    int timer = mik__pwm_alloc_timer(5000);
    TEST_ASSERT_GREATER_OR_EQUAL(0, ch);
    TEST_ASSERT_GREATER_OR_EQUAL(0, timer);

    ledc_timer_bit_t resolution = mik__pwm_best_resolution(5000);

    ledc_timer_config_t timer_cfg = {};
    timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_cfg.duty_resolution = resolution;
    timer_cfg.timer_num = static_cast<ledc_timer_t>(timer);
    timer_cfg.freq_hz = 5000;
    timer_cfg.clk_cfg = LEDC_AUTO_CLK;
    TEST_ASSERT_EQUAL(ESP_OK, ledc_timer_config(&timer_cfg));

    ledc_channel_config_t ch_cfg = {};
    ch_cfg.gpio_num = PWM_PIN;
    ch_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_cfg.channel = static_cast<ledc_channel_t>(ch);
    ch_cfg.timer_sel = static_cast<ledc_timer_t>(timer);
    ch_cfg.duty = mik__pwm_duty_to_raw(0.5, resolution);
    ch_cfg.hpoint = 0;
    TEST_ASSERT_EQUAL(ESP_OK, ledc_channel_config(&ch_cfg));

    /* Let it run briefly */
    vTaskDelay(pdMS_TO_TICKS(50));

    /* Stop and release */
    ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch), 0);
    mik__pwm_free_channel(ch);
    mik__pwm_free_timer(timer);
}

TEST_CASE("PWM fade completes", "[pwm]") {
    int ch = mik__pwm_alloc_channel();
    int timer = mik__pwm_alloc_timer(5000);
    TEST_ASSERT_GREATER_OR_EQUAL(0, ch);
    TEST_ASSERT_GREATER_OR_EQUAL(0, timer);

    ledc_timer_bit_t resolution = mik__pwm_best_resolution(5000);

    ledc_timer_config_t timer_cfg = {};
    timer_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    timer_cfg.duty_resolution = resolution;
    timer_cfg.timer_num = static_cast<ledc_timer_t>(timer);
    timer_cfg.freq_hz = 5000;
    timer_cfg.clk_cfg = LEDC_AUTO_CLK;
    TEST_ASSERT_EQUAL(ESP_OK, ledc_timer_config(&timer_cfg));

    ledc_channel_config_t ch_cfg = {};
    ch_cfg.gpio_num = PWM_PIN;
    ch_cfg.speed_mode = LEDC_LOW_SPEED_MODE;
    ch_cfg.channel = static_cast<ledc_channel_t>(ch);
    ch_cfg.timer_sel = static_cast<ledc_timer_t>(timer);
    ch_cfg.duty = 0;
    ch_cfg.hpoint = 0;
    TEST_ASSERT_EQUAL(ESP_OK, ledc_channel_config(&ch_cfg));

    /* Install fade and run a short fade */
    ledc_fade_func_install(0);

    std::atomic<bool> fade_done{false};

    ledc_cbs_t cbs = {};
    cbs.fade_cb = [](const ledc_cb_param_t* param, void* arg) -> bool {
        if (param->event == LEDC_FADE_END_EVT) {
            static_cast<std::atomic<bool>*>(arg)->store(true, std::memory_order_release);
        }
        return false;
    };
    ledc_cb_register(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch), &cbs, &fade_done);

    uint32_t target = mik__pwm_duty_to_raw(1.0, resolution);
    TEST_ASSERT_EQUAL(ESP_OK,
                      ledc_set_fade_with_time(LEDC_LOW_SPEED_MODE,
                                              static_cast<ledc_channel_t>(ch), target, 100));
    TEST_ASSERT_EQUAL(ESP_OK,
                      ledc_fade_start(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch),
                                      LEDC_FADE_NO_WAIT));

    /* Wait for fade to complete (max 500ms) */
    for (int i = 0; i < 50; i++) {
        if (fade_done.load(std::memory_order_acquire)) break;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    TEST_ASSERT_TRUE(fade_done.load(std::memory_order_acquire));

    /* Cleanup */
    ledc_stop(LEDC_LOW_SPEED_MODE, static_cast<ledc_channel_t>(ch), 0);
    mik__pwm_free_channel(ch);
    mik__pwm_free_timer(timer);
}

/* ── mikro/pwm from JS ─────────────────────────────────────────────── */

#include "js_harness.h"

TEST_CASE("Pwm factory sets duty and freq and rejects bad values", "[pwm]") {
    js_harness::setup();
    js_harness::run(R"(
        import {Pwm} from 'mikro/pwm'
        const pwm = Pwm(TEST_GPIO, {freq: 5000, duty: 0.25}).orPanic('pwm')
        const got = [pwm.duty().value, pwm.duty(0.5).value, pwm.duty().value,
                     pwm.freq(1000).ok, pwm.freq().value, pwm.duty(2).error.name]
        const thrown = [() => Pwm(1.5, {freq: 50}), () => Pwm(TEST_GPIO),
                        () => Pwm(TEST_GPIO, {freq: '50'}), () => pwm.duty('1')].map((f) => {
            try { f() } catch (e) { return e.name }
        })
        pwm.end()
        const errors = [Pwm(TEST_GPIO, {freq: 0}), Pwm(TEST_GPIO, {freq: 50, duty: 2}),
                        Pwm(100, {freq: 50})].map((r) => r.error.name)
        globalThis.out = JSON.stringify([got, thrown, errors])
    )");
    TEST_ASSERT_EQUAL_STRING(
        "[[0.25,null,0.5,true,1000,\"InvalidParam\"],"
        "[\"TypeError\",\"TypeError\",\"TypeError\",\"TypeError\"],"
        "[\"InvalidParam\",\"InvalidParam\",\"InvalidGpio\"]]",
        js_harness::out().c_str());
    js_harness::teardown();
}

TEST_CASE("Pwm fade resolves with a Result when it completes", "[pwm]") {
    js_harness::setup();
    js_harness::run(R"(
        import {Pwm} from 'mikro/pwm'
        globalThis.pwm = Pwm(TEST_GPIO, {freq: 5000}).orPanic('pwm')
        globalThis.results = []
        pwm.fade(2, 10).then((r) => results.push(r.error.name))
        pwm.fade(1, 50).then((r) => results.push(r.ok))
    )");
    js_harness::loop_passes(30);
    js_harness::run(R"(
        globalThis.out = JSON.stringify([results, pwm.duty().value])
        pwm.end()
    )");
    TEST_ASSERT_EQUAL_STRING("[[\"InvalidParam\",true],1]", js_harness::out().c_str());
    js_harness::teardown();
}

TEST_CASE("Pwm end() settles a fade in progress and later calls do nothing", "[pwm]") {
    js_harness::setup();
    js_harness::run(R"(
        import {Pwm} from 'mikro/pwm'
        const pwm = Pwm(TEST_GPIO, {freq: 5000, duty: 0.25}).orPanic('pwm')
        globalThis.results = []
        pwm.fade(1, 5000).then((r) => results.push(r.ok))
        const ended = [pwm.end(), pwm.end()]
        const after = [pwm.duty().value, pwm.duty(0.5).ok, pwm.freq(10).ok, pwm.freq().value]
        pwm.fade(0, 10).then((r) => results.push(r.ok))
        globalThis.out = JSON.stringify([ended, after])
    )");
    js_harness::loop_passes(2);
    TEST_ASSERT_EQUAL_STRING("[[null,null],[1,true,true,5000]]", js_harness::out().c_str());
    js_harness::run(R"(globalThis.out = JSON.stringify(results))");
    TEST_ASSERT_EQUAL_STRING("[true,true]", js_harness::out().c_str());
    TEST_ASSERT_NULL(MIK_GpioOwner(TEST_GPIO));
    js_harness::teardown();
}

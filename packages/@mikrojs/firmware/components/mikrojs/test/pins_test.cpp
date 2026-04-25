#include "../mik_pin.cpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "quickjs.h"
#include "unity.h"

#define PIN CONFIG_MIKROJS_TEST_GPIO_PIN
TEST_CASE("Test write output", "[gpio]") {
    mik_gpio_set_pin_mode(PIN, GPIO_MODE_OUTPUT);
    mik_gpio_digital_write(PIN, 0);
    vTaskDelay(100 / portTICK_PERIOD_MS);
    mik_gpio_digital_write(PIN, 1);
}

TEST_CASE("digitalRead returns a value after write", "[gpio]") {
    mik_gpio_reset_pin(PIN);
    mik_gpio_set_pin_mode(PIN, GPIO_MODE_INPUT_OUTPUT);
    mik_gpio_digital_write(PIN, 1);
    TEST_ASSERT_EQUAL_INT(1, mik_gpio_digital_read(PIN));
    mik_gpio_digital_write(PIN, 0);
    TEST_ASSERT_EQUAL_INT(0, mik_gpio_digital_read(PIN));
}

#define ADC_PIN CONFIG_MIKROJS_TEST_ADC_PIN

TEST_CASE("analogRead returns a value in range", "[gpio]") {
    TEST_ASSERT_EQUAL(ESP_OK, mik_adc_ensure_init());
    int raw = mik_adc_read_raw(ADC_PIN, ADC_ATTEN_DB_12);
    TEST_ASSERT_GREATER_OR_EQUAL(0, raw);
    TEST_ASSERT_LESS_OR_EQUAL(4095, raw);
}

TEST_CASE("analogReadMillivolts returns a value", "[gpio]") {
    TEST_ASSERT_EQUAL(ESP_OK, mik_adc_ensure_init());
    int mv = mik_adc_read_millivolts(ADC_PIN, ADC_ATTEN_DB_12);
    TEST_ASSERT_GREATER_OR_EQUAL(0, mv);
}

TEST_CASE("analogRead works with all attenuations", "[gpio]") {
    TEST_ASSERT_EQUAL(ESP_OK, mik_adc_ensure_init());
    adc_atten_t attens[] = {ADC_ATTEN_DB_0, ADC_ATTEN_DB_2_5, ADC_ATTEN_DB_6, ADC_ATTEN_DB_12};
    for (int i = 0; i < 4; i++) {
        int raw = mik_adc_read_raw(ADC_PIN, attens[i]);
        TEST_ASSERT_GREATER_OR_EQUAL(0, raw);
        TEST_ASSERT_LESS_OR_EQUAL(4095, raw);
    }
}

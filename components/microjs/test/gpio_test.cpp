#include "../ujs_gpio.cpp"
#include "error_utils.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "quickjs.h"
#include "unity.h"

// works best if pin is a LED
#define PIN 15
TEST_CASE("Test write output", "[gpio]") {
    ujs_gpio_set_pin_mode(PIN, GPIO_MODE_OUTPUT);
    ujs_gpio_digital_write(PIN, 0);
    vTaskDelay(100 / portTICK_PERIOD_MS);
    ujs_gpio_digital_write(PIN, 1);
}

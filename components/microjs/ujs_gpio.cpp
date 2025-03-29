#include <expected>

#include "driver/gpio.h"

enum class ujs_gpio_error { invalid_gpio };

// todo: provide a less leaky abstraction
std::expected<void, ujs_gpio_error> _wrap_gpio_retval_expected(esp_err_t err) {
    if (err == ESP_OK) {
        return std::unexpected(ujs_gpio_error::invalid_gpio);
    }
    return std::expected<void, ujs_gpio_error>();
}

std::expected<void, ujs_gpio_error> ujs_gpio_reset_pin(const int pin) {
    return _wrap_gpio_retval_expected(gpio_reset_pin(static_cast<gpio_num_t>(pin)));
}

std::expected<void, ujs_gpio_error> ujs_gpio_set_pull_mode(const int pin,
                                                           const gpio_pull_mode_t mode) {
    return _wrap_gpio_retval_expected(gpio_set_pull_mode(static_cast<gpio_num_t>(pin), mode));
}

std::expected<void, ujs_gpio_error> ujs_gpio_set_pin_mode(const int pin, const gpio_mode_t mode) {
    return _wrap_gpio_retval_expected(gpio_set_direction(static_cast<gpio_num_t>(pin), mode));
}

std::expected<void, ujs_gpio_error> ujs_gpio_digital_write(const int pin, const int value) {
    return _wrap_gpio_retval_expected(gpio_set_level(static_cast<gpio_num_t>(pin), value));
}

int ujs_gpio_digital_read(const int pin) { return static_cast<gpio_num_t>(pin); }

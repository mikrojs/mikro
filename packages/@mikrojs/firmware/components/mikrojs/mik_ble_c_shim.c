/*
 * BLE C shim.
 *
 * esp_bt.h transitively pulls in hal/assert.h which defines
 *   #define __noreturn [[noreturn]]
 * The HAL chain then applies __noreturn to a type, which fails C++
 * -Wattributes (treated as -Werror in ESP-IDF's default build). Compiling
 * this in C sidesteps the attribute restriction entirely, so every
 * esp_bt.h-touching call mik_ble.cpp needs is wrapped here.
 */

#include "esp_bt.h"

#include "mik_ble_c_shim.h"

/* ── TX power ──────────────────────────────────────────────────────── */

/* Convert dBm <-> esp_power_level_t enum.
 * The enum spans -24 dBm (0) to +9 dBm (15) in 3 dBm steps on most ESP chips. */
static esp_power_level_t dbm_to_level(int dbm) {
    int level = (dbm + 24) / 3;
    if (level < 0) level = 0;
    if (level > 15) level = 15;
    return (esp_power_level_t)level;
}

static int level_to_dbm(esp_power_level_t level) {
    return (int)level * 3 - 24;
}

int mik_ble_get_tx_power_dbm(void) {
    esp_power_level_t level = esp_ble_tx_power_get(ESP_BLE_PWR_TYPE_ADV);
    return level_to_dbm(level);
}

int mik_ble_set_tx_power_dbm(int dbm) {
    esp_power_level_t level = dbm_to_level(dbm);
    esp_err_t err = esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV, level);
    if (err != ESP_OK) return (int)err;
    /* Also set the default power so any implicit advertising uses the new level. */
    esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, level);
    return 0;
}

/* ── Controller teardown ───────────────────────────────────────────── */

/* Disable the BT controller. Returns the esp_err_t code (0 on success).
 * Safe to call even if the controller is already disabled. */
int mik_ble_controller_disable(void) {
    esp_bt_controller_status_t status = esp_bt_controller_get_status();
    if (status != ESP_BT_CONTROLLER_STATUS_ENABLED) return 0;
    return (int)esp_bt_controller_disable();
}

/* Deinitialize the BT controller, freeing its RAM. Returns the esp_err_t
 * code (0 on success). Safe to call even if already deinitialized. */
int mik_ble_controller_deinit(void) {
    esp_bt_controller_status_t status = esp_bt_controller_get_status();
    if (status == ESP_BT_CONTROLLER_STATUS_IDLE) return 0;
    return (int)esp_bt_controller_deinit();
}

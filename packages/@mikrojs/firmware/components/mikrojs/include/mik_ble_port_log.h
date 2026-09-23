/* Logging for native:mikro/ble on ESP32 (mikrojs/ble_port.h). ESP-IDF's log
 * is safe on the NimBLE host task; the platform log hook is not, since it
 * formats on the caller's stack and writes the console itself. */
#pragma once

#include "esp_log.h"

#define MIK_BLE_TAG "native:mikro/ble"
#define MIK_BLE_LOGW(...) ESP_LOGW(MIK_BLE_TAG, __VA_ARGS__)
#define MIK_BLE_LOGE(...) ESP_LOGE(MIK_BLE_TAG, __VA_ARGS__)

/* The ESP32 side of native:mikro/ble (mikrojs/ble_port.h). ESP-IDF's NimBLE
 * brings the controller up in nimble_port_init and down in nimble_port_deinit. */

#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "mik_ble_c_shim.h"
#include "mikrojs/ble_port.h"
#include "mikrojs/errors.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

static void mik__ble_host_task(void* param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

int mik__ble_port_init(void) {
    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        MIK_BLE_LOGE("nimble_port_init failed: %d", err);
        return MIK_ERR_BLE_STACK_INIT_FAILED;
    }
    return 0;
}

void mik__ble_port_start_host(void) {
    nimble_port_freertos_init(mik__ble_host_task);
}

int mik__ble_port_stop(void) {
    int rc = nimble_port_stop();
    if (rc == 0) {
        nimble_port_deinit();
    } else {
        MIK_BLE_LOGW("nimble_port_stop failed: %d", rc);
    }
    /* Disable + deinit the BT controller to reclaim RAM. These calls live
     * in mik_ble_c_shim.c because esp_bt.h cannot be included from C++. */
    mik_ble_controller_disable();
    mik_ble_controller_deinit();
    /* Always 0: a failed nimble_port_stop is logged and the controller is
     * shut down all the same. */
    return 0;
}

int mik__ble_port_select_address(uint8_t* own_addr_type) {
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) return rc;
    return ble_hs_id_infer_auto(0, own_addr_type);
}

int mik__ble_port_address(uint8_t out[6]) {
    /* The BT MAC, from efuse. */
    return esp_read_mac(out, ESP_MAC_BT);
}

int mik__ble_port_get_tx_power(void) {
    return mik_ble_get_tx_power_dbm();
}

int mik__ble_port_set_tx_power(int dbm) {
    return mik_ble_set_tx_power_dbm(dbm);
}

void mik__ble_port_lock(void) {
    portENTER_CRITICAL(&s_mux);
}

void mik__ble_port_unlock(void) {
    portEXIT_CRITICAL(&s_mux);
}

/* The per-chip parts of native:mikro/ble. The module itself (src/mik_ble.cpp)
 * is NimBLE host code shared by every port; each port provides these hooks
 * for bringing its controller and NimBLE's port layer up and down, and for
 * what the host API does not cover. */
#pragma once

#include <stdint.h>

/* MIK_BLE_LOGW(fmt, ...) and MIK_BLE_LOGE(fmt, ...), from a header the port
 * has on its include path. Some call sites run on the NimBLE host task, so
 * the port picks a logger that is safe there. */
#include "mik_ble_port_log.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Starts the controller and NimBLE's port layer (nimble_port_init), so the
 * host API can register services. 0, or a MIK_ERR_BLE_* code. */
int mik__ble_port_init(void);

/* Starts the host: NimBLE runs its event loop and calls ble_hs_cfg.sync_cb
 * once the controller answers. */
void mik__ble_port_start_host(void);

/* Stops the host and the controller, with advertising and connections
 * already ended. The next mik__ble_port_init starts them again. 0, or a code
 * that stop() reports as StackShutdown. */
int mik__ble_port_stop(void);

/* Picks and sets the address the device advertises with, from the host's
 * sync callback. 0 with *own_addr_type set, or a NimBLE error code. */
int mik__ble_port_select_address(uint8_t* own_addr_type);

/* The address the device advertises with, most significant byte first,
 * whether or not the stack runs. 0, or the platform's error code. */
int mik__ble_port_address(uint8_t out[6]);

/* Advertising TX power in dBm. The setter returns 0, or the platform's error
 * code. */
int mik__ble_port_get_tx_power(void);
int mik__ble_port_set_tx_power(int dbm);

/* A short critical section around state the host task and the JS task share. */
void mik__ble_port_lock(void);
void mik__ble_port_unlock(void);

#ifdef __cplusplus
}
#endif

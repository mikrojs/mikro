#ifndef MIK_BLE_C_SHIM_H
#define MIK_BLE_C_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

/* ── TX power ──────────────────────────────────────────────────────── */

/** Returns the current BLE advertising TX power in dBm. */
int mik_ble_get_tx_power_dbm(void);

/**
 * Sets the BLE advertising (and default) TX power in dBm.
 * Returns 0 on success, or a non-zero esp_err_t code on failure.
 */
int mik_ble_set_tx_power_dbm(int dbm);

/* ── Controller teardown ───────────────────────────────────────────── */

/**
 * Disable the BT controller. Returns 0 on success or if already disabled,
 * or a non-zero esp_err_t code on failure.
 */
int mik_ble_controller_disable(void);

/**
 * Deinitialize the BT controller, freeing its RAM. Returns 0 on success
 * or if already deinitialized, or a non-zero esp_err_t code on failure.
 */
int mik_ble_controller_deinit(void);

#ifdef __cplusplus
}
#endif

#endif  // MIK_BLE_C_SHIM_H

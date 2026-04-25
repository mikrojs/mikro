#ifndef MIK_ERRORS_H
#define MIK_ERRORS_H

/**
 * mikrojs error codes.
 *
 * Platform-independent error codes starting at 0x8000 to avoid collision
 * with platform-specific error codes (ESP-IDF uses 0x1XX–0xXXXX).
 *
 * Native result error objects carry:
 *   - code:    mikrojs error code (always present)
 *   - message: human-readable description
 *   - errno:   platform error code (e.g. esp_err_t), only when non-zero
 */

#define MIK_ERR_BASE 0x8000

#define MIK_ERR_INVALID_PIN        (MIK_ERR_BASE + 1)
#define MIK_ERR_SET_MODE_FAILED    (MIK_ERR_BASE + 2)
#define MIK_ERR_WRITE_FAILED       (MIK_ERR_BASE + 3)
#define MIK_ERR_ADC_INIT_FAILED    (MIK_ERR_BASE + 4)
#define MIK_ERR_INVALID_ADC_PIN    (MIK_ERR_BASE + 5)
#define MIK_ERR_ADC_READ_FAILED    (MIK_ERR_BASE + 6)

/* I2C errors */
#define MIK_ERR_I2C_BUS_INIT      (MIK_ERR_BASE + 0x10)
#define MIK_ERR_I2C_BUS_DEINIT    (MIK_ERR_BASE + 0x11)
#define MIK_ERR_I2C_NOT_STARTED   (MIK_ERR_BASE + 0x12)
#define MIK_ERR_I2C_ADD_DEVICE    (MIK_ERR_BASE + 0x13)
#define MIK_ERR_I2C_WRITE         (MIK_ERR_BASE + 0x14)
#define MIK_ERR_I2C_READ          (MIK_ERR_BASE + 0x15)
#define MIK_ERR_I2C_WRITE_TOO_LARGE (MIK_ERR_BASE + 0x16)
#define MIK_ERR_I2C_MISSING_PINS  (MIK_ERR_BASE + 0x17)

/* WiFi errors */
#define MIK_ERR_WIFI_INIT_FAILED       (MIK_ERR_BASE + 0x20)
#define MIK_ERR_WIFI_START_FAILED      (MIK_ERR_BASE + 0x21)
#define MIK_ERR_WIFI_COUNTRY_NOT_SET   (MIK_ERR_BASE + 0x22)
#define MIK_ERR_WIFI_CONNECT_FAILED    (MIK_ERR_BASE + 0x23)
#define MIK_ERR_WIFI_CONNECT_IN_PROGRESS (MIK_ERR_BASE + 0x24)
#define MIK_ERR_WIFI_DISCONNECT_FAILED (MIK_ERR_BASE + 0x25)
#define MIK_ERR_WIFI_SCAN_FAILED       (MIK_ERR_BASE + 0x26)
#define MIK_ERR_WIFI_SCAN_IN_PROGRESS  (MIK_ERR_BASE + 0x27)
#define MIK_ERR_WIFI_NOT_INITIALIZED   (MIK_ERR_BASE + 0x28)
#define MIK_ERR_WIFI_CONFIG_FAILED     (MIK_ERR_BASE + 0x29)
#define MIK_ERR_WIFI_AP_START_FAILED   (MIK_ERR_BASE + 0x2A)
#define MIK_ERR_WIFI_AP_STOP_FAILED    (MIK_ERR_BASE + 0x2B)
#define MIK_ERR_WIFI_SET_FAILED        (MIK_ERR_BASE + 0x2C)
#define MIK_ERR_WIFI_GET_FAILED        (MIK_ERR_BASE + 0x2D)

/* SPI errors */
#define MIK_ERR_SPI_BUS_INIT      (MIK_ERR_BASE + 0x30)
#define MIK_ERR_SPI_ADD_DEVICE    (MIK_ERR_BASE + 0x31)
#define MIK_ERR_SPI_NOT_STARTED   (MIK_ERR_BASE + 0x32)
#define MIK_ERR_SPI_TRANSFER      (MIK_ERR_BASE + 0x33)
#define MIK_ERR_SPI_WRITE         (MIK_ERR_BASE + 0x34)
#define MIK_ERR_SPI_MISSING_PINS  (MIK_ERR_BASE + 0x35)

/* PWM errors */
#define MIK_ERR_PWM_NO_CHANNEL    (MIK_ERR_BASE + 0x40)
#define MIK_ERR_PWM_NO_TIMER      (MIK_ERR_BASE + 0x41)
#define MIK_ERR_PWM_CONFIG        (MIK_ERR_BASE + 0x42)
#define MIK_ERR_PWM_NOT_ACTIVE    (MIK_ERR_BASE + 0x43)
#define MIK_ERR_PWM_DUTY          (MIK_ERR_BASE + 0x44)
#define MIK_ERR_PWM_FREQ          (MIK_ERR_BASE + 0x45)
#define MIK_ERR_PWM_FADE          (MIK_ERR_BASE + 0x46)

/* Sleep errors */
#define MIK_ERR_SLEEP_WAKEUP_CONFIG   (MIK_ERR_BASE + 0x60)
#define MIK_ERR_SLEEP_LIGHT_SLEEP     (MIK_ERR_BASE + 0x61)
#define MIK_ERR_SLEEP_DISABLE_WAKEUP  (MIK_ERR_BASE + 0x62)

/* NeoPixel errors */
#define MIK_ERR_NEOPIXEL_NOT_ACTIVE   (MIK_ERR_BASE + 0x50)
#define MIK_ERR_NEOPIXEL_INDEX_RANGE  (MIK_ERR_BASE + 0x51)
#define MIK_ERR_NEOPIXEL_SHOW         (MIK_ERR_BASE + 0x52)

/* SNTP errors */
#define MIK_ERR_SNTP_INIT_FAILED      (MIK_ERR_BASE + 0x70)
#define MIK_ERR_SNTP_CANCELLED        (MIK_ERR_BASE + 0x71)

/* HTTP errors */
#define MIK_ERR_HTTP_TOO_MANY_PENDING (MIK_ERR_BASE + 0x80)
#define MIK_ERR_HTTP_TASK_FAILED      (MIK_ERR_BASE + 0x81)
#define MIK_ERR_HTTP_REQUEST_FAILED   (MIK_ERR_BASE + 0x82)
#define MIK_ERR_HTTP_CANCELLED        (MIK_ERR_BASE + 0x83)

/* CBOR errors */
#define MIK_ERR_CBOR_ENCODE           (MIK_ERR_BASE + 0x90)
#define MIK_ERR_CBOR_DECODE           (MIK_ERR_BASE + 0x91)

/* UART errors */
#define MIK_ERR_UART_DRIVER_INSTALL   (MIK_ERR_BASE + 0xA0)
#define MIK_ERR_UART_SET_PIN          (MIK_ERR_BASE + 0xA1)
#define MIK_ERR_UART_PARAM            (MIK_ERR_BASE + 0xA2)
#define MIK_ERR_UART_WRITE            (MIK_ERR_BASE + 0xA3)
#define MIK_ERR_UART_READ             (MIK_ERR_BASE + 0xA4)
#define MIK_ERR_UART_NOT_STARTED      (MIK_ERR_BASE + 0xA5)
#define MIK_ERR_UART_ALREADY_READING  (MIK_ERR_BASE + 0xA6)
#define MIK_ERR_UART_NO_RX            (MIK_ERR_BASE + 0xA7)
#define MIK_ERR_UART_NO_TX            (MIK_ERR_BASE + 0xA8)

/* BLE errors */
#define MIK_ERR_BLE_STACK_INIT_FAILED        (MIK_ERR_BASE + 0xB0)
#define MIK_ERR_BLE_CONTROLLER_INIT_FAILED   (MIK_ERR_BASE + 0xB1)
#define MIK_ERR_BLE_ADVERTISE_START_FAILED   (MIK_ERR_BASE + 0xB2)
#define MIK_ERR_BLE_ADVERTISE_STOP_FAILED    (MIK_ERR_BASE + 0xB3)
#define MIK_ERR_BLE_ALREADY_ADVERTISING      (MIK_ERR_BASE + 0xB4)
#define MIK_ERR_BLE_SET_FAILED               (MIK_ERR_BASE + 0xB5)
#define MIK_ERR_BLE_GET_FAILED               (MIK_ERR_BASE + 0xB6)
#define MIK_ERR_BLE_STACK_SHUTDOWN           (MIK_ERR_BASE + 0xB7)
#define MIK_ERR_BLE_NOT_INITIALIZED          (MIK_ERR_BASE + 0xB8)
#define MIK_ERR_BLE_INVALID_UUID             (MIK_ERR_BASE + 0xB9)
#define MIK_ERR_BLE_DUPLICATE_CHARACTERISTIC (MIK_ERR_BASE + 0xBA)
#define MIK_ERR_BLE_INVALID_PROPERTIES       (MIK_ERR_BASE + 0xBB)
#define MIK_ERR_BLE_GATT_REGISTRATION_FAILED (MIK_ERR_BASE + 0xBC)
#define MIK_ERR_BLE_GATT_ALREADY_REGISTERED  (MIK_ERR_BASE + 0xBD)
#define MIK_ERR_BLE_NO_SUCH_CHARACTERISTIC   (MIK_ERR_BASE + 0xBE)
#define MIK_ERR_BLE_NOT_CONNECTED            (MIK_ERR_BASE + 0xBF)
#define MIK_ERR_BLE_VALUE_TOO_LARGE          (MIK_ERR_BASE + 0xC0)
#define MIK_ERR_BLE_NOTIFY_FAILED            (MIK_ERR_BASE + 0xC1)

/* KV storage errors */
#define MIK_ERR_KV_INVALID_KEY   (MIK_ERR_BASE + 0xD0)
#define MIK_ERR_KV_ENCODE        (MIK_ERR_BASE + 0xD1)
#define MIK_ERR_KV_TOO_LARGE     (MIK_ERR_BASE + 0xD2)
#define MIK_ERR_KV_STORAGE_FULL  (MIK_ERR_BASE + 0xD3)
#define MIK_ERR_KV_WRITE         (MIK_ERR_BASE + 0xD4)

/* Filesystem errors — mikrojs/fs.
 * Codes cover the curated FSError variants. Anything unexpected at the
 * C/errno layer falls through to MIK_ERR_FS_UNKNOWN; the JS mapping layer
 * produces FSError.Unknown carrying the raw errno and message. */
#define MIK_ERR_FS_NOT_FOUND           (MIK_ERR_BASE + 0xE0)
#define MIK_ERR_FS_ALREADY_EXISTS      (MIK_ERR_BASE + 0xE1)
#define MIK_ERR_FS_ACCESS_DENIED       (MIK_ERR_BASE + 0xE2)
#define MIK_ERR_FS_NO_SPACE            (MIK_ERR_BASE + 0xE3)
#define MIK_ERR_FS_TOO_LARGE           (MIK_ERR_BASE + 0xE4)
#define MIK_ERR_FS_IS_DIRECTORY        (MIK_ERR_BASE + 0xE5)
#define MIK_ERR_FS_NOT_DIRECTORY       (MIK_ERR_BASE + 0xE6)
#define MIK_ERR_FS_BAD_FILE_DESCRIPTOR (MIK_ERR_BASE + 0xE7)
#define MIK_ERR_FS_UNKNOWN             (MIK_ERR_BASE + 0xE8)

#endif  // MIK_ERRORS_H

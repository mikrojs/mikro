/* ESP32-specific extensions to the mikrojs public API.
 * Include this alongside <mikrojs/mikrojs.h> for deploy, config, and serial I/O. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MIKRuntime MIKRuntime;

/* Default firmware entry point (mik_main.cpp).
 * Sets up console, NVS, LittleFS, JS runtime, and enters the event loop
 * with REPL, deploy, and config protocol support. */
void MIK_Main(void);

/* Deploy recovery (mik_deploy.cpp) */
void MIK_DeployRecover(void);

/* Safe-mode recovery window (mik_recovery.cpp).
 * Opens a brief window (typ. 500ms) right after console init that watches
 * for two triggers and returns true if either fires:
 *   1) Double-reset: an RTC_NOINIT magic word survives a soft reset that
 *      happens while the window is armed.
 *   2) Sync bytes: the host sends "MIKSAFE\n" over the console transport
 *      (mikro console --recover toggles RTS to reset and then floods this).
 * When true, the firmware should skip user-app autorun and drop to REPL. */
bool mik__check_recovery(int timeout_ms);

/* Console auto-detection (mik_serial_io.cpp).
 * On chips with USB Serial/JTAG, detects whether USB or UART is connected
 * and sets up the active console accordingly. Must be called early in app_main(). */
void mik__console_init(void);

/* Read from the active console.  Returns bytes read, 0 if no data, or -1. */
int mik__console_read(void* buf, size_t len);

/* Write to the active console.  Returns bytes written. */
int mik__console_write(const void* buf, size_t len);

/* Serial binary I/O (mik_serial_io.cpp) */
void mik__serial_binary_begin_no_echo(void);

/* Shared NVS helpers (mik_serial_io.cpp) */
extern const char* MIK__NVS_NS_ENV;  /* env var values */
extern const char* MIK__NVS_NS_SEC;  /* secret-flag markers (u8) */
/* ENV_FLAG_SECRET is defined in mikrojs/private.h as MIK_ENV_FLAG_SECRET */
void mik__nvs_clear_namespace(const char* ns);
bool mik__nvs_put_string(const char* ns, const char* key, const char* value);
bool mik__nvs_put_string_if_diff(const char* ns, const char* key, const char* value,
                                 bool* out_changed);
bool mik__nvs_is_secret(const char* key);
bool mik__nvs_set_secret_flag(const char* key, bool secret);
bool mik__nvs_env_set(const char* key, const char* value, bool secret, bool* out_changed);
bool mik__nvs_env_delete(const char* key);

/* Read NVS env vars and register them with the runtime via MIK_SetEnvVar() */
void MIK_LoadEnvFromNVS(MIKRuntime* mik_rt);

#ifdef __cplusplus
}
#endif

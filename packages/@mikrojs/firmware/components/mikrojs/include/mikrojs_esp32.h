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

/* Tap installed by mik_logfile so console output is mirrored into the
 * on-device log file. Called from mik__console_write before the actual
 * UART/USB-JTAG write, so output is captured even when no host is
 * attached. Single slot; mik_logfile owns it. */
typedef void (*mik_console_tap_fn)(const void* buf, size_t len);
void mik__console_set_tap(mik_console_tap_fn fn);

/* File logging (mik_logfile.cpp).
 * Initialized after MIK_LoadConfig once the filesystem is mounted.
 * No-op when MIKConfig.log_file is empty. */
typedef struct MIKConfig MIKConfig;
void mik_logfile_init(const MIKConfig* config);
void mik_logfile_close(void);
void mik_logfile_flush(void);
/* Release/restore the underlying FILE* so the host can read the file
 * without contention. Output between suspend/resume is dropped. No-op
 * when file logging is disabled. */
void mik_logfile_suspend(void);
void mik_logfile_resume(void);

/* Serial binary I/O (mik_serial_io.cpp) */
void mik__serial_binary_begin_no_echo(void);

/* Detach the USB Serial/JTAG peripheral from the host (uninstalls the
 * driver and disables the PHY pad) so the CLI sees a clean disconnect
 * before light sleep. No-op when the active console isn't USJ. */
void mik__serial_io_detach_usb(void);

/* Re-attach the USB Serial/JTAG peripheral after a prior detach. The
 * host re-enumerates the device. No-op when the active console isn't
 * USJ. */
void mik__serial_io_attach_usb(void);

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

#include <cerrno>
#include <stdio.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs_esp32.h"
#include "soc/soc_caps.h"
#include "soc/uart_pins.h"

#if SOC_USB_SERIAL_JTAG_SUPPORTED
#include "driver/usb_serial_jtag.h"
#include "esp_rom_sys.h"
#include "hal/usb_serial_jtag_ll.h"
/* mikrojs owns the USB-Serial/JTAG peripheral directly. Leaving
 * CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y would have ESP-IDF register a
 * VFS and write to the TX FIFO from stdio, racing our driver ISR. */
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#error "Set CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=n (see sdkconfig.defaults.esp32*)"
#endif
#endif

/* ── Console I/O ────────────────────────────────────────────────────
 *
 * Talks to UART0 and (where supported) the USB-Serial/JTAG peripheral
 * directly through the ESP-IDF driver API, deliberately skipping the
 * VFS / newlib stdio integration. Rationale:
 *
 *   - With `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`, ESP-IDF's startup
 *     code registers a USB-JTAG VFS, hooks it into newlib's stdio, and
 *     installs the driver before app_main() runs. On boards that cold-
 *     boot from battery, that early VFS/newlib setup has been observed
 *     to tip the supply past the brown-out threshold and lock the
 *     chip. Micropython avoids this by talking to the USB-JTAG
 *     hardware directly, never touching VFS; we do the same here but
 *     use the stable public driver API (`usb_serial_jtag_*_bytes`)
 *     instead of register-level LL calls, so the code survives IDF
 *     major-version bumps without rework.
 *
 *   - sdkconfig keeps `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=n` and
 *     `CONFIG_ESP_CONSOLE_UART_DEFAULT=y`. That makes UART0 the target
 *     of ESP_LOG/printf, but log output is already filtered to NONE in
 *     production. We manage both consoles ourselves.
 *
 *   - The active console latches to whichever interface receives the
 *     first byte from the host CLI (same UX as before).
 */

/* UART0 is always present on chips without USB-Serial/JTAG (plain
 * ESP32). On chips with USJ, it's installed only when the
 * CONFIG_MIKROJS_CONSOLE_FALLBACK_UART Kconfig is enabled (default
 * n). Enable it to get the auto-detect dev UX on boards where a
 * USB-TTL adapter is sometimes used instead of the native USB port;
 * costs ~4 KB DRAM + a UART ISR in IRAM. */
#if !SOC_USB_SERIAL_JTAG_SUPPORTED || CONFIG_MIKROJS_CONSOLE_FALLBACK_UART
#define MIK_CONSOLE_HAS_UART 1
#else
#define MIK_CONSOLE_HAS_UART 0
#endif

static enum { CONSOLE_UART, CONSOLE_USB_SERIAL_JTAG } s_console =
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    CONSOLE_USB_SERIAL_JTAG;
#else
    CONSOLE_UART;
#endif

#if SOC_USB_SERIAL_JTAG_SUPPORTED
static bool s_usj_installed = false;
#endif

#if SOC_USB_SERIAL_JTAG_SUPPORTED
/* Install USB-Serial/JTAG via the public driver API only. No VFS
 * registration, no `fileno(stdin)`, no newlib integration — that's
 * the whole point of this path.
 *
 * Both rings are sized to fit the largest single TLV frame plus a
 * little headroom for the next frame's header to land alongside it.
 *
 * RX (host → device): the largest single command frame is a
 * CMD_DEPLOY_PUT_CHUNK (≤ 2 KB body + 5 B header). Deploy PUTs no
 * longer carry the file body in one frame — they're streamed as
 * begin + N chunks with per-chunk MSG_OK pacing — so this size is
 * a function of the chunk size, not of the largest deployable file.
 * 4 KB gives ~2× headroom over a single chunk so the next command
 * can be queued behind it.
 *
 * TX (device → host): bumped from the IDF default (256 B) to 2 KB
 * so MSG_READY resends during the boot-handshake window don't fill
 * the ring before the CLI's TTY starts draining. At 256 B the ring
 * fills after ~3 MSG_READY sends, then subsequent writes (including
 * the MSG_OK response to the first CMD_RUNTIME_PAUSE) stall long
 * enough to blow past the CLI's 10 s pause timeout and force a
 * restart-and-retry on every `mikro dev`. 2 KB is still small
 * enough not to meaningfully dent RAM for display-heavy apps. */
static bool mik__usj_install_with_default_config(void) {
    usb_serial_jtag_driver_config_t usj_cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usj_cfg.rx_buffer_size = 4096;
    usj_cfg.tx_buffer_size = 2048;
    return usb_serial_jtag_driver_install(&usj_cfg) == ESP_OK;
}
#endif

void mik__console_init(void) {
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    s_usj_installed = mik__usj_install_with_default_config();
#endif

#if MIK_CONSOLE_HAS_UART
    /* UART0 for the primary (ESP32) or fallback (USJ-capable chips with
     * CONFIG_MIKROJS_CONSOLE_FALLBACK_UART=y) console path. Configured
     * explicitly because ESP_CONSOLE_UART_DEFAULT's startup code may
     * not leave the hardware in the state we want for raw read/write. */
    uart_config_t uart_config = {};
    uart_config.baud_rate = 115200;
    uart_config.data_bits = UART_DATA_8_BITS;
    uart_config.parity = UART_PARITY_DISABLE;
    uart_config.stop_bits = UART_STOP_BITS_1;
    uart_config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    uart_config.source_clk = UART_SCLK_DEFAULT;
    uart_param_config(UART_NUM_0, &uart_config);
    uart_set_pin(UART_NUM_0, U0TXD_GPIO_NUM, U0RXD_GPIO_NUM,
                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    /* IRAM ISR keeps UART alive during flash writes (LittleFS deploys). */
    uart_driver_install(UART_NUM_0, 4096, 0, 0, NULL, ESP_INTR_FLAG_IRAM);
#endif
}

int mik__console_read(void* buf, size_t len) {
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    if (s_console == CONSOLE_USB_SERIAL_JTAG) {
        if (s_usj_installed) {
            int n = usb_serial_jtag_read_bytes(buf, len, 0);
            if (n > 0) return n;
        }
#if MIK_CONSOLE_HAS_UART
        /* Auto-detect: probe UART0 too so the first byte on either
         * interface latches the active console. Once latched to UART
         * we stop probing USJ to avoid interleaving input streams. */
        int n = uart_read_bytes(UART_NUM_0, buf, len, 0);
        if (n > 0) {
            s_console = CONSOLE_UART;
            return n;
        }
#endif
        /* The REPL protocol treats 0 as EOF, so map "no data
         * available right now" to -1/EAGAIN like the old VFS
         * path did. */
        errno = EAGAIN;
        return -1;
    }
#endif
#if MIK_CONSOLE_HAS_UART
    int n = uart_read_bytes(UART_NUM_0, buf, len, 0);
    if (n == 0) {
        errno = EAGAIN;
        return -1;
    }
    return n;
#else
    errno = EAGAIN;
    return -1;
#endif
}

static mik_console_tap_fn s_console_tap = nullptr;

void mik__console_set_tap(mik_console_tap_fn fn) {
    s_console_tap = fn;
}

int mik__console_write(const void* buf, size_t len) {
    /* Mirror to file-log tap (if installed) before the host write. This
     * captures output even when USB-JTAG has no host attached. Skip the
     * tap while a TLV protocol frame is being written — the file logger
     * has a higher-level tap on the un-framed body via the log-emit
     * hook, so capturing the wire bytes here would just embed the
     * [type][len] header in the log file. */
    mik_console_tap_fn tap = s_console_tap;
    if (tap && !mik__proto_send_in_progress) tap(buf, len);
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    if (s_console == CONSOLE_USB_SERIAL_JTAG) {
        /* No host attached: the ring buffer would fill and block writes
         * forever. Drop silently so boot-time TLV sends (MSG_READY etc.)
         * don't stall on bus/battery-only power. */
        if (!s_usj_installed || !usb_serial_jtag_is_connected()) {
            return (int)len;
        }
        /* Chunk writes below the TX ring size. `usb_serial_jtag_write_bytes`
         * will not accept more than fits contiguously in the ring, so asking
         * for (say) 257 bytes of a 256-byte ring returns 0 every iteration
         * regardless of how fast the host drains. 64 sits well under any
         * reasonable ring config.
         *
         * Bail after ~10 s of zero-progress iterations (host gone AWOL) so
         * the runtime can't hang forever. */
        const size_t max_chunk = 64;
        const uint8_t* p = (const uint8_t*)buf;
        size_t remaining = len;
        int no_progress_ticks = 0;
        while (remaining > 0) {
            if (!usb_serial_jtag_is_connected()) return (int)len;
            size_t chunk = remaining < max_chunk ? remaining : max_chunk;
            int n = usb_serial_jtag_write_bytes(p, chunk, pdMS_TO_TICKS(200));
            if (n > 0) {
                p += n;
                remaining -= (size_t)n;
                no_progress_ticks = 0;
            } else if (++no_progress_ticks > 50) {
                return (int)len;
            }
        }
        return (int)len;
    }
#endif
#if MIK_CONSOLE_HAS_UART
    return uart_write_bytes(UART_NUM_0, buf, len);
#else
    /* No console backend installed — drop the bytes. */
    return (int)len;
#endif
}

/* ── Binary serial I/O ──────────────────────────────────────────── */

void mik__serial_binary_begin_no_echo(void) {
    esp_log_level_set("*", ESP_LOG_NONE);
    /* No line-ending translation to disable: we bypass VFS entirely,
     * so `\n` passes through unchanged on both USJ and UART paths. */
}

/* ── USB detach/attach for light sleep ─────────────────────────────
 *
 * Light sleep on USJ-console chips (C3, C6, S3, …) powers down the
 * digital peripheral domain but leaves the USB device enumerated on
 * the host. node-serialport doesn't see a close, so the CLI can't
 * tell the difference between "device is busy" and "device is asleep".
 *
 * To make the disconnect visible we uninstall the driver and pull
 * down the D+ pad before sleeping. On wake we restore the pad and
 * re-install the driver. The host re-enumerates, the CLI's existing
 * disconnect → reconnect path handles the rest. */

void mik__serial_io_detach_usb(void) {
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    if (s_console != CONSOLE_USB_SERIAL_JTAG) return;
    if (!s_usj_installed) return;

    /* USJ has no public flush API. A short delay covers TX-ring drain
     * for the typical log-line-sized writes we send before sleeping. */
    vTaskDelay(pdMS_TO_TICKS(20));

    usb_serial_jtag_driver_uninstall();
    s_usj_installed = false;

    /* Force a host-visible disconnect by overriding D+/D- pulls to
     * present SE0 on the bus. `usb_serial_jtag_ll_phy_enable_pad(false)`
     * (which ESP-IDF's own sleep prep uses) only gates the internal pad
     * routing for leakage — it does NOT release the host-visible 1.5 k
     * D+ pullup, so the host still sees the device enumerated. The
     * pull-override is the only mechanism in ESP-IDF v6.0.1 that
     * actually triggers a re-enumerate. C6 has no `_SUPPORT_LIGHT_SLEEP`
     * cap for USJ (IDF-6395 in soc_caps.h), so this is the supported
     * path.
     * Refs:
     *   components/hal/include/hal/usb_serial_jtag_ll.h
     *   docs.espressif.com/projects/esp-iot-solution/.../usb_serial_jtag.html
     */
    usb_serial_jtag_pull_override_vals_t off = {
        .dp_pu = 0,
        .dm_pu = 0,
        .dp_pd = 1,
        .dm_pd = 1,
    };
    usb_serial_jtag_ll_phy_enable_pull_override(&off);
    /* >2.5 ms of SE0 so the host registers a disconnect rather than a
     * USB suspend. 5 ms gives plenty of margin without meaningfully
     * delaying sleep entry. */
    esp_rom_delay_us(5000);
#endif
}

void mik__serial_io_attach_usb(void) {
#if SOC_USB_SERIAL_JTAG_SUPPORTED
    if (s_console != CONSOLE_USB_SERIAL_JTAG) return;
    if (s_usj_installed) return;

    /* `disable_pull_override` only flips `pad_pull_override` back to 0;
     * the `dp_pullup`/`dp_pulldown` register fields still hold the
     * disconnect values from detach (D+ pullup off, D+ pulldown on),
     * so the host sees no connect signal until the peripheral autopilots
     * — which only happens reliably once the driver is active. Drive
     * the override to an explicit "connect" state (D+ pullup on,
     * everything else off) first so the host sees J-state immediately,
     * install the driver while the override holds it, then release. */
    usb_serial_jtag_pull_override_vals_t connect = {
        .dp_pu = 1,
        .dm_pu = 0,
        .dp_pd = 0,
        .dm_pd = 0,
    };
    usb_serial_jtag_ll_phy_enable_pull_override(&connect);

    s_usj_installed = mik__usj_install_with_default_config();

    usb_serial_jtag_ll_phy_disable_pull_override();
#endif
}

/* ── NVS helpers ─────────────────────────────────────────────────── */

const char* MIK__NVS_NS_ENV = "mik.env";
const char* MIK__NVS_NS_SEC = "mik.sec";

void mik__nvs_clear_namespace(const char* ns) {
    nvs_handle_t handle;
    if (nvs_open(ns, NVS_READWRITE, &handle) == ESP_OK) {
        nvs_erase_all(handle);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

bool mik__nvs_put_string(const char* ns, const char* key, const char* value) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &handle);
    if (err != ESP_OK) return false;

    err = nvs_set_str(handle, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err == ESP_OK;
}

/* Write only if the value differs from what's already stored. `out_changed`
 * is set to true when the stored value ends up different than before, false
 * if the existing value already matched. Returns false on I/O failure. */
bool mik__nvs_put_string_if_diff(const char* ns, const char* key, const char* value,
                                 bool* out_changed) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(ns, NVS_READWRITE, &handle);
    if (err != ESP_OK) return false;

    bool changed = true;
    size_t existing_len = 0;
    if (nvs_get_str(handle, key, nullptr, &existing_len) == ESP_OK) {
        size_t new_len = strlen(value);
        if (existing_len == new_len + 1) {
            char buf[512];
            if (existing_len <= sizeof(buf) &&
                nvs_get_str(handle, key, buf, &existing_len) == ESP_OK) {
                changed = memcmp(buf, value, new_len) != 0;
            }
        }
    }

    if (changed) {
        err = nvs_set_str(handle, key, value);
        if (err == ESP_OK) {
            err = nvs_commit(handle);
        }
    }
    nvs_close(handle);

    if (out_changed) *out_changed = changed;
    return err == ESP_OK;
}

bool mik__nvs_is_secret(const char* key) {
    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_SEC, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    uint8_t val = 0;
    esp_err_t err = nvs_get_u8(handle, key, &val);
    nvs_close(handle);
    return err == ESP_OK && val == 1;
}

bool mik__nvs_set_secret_flag(const char* key, bool secret) {
    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_SEC, NVS_READWRITE, &handle) != ESP_OK) {
        return false;
    }
    esp_err_t err = secret ? nvs_set_u8(handle, key, 1) : nvs_erase_key(handle, key);
    /* Erasing a key that wasn't there is a no-op success for our purposes. */
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(handle);
    nvs_close(handle);
    return err == ESP_OK;
}

/* Sets the env var. `out_changed` reports whether the stored value or secret
 * flag ended up differing from before (true on first insert, on value change,
 * or on secret-flag flip). Returns false on I/O failure (env value or secret
 * flag); `out_changed` is left untouched when returning false. */
bool mik__nvs_env_set(const char* key, const char* value, bool secret, bool* out_changed) {
    bool was_secret = mik__nvs_is_secret(key);
    bool value_changed = false;
    if (!mik__nvs_put_string_if_diff(MIK__NVS_NS_ENV, key, value, &value_changed)) {
        return false;
    }
    if (was_secret != secret && !mik__nvs_set_secret_flag(key, secret)) {
        return false;
    }
    if (out_changed) *out_changed = value_changed || (was_secret != secret);
    return true;
}

/* Erases the env var. Returns true if the key existed before the call. */
bool mik__nvs_env_delete(const char* key) {
    bool existed = false;
    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_ENV, NVS_READWRITE, &handle) == ESP_OK) {
        size_t len = 0;
        if (nvs_get_str(handle, key, nullptr, &len) == ESP_OK) {
            existed = true;
        }
        nvs_erase_key(handle, key);
        nvs_commit(handle);
        nvs_close(handle);
    }
    mik__nvs_set_secret_flag(key, false);
    return existed;
}

/* ── NVS → MIK_SetEnvVar bridge ─────────────────────────────────── */

void MIK_LoadEnvFromNVS(MIKRuntime* mik_rt) {
    nvs_handle_t handle;
    if (nvs_open(MIK__NVS_NS_ENV, NVS_READONLY, &handle) != ESP_OK) {
        return;
    }

    nvs_iterator_t it = NULL;
    esp_err_t err = nvs_entry_find_in_handle(handle, NVS_TYPE_STR, &it);
    while (err == ESP_OK && it != NULL) {
        nvs_entry_info_t info;
        nvs_entry_info(it, &info);

        size_t len = 0;
        if (nvs_get_str(handle, info.key, NULL, &len) == ESP_OK) {
            char buf[512];
            if (len <= sizeof(buf) && nvs_get_str(handle, info.key, buf, &len) == ESP_OK) {
                MIK_SetEnvVar(mik_rt, info.key, buf);
            }
        }

        err = nvs_entry_next(&it);
    }
    nvs_release_iterator(it);
    nvs_close(handle);
}

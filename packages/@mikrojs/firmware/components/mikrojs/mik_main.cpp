#include <cerrno>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/time.h>
#include <unistd.h>

#include <cinttypes>

#include "esp_chip_info.h"
#include "esp_heap_caps.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "nvs_flash.h"

static const char* TAG = "mikrojs";

/* Apply the MIK_LOG_LEVEL env var (if set in NVS) to our log tags.
 *
 * The firmware compiles in all levels up to DEBUG
 * (CONFIG_LOG_MAXIMUM_LEVEL=4) but keeps the runtime default at NONE so
 * the serial console stays clean in production. Setting
 * `MIK_LOG_LEVEL=debug` (or info/warn/error/verbose) via `mikro env set`
 * flips the listed tags to that level on the next boot.
 *
 * We target specific tags rather than "*" to avoid flooding the output
 * with unrelated ESP-IDF subsystems (WiFi, lwIP, driver framework etc.).
 * Add more tags here if new mikrojs-component modules are introduced. */
static void mik__apply_nvs_log_level(void) {
    nvs_handle_t handle;
    if (nvs_open("mik.env", NVS_READONLY, &handle) != ESP_OK) return;

    char buf[16];
    size_t buf_len = sizeof(buf);
    esp_err_t err = nvs_get_str(handle, "MIK_LOG_LEVEL", buf, &buf_len);
    nvs_close(handle);
    if (err != ESP_OK) return;

    esp_log_level_t level;
    if (strcasecmp(buf, "error") == 0) {
        level = ESP_LOG_ERROR;
    } else if (strcasecmp(buf, "warn") == 0 || strcasecmp(buf, "warning") == 0) {
        level = ESP_LOG_WARN;
    } else if (strcasecmp(buf, "info") == 0) {
        level = ESP_LOG_INFO;
    } else if (strcasecmp(buf, "debug") == 0) {
        level = ESP_LOG_DEBUG;
    } else if (strcasecmp(buf, "verbose") == 0 || strcasecmp(buf, "trace") == 0) {
        level = ESP_LOG_VERBOSE;
    } else {
        return; /* unknown value — leave defaults alone */
    }

    esp_log_level_set("mikrojs", level);
    esp_log_level_set("mik_repl", level);
    esp_log_level_set("mik_app_config", level);
}

/* File-scope scratch buffers for the supervisor loop.
 *
 * Kept off the stack because the main task stack is ~24 KB and cannot
 * accommodate 1-2 KB of local buffers on top of the nested eval/module
 * normalizer call chain (observed as a stack-protection fault in
 * mik_module_normalizer on the first test file). Fixed sizes instead of
 * PATH_MAX scaling — on newlib PATH_MAX can be 4096, which is absurd for
 * our purposes and would still blow the BSS budget. These sizes fit any
 * realistic on-device test path. Only one test manifest runs per boot,
 * so single-ownership is safe. */
#define MIK_SUP_PATH_MAX 384
static char s_sup_dbg[MIK_SUP_PATH_MAX + 64];
static char s_sup_esc[MIK_SUP_PATH_MAX * 2 + 8];
static char s_sup_buf[MIK_SUP_PATH_MAX * 2 + 512];
/* Exception text captured by MIK_RunEntryErr when a test file fails to
 * evaluate, and its JSON-escaped form for the synthesized test event. */
static char s_sup_err[192];
static char s_sup_err_esc[sizeof(s_sup_err) * 2 + 8];

/* Minimal JSON string-escape into a bounded buffer. Handles `"`, `\`, and
 * control characters; everything else copies verbatim. Returns bytes
 * written (excluding NUL) on success, or -1 on overflow. Used to synthesize
 * test-event JSON frames from raw C strings where the path may contain
 * characters that would otherwise corrupt the frame. */
static int mik__json_escape(char* dst, size_t dst_size, const char* src) {
    if (dst_size == 0) return -1;
    size_t w = 0;
    for (const unsigned char* p = (const unsigned char*)src; *p; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') {
            if (w + 2 >= dst_size) return -1;
            dst[w++] = '\\';
            dst[w++] = (char)c;
        } else if (c < 0x20) {
            if (w + 7 >= dst_size) return -1;
            int n = snprintf(dst + w, dst_size - w, "\\u%04x", c);
            if (n < 0 || (size_t)n >= dst_size - w) return -1;
            w += (size_t)n;
        } else {
            if (w + 1 >= dst_size) return -1;
            dst[w++] = (char)c;
        }
    }
    if (w >= dst_size) return -1;
    dst[w] = '\0';
    return (int)w;
}

/* ── Serial transport ───────────────────────────────────────────── */

static int serial_transport_read(uint8_t* buf, size_t size, void* ctx) {
    (void)ctx;
    return mik__console_read(buf, size);
}

static void serial_transport_write(const void* buf, size_t len, void* ctx) {
    (void)ctx;
    mik__console_write(buf, len);
}

/* ── Platform command handler (deploy, config, restart) ─────────── */

/* Forward declarations for deploy and config handlers.
 * These receive the TLV header info but must read the payload bytes
 * themselves from the transport via mik__proto_read_exact(). */
bool mik__handle_deploy_command(MIKReplTransport* transport, uint8_t cmd_type,
                                uint32_t payload_len);
bool mik__handle_config_command(MIKReplTransport* transport, uint8_t cmd_type,
                                uint32_t payload_len);
bool mik__handle_fs_get(MIKReplTransport* transport, uint32_t payload_len);
void mik__deploy_session_reset(void);

static void platform_session_end(void* ctx) {
    (void)ctx;
    mik__deploy_session_reset();
    /* Safety net: if the CLI paused the runtime via CMD_RUNTIME_PAUSE and
     * disconnected before sending RESUME or RESTART, the app would stay
     * frozen until the next reboot. Always resume on session end. */
    mik__repl_set_paused(false);
}

static bool platform_command_handler(MIKReplTransport* transport, uint8_t cmd_type,
                                     uint32_t payload_len, void* ctx) {
    (void)ctx;

    /* Restart: drain payload (should be 0), then restart */
    if (cmd_type == MIK_CMD_RESTART) {
        mik__proto_drain(transport, payload_len);
        esp_restart();
        return true; /* unreachable */
    }

    /* Runtime pause/resume: freeze the JS event loop so user code can't
     * interleave log output with TLV frames during a deploy. */
    if (cmd_type == MIK_CMD_RUNTIME_PAUSE || cmd_type == MIK_CMD_RUNTIME_RESUME) {
        mik__proto_drain(transport, payload_len);
        mik__repl_set_paused(cmd_type == MIK_CMD_RUNTIME_PAUSE);
        mik__proto_send_ok(transport);
        return true;
    }

    /* Deploy commands (0x20-0x27) */
    if (cmd_type >= MIK_CMD_DEPLOY_PUT && cmd_type <= MIK_CMD_DEPLOY_CHECKSUM) {
        return mik__handle_deploy_command(transport, cmd_type, payload_len);
    }

    /* File pull (0x2B) */
    if (cmd_type == MIK_CMD_FS_GET) {
        return mik__handle_fs_get(transport, payload_len);
    }

    /* Log reset (0x2C): clear the on-device log files */
    if (cmd_type == MIK_CMD_LOG_RESET) {
        mik__proto_drain(transport, payload_len);
        mik_logfile_reset();
        mik__proto_send_ok(transport);
        return true;
    }

    /* Config commands (0x40-0x42) */
    if (cmd_type >= MIK_CMD_CONFIG_LIST && cmd_type <= MIK_CMD_CONFIG_DELETE) {
        return mik__handle_config_command(transport, cmd_type, payload_len);
    }

    /* Unknown command: drain payload to stay in sync */
    mik__proto_drain(transport, payload_len);
    return false;
}

/* ── LittleFS mount ─────────────────────────────────────────────── */

static esp_err_t mount_littlefs(const char* base_path, const char* partition_label) {
    esp_vfs_littlefs_conf_t conf = {};
    conf.base_path = base_path;
    conf.partition_label = partition_label;
    conf.format_if_mount_failed = true;

    esp_err_t ret = esp_vfs_littlefs_register(&conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to mount LittleFS partition '%s' at '%s': %s", partition_label,
                 base_path, esp_err_to_name(ret));
    } else {
        ESP_LOGI(TAG, "Mounted LittleFS partition '%s' at '%s'", partition_label, base_path);
    }
    return ret;
}

/* ── Main entry point ───────────────────────────────────────────── */

void MIK_Main(void) {
    /* Detect whether USB Serial/JTAG or UART is connected and set up
     * the active console.  On chips with USB Serial/JTAG this checks
     * for USB SOF packets; if absent it falls back to UART. */
    mik__console_init();

    /* Gather chip/feature info early — cheap, no side effects, used to
     * print the banner AFTER runtime init succeeds. We deliberately defer
     * the banner until everything is up so its mere presence signals
     * "mikrojs is alive and the JS runtime is ready." If anything between
     * here and the printf below crashes or aborts, the banner doesn't
     * print — the absence IS the diagnostic.
     *
     * Feature advertising: we only include features for which mikrojs has
     * an actual JS API. ESP-IDF Kconfig flags like CONFIG_IEEE802154_ENABLED
     * get set by default on capable silicon (e.g. ESP32-C6) just because
     * the low-level radio driver is linked, even when no higher-level
     * stack is compiled in. WiFi and BLE each require both silicon support
     * and a corresponding `mikrojs/wifi`/`mikrojs/ble` JS module — we gate
     * on the CONFIG_* flags as a proxy. 802.15.4 is deliberately omitted
     * until a `mikrojs/zigbee` or `mikrojs/thread` module ships. */
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);

#if CONFIG_ESP_WIFI_ENABLED
    bool has_wifi = (chip_info.features & CHIP_FEATURE_WIFI_BGN) != 0;
#else
    bool has_wifi = false;
#endif
#if CONFIG_BT_ENABLED
    bool has_bt = (chip_info.features & CHIP_FEATURE_BT) != 0;
    bool has_ble = (chip_info.features & CHIP_FEATURE_BLE) != 0;
#else
    bool has_bt = false;
    bool has_ble = false;
#endif

    /* Capture starting heap for the later runtime-cost INFO log. */
    size_t heap_free_at_boot = esp_get_free_heap_size();
    size_t heap_total_at_boot = heap_free_at_boot;
    {
        multi_heap_info_t info;
        heap_caps_get_info(&info, MALLOC_CAP_8BIT);
        heap_total_at_boot = info.total_free_bytes + info.total_allocated_bytes;
    }

    /* Recovery window: gives the host (or a double-reset) a chance to
     * skip the autorun if the deployed app is crash-looping.  Costs ~500ms
     * on every cold boot but is the only window we have before user code
     * runs and may panic. */
    bool safe_mode = mik__check_recovery(500);
    if (safe_mode) {
        printf("\n*** SAFE MODE: autorun skipped, dropping to REPL ***\n\n");
    }

    /* Initialize NVS (needed for env vars, secrets, and WiFi) */
    {
        esp_err_t err = nvs_flash_init();
        if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
            nvs_flash_erase();
            err = nvs_flash_init();
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "NVS init failed: %s", esp_err_to_name(err));
        }
    }

    /* Apply MIK_LOG_LEVEL from NVS as early as possible so subsequent
     * initialization logs respect the configured level. */
    mik__apply_nvs_log_level();

    /* Mount filesystem */
    if (mount_littlefs("/appfs", "user") != ESP_OK) {
        ESP_LOGE(TAG, "Cannot mount /appfs partition, aborting");
        return;
    }

    /* Recover from incomplete deploys */
    MIK_DeployRecover();

    /* Load app config (mikro.config.json) if present */
    MIKConfig app_config;
    MIK_LoadConfig("/appfs", &app_config);

    /* Start file logging if configured (no-op when log_file is empty). */
    mik_logfile_init(&app_config);

    /* Create JS runtime — reserve heap for WiFi, TLS, HTTP, LittleFS, and other
     * ESP-IDF subsystems that allocate after the runtime is created.
     * WiFi + lwIP ≈ 50-65 KB, TLS ≈ 40 KB, HTTP task ≈ 8 KB, misc ≈ 15 KB. */
    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    uint32_t free_heap = esp_get_free_heap_size();
    uint32_t reserved = app_config.mem_reserved;
    if (free_heap < reserved) {
        ESP_LOGE(TAG, "Not enough memory to start JS runtime (free: %" PRIu32
                      ", need: %" PRIu32 ")",
                 free_heap, reserved);
        return;
    }
    options.mem_limit = (int)(free_heap - reserved);
    /* QuickJS's stack overflow check compares the current SP against
     * (stack_top − stack_size). The library default (1 MB) assumes a desktop
     * stack and leaves the limit far below the real task stack bottom, so the
     * hardware faults before QuickJS can throw. Cap at ~2/3 of the main task
     * stack to leave headroom for the throw path itself. */
    options.stack_size = (CONFIG_ESP_MAIN_TASK_STACK_SIZE * 2) / 3;
    if (app_config.stack_size > 0) {
        options.stack_size = app_config.stack_size;
    }
#ifdef CONFIG_MIKROJS_QUICKJS_HEAP_PSRAM
    options.use_psram_heap = true;
#endif

    auto create_runtime = [&]() -> MIKRuntime* {
        MIKRuntime* rt = MIK_NewRuntimeOptions(&options);
        MIK_LoadEnvFromNVS(rt);
        MIK_RebuildEnv(rt);
        MIK_SetFSBasePath(rt, "/appfs");
        MIK_SetConfig(rt, &app_config);
        return rt;
    };

    MIKRuntime* mik_rt = create_runtime();

    /* ── Boot banner ──
     * Printed here, AFTER the runtime is fully initialized and the app
     * config is applied, because its mere presence signals "everything
     * came up successfully." If a step earlier in boot panicked or
     * aborted, the banner doesn't print — the absence is the diagnostic.
     *
     * Two lines: first identifies the device (version, chip, cores,
     * radios), second reports free app heap.
     *
     * The "free app heap" number is QuickJS's `malloc_limit − malloc_size`
     * immediately after runtime init — i.e. how much the user's JS code
     * can still allocate before hitting the configured soft cap. This is
     * the number users actually care about when they see "out of memory."
     * It's distinct from raw system heap, which includes memory reserved
     * for native subsystems (WiFi/lwIP/TLS) and already counts the
     * ~78 KB cold-start floor (QuickJS atoms + class tables + builtin
     * bytecode) that's unavailable for user allocations. */
    {
        /* Build the banner into a local buffer and push it through
         * mik__console_write so it lands on the user-visible console
         * (USB-Serial/JTAG). `printf` goes to newlib stdio, which
         * ESP-IDF routes to UART0 and is invisible over USB. */
        const char* core_word = chip_info.cores == 1 ? "core" : "cores";
        const MIKPlatform* plat = MIK_GetPlatform();
        const char* dev_id = plat->get_device_id ? plat->get_device_id() : nullptr;
        char banner[160];
        int off = 0;
#ifdef MIK_FW_VERSION
        off += snprintf(banner + off, sizeof(banner) - off, "Mikro.js v%s on %s", MIK_FW_VERSION,
                        CONFIG_IDF_TARGET);
#else
        off += snprintf(banner + off, sizeof(banner) - off, "Mikro.js on %s", CONFIG_IDF_TARGET);
#endif
        /* Stable per-board device id (chip MAC as Crockford Base32). */
        if (dev_id && dev_id[0]) {
            off += snprintf(banner + off, sizeof(banner) - off, " (%s)", dev_id);
        }
        off += snprintf(banner + off, sizeof(banner) - off, ", %d %s", chip_info.cores, core_word);
        if (has_wifi || has_bt || has_ble) {
            off += snprintf(banner + off, sizeof(banner) - off, ", ");
            bool first = true;
            if (has_wifi) {
                off += snprintf(banner + off, sizeof(banner) - off, "WiFi");
                first = false;
            }
            if (has_bt) {
                off += snprintf(banner + off, sizeof(banner) - off, "%sBT", first ? "" : "/");
                first = false;
            }
            if (has_ble) {
                off += snprintf(banner + off, sizeof(banner) - off, "%sBLE", first ? "" : "/");
            }
        }
        off += snprintf(banner + off, sizeof(banner) - off, "\n");
        if (off > 0 && off < (int)sizeof(banner)) {
            mik__console_write(banner, (size_t)off);
        }

        JSMemoryUsage mem;
        JS_ComputeMemoryUsage(JS_GetRuntime(MIK_GetJSContext(mik_rt)), &mem);
        long heap_available =
            mem.malloc_limit > 0 ? (long)mem.malloc_limit - (long)mem.malloc_size : 0;
        char heap_line[48];
        int hl = snprintf(heap_line, sizeof(heap_line), "%.0f KB free heap\n",
                          heap_available / 1024.0);
        if (hl > 0 && hl < (int)sizeof(heap_line)) {
            mik__console_write(heap_line, (size_t)hl);
        }
    }

    /* Detailed memory breakdown, gated behind INFO logging. The banner
     * already shows the headline "free app heap" number; these logs add
     * the detail you want when diagnosing OOM or tuning memReserved, but
     * would be noise on every normal boot. Set `mikro env set
     * MIK_LOG_LEVEL info` to see them. */
    const MIKPlatform* platform = MIK_GetPlatform();
    {
        size_t heap_free_now = esp_get_free_heap_size();
        size_t runtime_cost =
            heap_free_at_boot > heap_free_now ? (heap_free_at_boot - heap_free_now) : 0;
        platform->log(MIK_LOG_INFO, "mikrojs",
                      "System heap: %.1f / %.1f KB free (runtime init used %.1f KB)",
                      heap_free_now / 1024.0, (double)heap_total_at_boot / 1024.0,
                      runtime_cost / 1024.0);

        JSMemoryUsage mem;
        JS_ComputeMemoryUsage(JS_GetRuntime(MIK_GetJSContext(mik_rt)), &mem);
        if (mem.malloc_limit > 0) {
            double used_pct = (double)mem.malloc_size / (double)mem.malloc_limit * 100.0;
            long available = (long)mem.malloc_limit - (long)mem.malloc_size;
            platform->log(MIK_LOG_INFO, "mikrojs",
                          "App heap: %.1f KB available (%.1f / %.1f KB used, %.0f%%)",
                          available / 1024.0, mem.malloc_size / 1024.0,
                          mem.malloc_limit / 1024.0, used_pct);
        }
    }

    /* Enter binary serial mode (suppresses ESP logging, disables line-ending
     * translation) and switch to unified protocol mode. From here on,
     * everything goes through TLV framing — including app console output. */
    mik__serial_binary_begin_no_echo();

    MIKReplTransport transport = {};
    transport.read = serial_transport_read;
    transport.write = serial_transport_write;
    transport.ctx = nullptr;
    transport.chip_name = CONFIG_IDF_TARGET;
    transport.command_handler = platform_command_handler;
    transport.command_handler_ctx = nullptr;
    transport.session_end = platform_session_end;
    transport.session_end_ctx = nullptr;

    /* Test-harness mode: if package.json carries a non-empty "tests" array,
     * run each listed file in its own fresh runtime through one transport
     * session. The test runtime calls __testFileDone after emitting its
     * final run_done event, which signals MIK_ProtocolExit so the serve
     * loop returns and the supervisor can swap in the next runtime.
     * Skipped in safe mode. */
    char** test_paths = nullptr;
    size_t test_count = 0;
    if (!safe_mode) {
        MIK_LoadTests("/appfs", &test_paths, &test_count);
    }
    bool test_mode = test_count > 0;

    /* Open the protocol session. In test mode we'll attach/detach per
     * test runtime; otherwise we attach the single primary runtime. */
    MIK_ProtocolOpen(&transport);

    if (test_mode) {
        /* Discard the primary runtime — each test gets a fresh one. */
        MIK_FreeRuntime(mik_rt);
        mik_rt = nullptr;

        for (size_t i = 0; i < test_count; i++) {
            /* Diagnostic: announce the file about to run so the CLI can
             * confirm the supervisor's iteration matches its own testFiles
             * order. The MSG_DEBUG frame is rendered as a dim log line.
             * Uses file-scope s_sup_dbg to avoid bloating the main task
             * stack — the normalizer call chain during module resolution
             * already sits a few KB deep. */
            {
                int n = snprintf(s_sup_dbg, sizeof(s_sup_dbg),
                                 "[supervisor] running %zu/%zu: %s", i + 1, test_count,
                                 test_paths[i]);
                if (n > 0 && n < (int)sizeof(s_sup_dbg)) {
                    mik__proto_send(&transport, MIK_MSG_DEBUG, s_sup_dbg, n);
                }
            }
            MIKRuntime* rt = create_runtime();
            MIK_EnableTestHelpers(rt);
            MIK_ProtocolAttach(rt);
            int rc = MIK_RunEntryErr(rt, test_paths[i], s_sup_err, sizeof(s_sup_err));
            const char* fail_reason = nullptr;
            if (rc == -ENOENT) {
                fail_reason = "Test file not found";
            } else if (rc == -EFAULT) {
                fail_reason = "Evaluation threw";
            } else {
                /* Entry eval returned successfully (rc == 0). The test module
                 * may still asynchronously reject (e.g. top-level throw in a
                 * module eval'd as a Promise) — that's caught after ServeLoop
                 * by inspecting MIK_IsStopRequested below. */
                MIK_ProtocolServeLoop();
                if (MIK_IsStopRequested(rt)) {
                    fail_reason = "Unhandled rejection";
                }
            }
            if (fail_reason) {
                /* Synthesize a failing test + run_done so the CLI accounts
                 * for this file instead of stalling waiting for a run_done
                 * the runtime will never emit. Escape the path so any `"`
                 * or `\` in it doesn't corrupt the JSON frame. */
                ESP_LOGE(TAG, "%s: %s", fail_reason, test_paths[i]);
                if (mik__json_escape(s_sup_esc, sizeof(s_sup_esc), test_paths[i]) < 0) {
                    /* Path too long to fit even escaped — fall back to
                     * basename so the frame at least identifies something. */
                    const char* base = strrchr(test_paths[i], '/');
                    if (!base ||
                        mik__json_escape(s_sup_esc, sizeof(s_sup_esc), base + 1) < 0) {
                        s_sup_esc[0] = '?';
                        s_sup_esc[1] = '\0';
                    }
                }
                /* Append the captured exception text (escaped) so the CLI
                 * shows the actual error, not just "Evaluation threw". */
                s_sup_err_esc[0] = '\0';
                if (rc == -EFAULT && s_sup_err[0] != '\0') {
                    if (mik__json_escape(s_sup_err_esc, sizeof(s_sup_err_esc), s_sup_err) < 0) {
                        s_sup_err_esc[0] = '\0';
                    }
                }
                int n;
                if (s_sup_err_esc[0] != '\0') {
                    n = snprintf(s_sup_buf, sizeof(s_sup_buf),
                                 "{\"e\":3,\"s\":\"<load>\",\"t\":\"%s\",\"d\":0,"
                                 "\"m\":\"%s: %s\"}",
                                 s_sup_esc, fail_reason, s_sup_err_esc);
                } else {
                    n = snprintf(s_sup_buf, sizeof(s_sup_buf),
                                 "{\"e\":3,\"s\":\"<load>\",\"t\":\"%s\",\"d\":0,"
                                 "\"m\":\"%s\"}",
                                 s_sup_esc, fail_reason);
                }
                if (n > 0 && n < (int)sizeof(s_sup_buf)) {
                    mik__proto_send(&transport, MIK_MSG_TEST, s_sup_buf, n);
                }
                static const char kRunDone[] =
                    "{\"e\":6,\"p\":0,\"f\":1,\"k\":0,\"o\":0,\"d\":0}";
                mik__proto_send(&transport, MIK_MSG_TEST, kRunDone, sizeof(kRunDone) - 1);
            }
            MIK_ProtocolDetach();
            MIK_FreeRuntime(rt);
        }

        /* Signal end-of-manifest so the CLI can finalize its report
         * without waiting on a silent stream. */
        mik__proto_send(&transport, MIK_MSG_MANIFEST_DONE, nullptr, 0);

        /* Keep the session alive for REPL / deploy commands. */
        mik_rt = create_runtime();
        MIK_ProtocolAttach(mik_rt);
    } else {
        /* Normal mode: attach primary runtime and evaluate the main entry. */
        MIK_ProtocolAttach(mik_rt);

        if (safe_mode) {
            ESP_LOGW(TAG, "Safe mode: skipping entry point %s", app_config.entry_point);
        } else {
            int rc = MIK_RunEntry(mik_rt, app_config.entry_point);
            if (rc == -EINVAL) {
                ESP_LOGW(TAG, "No entry point configured (no \"main\" field in package.json)");
            } else if (rc == -ENOENT) {
                ESP_LOGW(TAG, "Entry point not found: %s", app_config.entry_point);
            } else if (rc == -EFAULT) {
                ESP_LOGE(TAG, "Failed to evaluate %s", app_config.entry_point);
            }
        }
    }

    /* Serve until transport error or CMD_EXIT. */
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_FreeRuntime(mik_rt);
    MIK_ProtocolClose();
    MIK_FreeTests(test_paths, test_count);

    /* If we get here, the transport died. Restart. */
    esp_restart();
}

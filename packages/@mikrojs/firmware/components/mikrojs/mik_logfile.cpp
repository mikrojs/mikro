#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs_esp32.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char* TAG = "mik_logfile";

/* Static buffers — total ~1.5 KiB plus a FreeRTOS mutex. */
static char s_line_buf[512];        /* current line being assembled */
static char s_stdio_buf[1024];      /* setvbuf target for the FILE* */
static char s_path_main[96];        /* "<dir>/log.txt"   */
static char s_path_rot[100];        /* "<dir>/log.txt.1" */
static SemaphoreHandle_t s_mtx = nullptr;
static FILE* s_file = nullptr;
static size_t s_file_size = 0;
static size_t s_line_pos = 0;
static bool s_line_has_ts = false;
static uint32_t s_max_size = 0;
static MIKLogFlush s_flush_policy = MIK_LOG_FLUSH_ERROR;
static vprintf_like_t s_prev_vprintf = nullptr;

/* Time threshold for treating the RTC as wall-clock-set (Jan 1 2020). */
static const time_t WALL_CLOCK_THRESHOLD = 1577836800;

static int format_timestamp(char* buf, size_t buf_size) {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    if (tv.tv_sec > WALL_CLOCK_THRESHOLD) {
        struct tm tm;
        gmtime_r(&tv.tv_sec, &tm);
        return snprintf(buf, buf_size, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ ",
                        tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min,
                        tm.tm_sec, (long)(tv.tv_usec / 1000));
    }
    int64_t us = esp_timer_get_time();
    int64_t s = us / 1000000;
    int64_t ms = (us / 1000) % 1000;
    return snprintf(buf, buf_size, "[+%lld.%03llds] ", (long long)s, (long long)ms);
}

/* Recognize lines that should trigger an immediate fflush under flush='error'.
 * Patterns: ESP_LOG ("E (12345)" / "W (12345)") and mikrojs platform.log
 * ("[ERROR]" / "[WARN]"). False negatives just delay the flush — they don't
 * lose data — so a conservative match is fine. */
static bool line_is_error_level(const char* line, size_t len) {
    if (len >= 2 && (line[0] == 'E' || line[0] == 'W') && line[1] == ' ') return true;
    if (len >= 7 && memcmp(line, "[ERROR]", 7) == 0) return true;
    if (len >= 6 && memcmp(line, "[WARN]", 6) == 0) return true;
    return false;
}

/* Caller holds s_mtx. */
static void rotate_if_needed() {
    if (s_file_size < s_max_size) return;
    fclose(s_file);
    s_file = nullptr;
    unlink(s_path_rot);
    rename(s_path_main, s_path_rot);
    s_file = fopen(s_path_main, "a");
    if (s_file) {
        setvbuf(s_file, s_stdio_buf, _IOFBF, sizeof(s_stdio_buf));
        s_file_size = 0;
    }
}

/* Caller holds s_mtx. */
static void emit_line() {
    if (s_line_pos == 0) return;
    if (!s_file) {
        s_line_pos = 0;
        s_line_has_ts = false;
        return;
    }
    size_t n = fwrite(s_line_buf, 1, s_line_pos, s_file);
    s_file_size += n;
    bool is_err = line_is_error_level(s_line_buf, s_line_pos);
    if (s_flush_policy == MIK_LOG_FLUSH_LINE ||
        (s_flush_policy == MIK_LOG_FLUSH_ERROR && is_err)) {
        fflush(s_file);
    }
    rotate_if_needed();
    s_line_pos = 0;
    s_line_has_ts = false;
}

/* Caller holds s_mtx. */
static void append_byte(uint8_t c) {
    if (!s_line_has_ts) {
        int n = format_timestamp(s_line_buf, sizeof(s_line_buf) - 1);
        if (n < 0 || (size_t)n >= sizeof(s_line_buf) - 1) n = 0;
        s_line_pos = (size_t)n;
        s_line_has_ts = true;
    }
    if (s_line_pos < sizeof(s_line_buf) - 1) {
        s_line_buf[s_line_pos++] = (char)c;
    }
    if (c == '\n' || s_line_pos >= sizeof(s_line_buf) - 1) {
        if (s_line_pos == 0 || s_line_buf[s_line_pos - 1] != '\n') {
            s_line_buf[s_line_pos++] = '\n';
        }
        emit_line();
    }
}

static void console_tap(const void* buf, size_t len) {
    if (!s_mtx) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) return;
    const uint8_t* p = (const uint8_t*)buf;
    for (size_t i = 0; i < len; i++) append_byte(p[i]);
    xSemaphoreGive(s_mtx);
}

/* Fired by mik__repl_proto_send_output before TLV framing. Gives us the
 * un-wrapped body bytes plus the message type, so console.error etc.
 * forces an immediate flush without relying on prefix pattern matching. */
static void log_emit_tap(uint8_t msg_type, const void* data, size_t len) {
    if (!s_mtx) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) return;
    const uint8_t* p = (const uint8_t*)data;
    for (size_t i = 0; i < len; i++) append_byte(p[i]);
    /* Ensure the line is closed even if the body lacks a trailing newline
     * (mik__repl_proto_send_output is called once per logical message). */
    if (s_line_pos > 0 && s_line_buf[s_line_pos - 1] != '\n') {
        append_byte((uint8_t)'\n');
    }
    if (s_file && (msg_type == MIK_MSG_ERROR || msg_type == MIK_MSG_WARN ||
                   msg_type == MIK_MSG_EVAL_ERROR)) {
        fflush(s_file);
    }
    xSemaphoreGive(s_mtx);
}

static int log_vprintf_tap(const char* fmt, va_list args) {
    /* Forward to the previously-installed vprintf so terminal output is
     * unchanged, then format a copy into the line buffer for the file. */
    va_list copy;
    va_copy(copy, args);
    int rv = s_prev_vprintf ? s_prev_vprintf(fmt, args) : vprintf(fmt, args);

    if (s_mtx) {
        char line[256];
        int n = vsnprintf(line, sizeof(line), fmt, copy);
        if (n > 0) {
            if ((size_t)n >= sizeof(line)) n = (int)sizeof(line) - 1;
            if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) == pdTRUE) {
                for (int i = 0; i < n; i++) append_byte((uint8_t)line[i]);
                xSemaphoreGive(s_mtx);
            }
        }
    }
    va_end(copy);
    return rv;
}

void mik_logfile_init(const MIKConfig* config) {
    const MIKPlatform* platform = MIK_GetPlatform();
    if (!config || config->log_dir[0] == '\0') return;
    if (s_file) return;

    /* Ensure the directory exists. mkdir errors when it already exists,
     * which is fine. */
    mkdir(config->log_dir, 0775);

    if ((size_t)snprintf(s_path_main, sizeof(s_path_main), "%s/log.txt", config->log_dir) >=
        sizeof(s_path_main)) {
        platform->log(MIK_LOG_WARN, TAG, "log dir path too long");
        return;
    }
    snprintf(s_path_rot, sizeof(s_path_rot), "%s.1", s_path_main);

    s_mtx = xSemaphoreCreateMutex();
    if (!s_mtx) return;

    s_file = fopen(s_path_main, "a");
    if (!s_file) {
        platform->log(MIK_LOG_WARN, TAG, "Could not open log file");
        vSemaphoreDelete(s_mtx);
        s_mtx = nullptr;
        return;
    }
    setvbuf(s_file, s_stdio_buf, _IOFBF, sizeof(s_stdio_buf));
    fseek(s_file, 0, SEEK_END);
    long pos = ftell(s_file);
    s_file_size = pos > 0 ? (size_t)pos : 0;
    s_max_size = config->log_max_size;
    s_flush_policy = config->log_flush;

    mik__console_set_tap(console_tap);
    mik__set_log_emit_tap(log_emit_tap);
    s_prev_vprintf = esp_log_set_vprintf(log_vprintf_tap);

    platform->log(MIK_LOG_INFO, TAG, "File log enabled (size=%u, max=%u)",
                  (unsigned)s_file_size, (unsigned)s_max_size);
}

void mik_logfile_suspend(void) {
    if (!s_mtx) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(100)) != pdTRUE) return;
    if (s_file) {
        fflush(s_file);
        fclose(s_file);
        s_file = nullptr;
    }
    xSemaphoreGive(s_mtx);
}

void mik_logfile_resume(void) {
    if (!s_mtx) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(100)) != pdTRUE) return;
    if (!s_file) {
        s_file = fopen(s_path_main, "a");
        if (s_file) {
            setvbuf(s_file, s_stdio_buf, _IOFBF, sizeof(s_stdio_buf));
            fseek(s_file, 0, SEEK_END);
            long pos = ftell(s_file);
            s_file_size = pos > 0 ? (size_t)pos : 0;
        }
    }
    xSemaphoreGive(s_mtx);
}

void mik_logfile_flush(void) {
    if (!s_mtx || !s_file) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(50)) != pdTRUE) return;
    fflush(s_file);
    xSemaphoreGive(s_mtx);
}

void mik_logfile_close(void) {
    if (!s_mtx) return;
    if (xSemaphoreTake(s_mtx, pdMS_TO_TICKS(100)) != pdTRUE) return;
    mik__console_set_tap(nullptr);
    mik__set_log_emit_tap(nullptr);
    if (s_prev_vprintf) {
        esp_log_set_vprintf(s_prev_vprintf);
        s_prev_vprintf = nullptr;
    }
    if (s_line_pos > 0) {
        if (s_line_buf[s_line_pos - 1] != '\n' && s_line_pos < sizeof(s_line_buf)) {
            s_line_buf[s_line_pos++] = '\n';
        }
        if (s_file) fwrite(s_line_buf, 1, s_line_pos, s_file);
        s_line_pos = 0;
    }
    if (s_file) {
        fflush(s_file);
        fclose(s_file);
        s_file = nullptr;
    }
    s_file_size = 0;
    s_line_has_ts = false;
    SemaphoreHandle_t mtx = s_mtx;
    s_mtx = nullptr;
    xSemaphoreGive(mtx);
    vSemaphoreDelete(mtx);
}

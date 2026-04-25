#include <stddef.h>
#include <stdint.h>

#include <esp_attr.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "mikrojs_esp32.h"

/* Magic word stored in RTC slow memory.  RTC_NOINIT_ATTR keeps the value
 * across software resets but leaves it uninitialized on power-on, so a
 * cold boot will (almost certainly) see garbage rather than the magic. */
#define MIK_RECOVERY_MAGIC 0x4D494B53u /* 'M','I','K','S' */

RTC_NOINIT_ATTR static uint32_t s_recovery_magic;

/* Sync sequence host tools send during the recovery window. */
static const char SYNC_BYTES[] = "MIKSAFE\n";

/* Drain any bytes still sitting in stdin.  Called after a successful
 * recovery trigger to discard leftover flood bytes before the protocol
 * loop starts reading — otherwise the tail of the host's "MIKSAFE\n"
 * flood gets parsed as a bogus TLV frame and the device hangs in
 * mik__proto_drain() waiting for GB of phantom payload.
 *
 * Reads with a short idle timeout: keep pulling while bytes are flowing,
 * stop once no bytes arrive for drain_idle_ms. */
static void drain_stdin(int drain_idle_ms) {
    int64_t idle_deadline_us = esp_timer_get_time() + ((int64_t)drain_idle_ms * 1000);
    while (esp_timer_get_time() < idle_deadline_us) {
        char buf[64];
        int n = mik__console_read(buf, sizeof(buf));
        if (n > 0) {
            /* Fresh bytes — reset the idle window. */
            idle_deadline_us = esp_timer_get_time() + ((int64_t)drain_idle_ms * 1000);
        } else {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
}

bool mik__check_recovery(int timeout_ms) {
    /* Double-reset path: previous boot armed the magic and got reset
     * before it could clear it.  Honor the request and clear immediately
     * so the next boot is normal. */
    if (s_recovery_magic == MIK_RECOVERY_MAGIC) {
        s_recovery_magic = 0;
        drain_stdin(200);
        return true;
    }

    /* Arm the magic for the duration of the window.  If the user resets
     * the chip while we're here, the next boot will see the magic and
     * enter safe mode. */
    s_recovery_magic = MIK_RECOVERY_MAGIC;

    const size_t sync_len = sizeof(SYNC_BYTES) - 1;
    size_t matched = 0;

    int64_t deadline_us = esp_timer_get_time() + ((int64_t)timeout_ms * 1000);
    while (esp_timer_get_time() < deadline_us) {
        char buf[16];
        int n = mik__console_read(buf, sizeof(buf));
        if (n > 0) {
            for (int i = 0; i < n; i++) {
                if (buf[i] == SYNC_BYTES[matched]) {
                    matched++;
                    if (matched == sync_len) {
                        s_recovery_magic = 0;
                        drain_stdin(200);
                        return true;
                    }
                } else {
                    matched = (buf[i] == SYNC_BYTES[0]) ? 1 : 0;
                }
            }
        } else {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

    /* Window expired with no trigger; disarm. */
    s_recovery_magic = 0;
    return false;
}

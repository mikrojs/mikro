#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs_esp32.h"

/*
 * Handle MIK_CMD_FS_GET: stream the contents of a file off the device.
 * Payload: u16le path_len | path.
 * Suspends the file logger so its buffered writes are flushed to disk and
 * its FILE* released before we open the same path for reading, then
 * resumes it once streaming is done.
 */
bool mik__handle_fs_get(MIKReplTransport* transport, uint32_t payload_len) {
    if (payload_len < 2) {
        mik__proto_drain(transport, payload_len);
        mik__proto_send_err(transport, "fs get: short header");
        return true;
    }
    uint8_t nl[2];
    if (!mik__proto_read_exact(transport, nl, 2)) return false;
    uint16_t path_len = nl[0] | (nl[1] << 8);
    if (path_len == 0 || path_len >= 256 || (uint32_t)path_len + 2 > payload_len) {
        mik__proto_drain(transport, payload_len - 2);
        mik__proto_send_err(transport, "fs get: bad path length");
        return true;
    }
    char path[256];
    if (!mik__proto_read_exact(transport, path, path_len)) return false;
    path[path_len] = '\0';
    uint32_t consumed = 2 + (uint32_t)path_len;
    if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

    mik_logfile_suspend();

    FILE* f = fopen(path, "r");
    if (!f) {
        char msg[160];
        snprintf(msg, sizeof(msg), "fs get: open failed: %s", strerror(errno));
        mik__proto_send_err(transport, msg);
        mik_logfile_resume();
        return true;
    }

    uint8_t buf[512];
    for (;;) {
        size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) break;
        mik__proto_send(transport, MIK_MSG_FS_CHUNK, buf, n);
    }
    fclose(f);
    mik_logfile_resume();
    mik__proto_send_ok(transport);
    return true;
}

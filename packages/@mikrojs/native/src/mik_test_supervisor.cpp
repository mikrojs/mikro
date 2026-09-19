#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"

static const char* TAG = "mikrojs";

/* Fixed sizes instead of PATH_MAX scaling — on newlib PATH_MAX can be 4096,
 * which is absurd for our purposes. These fit any realistic on-device test
 * path. */
#define MIK_SUP_PATH_MAX 384
/* Exception text captured by MIK_RunEntryErr when a test file fails to
 * evaluate. */
#define MIK_SUP_ERR_MAX 192

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

/* Supervisor frame buffers live on these noinline helpers' stacks, called
 * only while no JS runs. Not in the caller's frame: it stays live under the
 * eval chain, and 1-2 KB of locals there faulted in mik_module_normalizer.
 * Not on the heap: that held ~3 KB through every test file's network calls. */

/* Announce the file about to run so the CLI can confirm the supervisor's
 * iteration matches its own testFiles order. The MSG_DEBUG frame is
 * rendered as a dim log line. */
[[gnu::noinline]] static void mik__sup_announce(MIKReplTransport* transport, size_t i, size_t count,
                                                const char* path) {
    char dbg[MIK_SUP_PATH_MAX + 64];
    int n = snprintf(dbg, sizeof(dbg), "[supervisor] running %zu/%zu: %s", i + 1, count, path);
    if (n > 0 && n < (int)sizeof(dbg)) {
        mik__proto_send(transport, MIK_MSG_DEBUG, dbg, n);
    }
}

/* Synthesize a failing test + run_done so the CLI accounts for this file
 * instead of stalling waiting for a run_done the runtime will never emit.
 * `err` is the captured exception text, or null. */
[[gnu::noinline]] static void mik__sup_report_failure(MIKReplTransport* transport,
                                                      const char* path, const char* reason,
                                                      const char* err) {
    char esc[MIK_SUP_PATH_MAX * 2 + 8];
    char err_esc[MIK_SUP_ERR_MAX * 2 + 8];
    char buf[MIK_SUP_PATH_MAX * 2 + 512];

    const MIKPlatform* platform = MIK_GetPlatform();
    if (platform && platform->log) platform->log(MIK_LOG_ERROR, TAG, "%s: %s", reason, path);
    /* Escape the path so any `"` or `\` in it doesn't corrupt the JSON frame. */
    if (mik__json_escape(esc, sizeof(esc), path) < 0) {
        /* Path too long to fit even escaped — fall back to basename so the
         * frame at least identifies something. */
        const char* base = strrchr(path, '/');
        if (!base || mik__json_escape(esc, sizeof(esc), base + 1) < 0) {
            esc[0] = '?';
            esc[1] = '\0';
        }
    }
    /* Append the captured exception text (escaped) so the CLI shows the
     * actual error, not just "Evaluation threw". */
    err_esc[0] = '\0';
    if (err && err[0] != '\0') {
        if (mik__json_escape(err_esc, sizeof(err_esc), err) < 0) {
            err_esc[0] = '\0';
        }
    }
    int n;
    if (err_esc[0] != '\0') {
        n = snprintf(buf, sizeof(buf),
                     "{\"e\":3,\"s\":\"<load>\",\"t\":\"%s\",\"d\":0,\"m\":\"%s: %s\"}", esc,
                     reason, err_esc);
    } else {
        n = snprintf(buf, sizeof(buf),
                     "{\"e\":3,\"s\":\"<load>\",\"t\":\"%s\",\"d\":0,\"m\":\"%s\"}", esc, reason);
    }
    if (n > 0 && n < (int)sizeof(buf)) {
        mik__proto_send(transport, MIK_MSG_TEST, buf, n);
    }
    static const char kRunDone[] = "{\"e\":6,\"p\":0,\"f\":1,\"k\":0,\"o\":0,\"d\":0}";
    mik__proto_send(transport, MIK_MSG_TEST, kRunDone, sizeof(kRunDone) - 1);
}

void MIK_RunTestManifest(MIKReplTransport* transport, char** paths, size_t count,
                         MIKRuntime* (*create)(void* opaque), void* opaque) {
    for (size_t i = 0; i < count; i++) {
        mik__sup_announce(transport, i, count, paths[i]);
        MIKRuntime* rt = create(opaque);
        MIK_EnableTestHelpers(rt);
        MIK_ProtocolAttach(rt);
        /* Held only across the entry eval; a null buffer just drops the
         * exception text. */
        auto* err = static_cast<char*>(malloc(MIK_SUP_ERR_MAX));
        int rc = MIK_RunEntryErr(rt, paths[i], err, err ? MIK_SUP_ERR_MAX : 0);
        const char* fail_reason = nullptr;
        if (rc == -ENOENT) {
            fail_reason = "Test file not found";
        } else if (rc == -EFAULT) {
            fail_reason = "Evaluation threw";
        } else {
            free(err);
            err = nullptr;
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
            mik__sup_report_failure(transport, paths[i], fail_reason, err);
        }
        free(err);
        MIK_ProtocolDetach();
        MIK_FreeRuntime(rt);
    }

    /* Signal end-of-manifest so the CLI can finalize its report
     * without waiting on a silent stream. */
    mik__proto_send(transport, MIK_MSG_MANIFEST_DONE, nullptr, 0);
}

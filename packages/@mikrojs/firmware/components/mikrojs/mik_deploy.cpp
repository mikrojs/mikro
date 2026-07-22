#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <esp_app_desc.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "mikrojs/app_store.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs_esp32.h"

static const char* FS_BASE = "/appfs";
static const char* DEPLOY_TMP = "/appfs/.deploy-tmp";
static const char* APP_DIR = "/appfs/app";
static const char* CHECKSUMS_PATH = "/appfs/app/.checksums";
/* Where DEPLOY_PUT("/.build.tgz", ...) streams the OTA build (DEPLOY_TMP +
 * "/.build.tgz"). Adopted by MIK_CMD_DEPLOY_BUILD. */
static const char* BUILD_TGZ_PATH = "/appfs/.deploy-tmp/.build.tgz";

/* ── Checksums manifest ─────────────────────────────────────────── */

/*
 * Text format (sha256sum-style), one entry per line:
 *   <64-char hex hash>  <filename>\n
 * The device appends a "#firmware:<elf_sha256>" line after each deploy.
 * On load, if the firmware hash doesn't match, the manifest is discarded.
 */

static constexpr const char* FIRMWARE_PREFIX = "#firmware:";
static constexpr size_t FIRMWARE_PREFIX_LEN = 10;

struct ChecksumsManifest {
    char* data;
    size_t len;
};

static ChecksumsManifest load_checksums_manifest() {
    ChecksumsManifest m = {nullptr, 0};

    FILE* f = fopen(CHECKSUMS_PATH, "r");
    if (!f) return m;

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size <= 0) {
        fclose(f);
        return m;
    }

    auto* buf = static_cast<char*>(malloc(size + 1));
    if (!buf) {
        fclose(f);
        return m;
    }

    size_t n = fread(buf, 1, size, f);
    fclose(f);
    buf[n] = '\0';

    /* Check firmware hash — if it doesn't match, discard the manifest */
    const esp_app_desc_t* app_desc = esp_app_get_description();
    char fw_hash[65];
    for (int i = 0; i < 32; i++) {
        snprintf(fw_hash + i * 2, 3, "%02x", app_desc->app_elf_sha256[i]);
    }
    bool fw_match = false;
    const char* p = buf;
    const char* end = buf + n;
    while (p < end) {
        const char* nl = static_cast<const char*>(memchr(p, '\n', end - p));
        size_t line_len = nl ? static_cast<size_t>(nl - p) : static_cast<size_t>(end - p);
        if (line_len > FIRMWARE_PREFIX_LEN &&
            memcmp(p, FIRMWARE_PREFIX, FIRMWARE_PREFIX_LEN) == 0) {
            const char* stored = p + FIRMWARE_PREFIX_LEN;
            size_t hash_len = line_len - FIRMWARE_PREFIX_LEN;
            if (hash_len == strlen(fw_hash) && memcmp(stored, fw_hash, hash_len) == 0) {
                fw_match = true;
            }
            break;
        }
        p = nl ? nl + 1 : end;
    }

    if (!fw_match) {
        free(buf);
        return m;
    }

    m.data = buf;
    m.len = n;
    return m;
}

/**
 * Append the current firmware hash to the checksums manifest so it can
 * be validated on next load.
 */
static void stamp_checksums_manifest() {
    FILE* f = fopen(CHECKSUMS_PATH, "a");
    if (!f) return;
    const esp_app_desc_t* desc = esp_app_get_description();
    char hash[65];
    for (int i = 0; i < 32; i++) {
        snprintf(hash + i * 2, 3, "%02x", desc->app_elf_sha256[i]);
    }
    fprintf(f, "%s%s\n", FIRMWARE_PREFIX, hash);
    fclose(f);
}

static void hash_to_hex(const uint8_t* hash, char* out) {
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[i * 2] = hex[hash[i] >> 4];
        out[i * 2 + 1] = hex[hash[i] & 0x0f];
    }
    out[64] = '\0';
}

/**
 * Look up a filename in the text manifest. Returns true if the given
 * 32-byte hash matches the stored hex hash for that filename.
 */
static bool manifest_matches(const ChecksumsManifest& m, const char* name, uint16_t name_len,
                             const uint8_t* hash) {
    if (!m.data) return false;

    char hex[65];
    hash_to_hex(hash, hex);

    /* Scan lines: each is "<64 hex>  <filename>\n" */
    const char* p = m.data;
    const char* end = m.data + m.len;
    while (p < end) {
        const char* nl = static_cast<const char*>(memchr(p, '\n', end - p));
        size_t line_len = nl ? static_cast<size_t>(nl - p) : static_cast<size_t>(end - p);

        /* Line must be at least 64 (hash) + 2 ("  ") + 1 (filename) */
        if (line_len >= 67) {
            /* Compare hex hash (first 64 chars) */
            if (memcmp(p, hex, 64) == 0 && p[64] == ' ' && p[65] == ' ') {
                /* Compare filename */
                const char* fname = p + 66;
                size_t fname_len = line_len - 66;
                if (fname_len == name_len && memcmp(fname, name, name_len) == 0) {
                    return true;
                }
            }
        }

        p = nl ? nl + 1 : end;
    }
    return false;
}

/* ── Filesystem helpers ──────────────────────────────────────────── */

static void mkdirs(const char* path) {
    char tmp[512];
    snprintf(tmp, sizeof(tmp), "%s", path);
    for (char* p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            mkdir(tmp, 0755);
            *p = '/';
        }
    }
    mkdir(tmp, 0755);
}

static void rmdir_recursive(const char* path) {
    DIR* dir = opendir(path);
    if (!dir) return;

    struct dirent* entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;

        char full[512];
        snprintf(full, sizeof(full), "%s/%s", path, entry->d_name);

        struct stat st;
        if (stat(full, &st) == 0 && S_ISDIR(st.st_mode)) {
            rmdir_recursive(full);
        } else {
            unlink(full);
        }
    }
    closedir(dir);
    rmdir(path);
}

static bool path_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0;
}

/* ── File copy helper ────────────────────────────────────────────── */

static bool copy_file(const char* src, const char* dst) {
    FILE* in = fopen(src, "r");
    if (!in) return false;

    FILE* out = fopen(dst, "w");
    if (!out) {
        int saved = errno;
        fclose(in);
        errno = saved;
        return false;
    }

    uint8_t buf[512];
    size_t n;
    bool ok = true;
    int saved_errno = 0;
    while ((n = fread(buf, 1, sizeof(buf), in)) > 0) {
        if (fwrite(buf, 1, n, out) != n) {
            saved_errno = errno;
            ok = false;
            break;
        }
    }
    if (ok && ferror(in)) {
        saved_errno = errno;
        ok = false;
    }

    fflush(out);
    fclose(out);
    fclose(in);
    if (!ok) errno = saved_errno;
    return ok;
}

/* ── Deploy recovery ─────────────────────────────────────────────── */

void MIK_DeployRecover(void) {
    mik__app_recover(FS_BASE);
}

/* ── Unified protocol deploy handler ────────────────────────────── */

/* Deploy state — persists across multiple deploy commands within one session.
 * Lazily initialized on the first deploy command. */
static bool s_deploy_active = false;
static bool s_deploy_erased = false;
static bool s_deploy_prev_paused = false;
static ChecksumsManifest s_deploy_manifest = {nullptr, 0};

/* In-progress streaming PUT. Set by CMD_DEPLOY_PUT (open file + record size),
 * appended to by CMD_DEPLOY_PUT_CHUNK, cleared when total_remaining hits zero
 * or when the deploy session is reset. f is non-null iff a PUT is currently
 * receiving body bytes. */
static FILE* s_put_file = nullptr;
static uint32_t s_put_remaining = 0;

static void put_close_and_clear() {
    if (s_put_file) {
        fflush(s_put_file);
        fclose(s_put_file);
        s_put_file = nullptr;
    }
    s_put_remaining = 0;
}

static void deploy_ensure_init() {
    if (s_deploy_active) return;
    s_deploy_active = true;
    s_deploy_erased = false;
    /* Freeze user code for the duration of the deploy: timers and loop
     * consumers stop firing between protocol commands so an app crash
     * (or a WiFi/HTTP callback touching the fs) can't race the file
     * swap. Microtasks still drain. Prior state is restored on cleanup
     * so a manual /pause sticks across a deploy. */
    s_deploy_prev_paused = mik__repl_is_paused();
    mik__repl_set_paused(true);
    rmdir_recursive(DEPLOY_TMP);
    s_deploy_manifest = load_checksums_manifest();
}

static void deploy_cleanup() {
    put_close_and_clear();
    if (s_deploy_manifest.data) {
        free(s_deploy_manifest.data);
        s_deploy_manifest = {nullptr, 0};
    }
    mik__repl_set_paused(s_deploy_prev_paused);
    s_deploy_active = false;
}

/**
 * Reset any in-flight deploy session. Called from the REPL protocol
 * session_end hook when the transport drops without a DONE/ABORT (e.g.
 * CLI killed mid-upload). Discards the staging dir so the next session
 * starts from a clean slate and restores the prior pause state.
 */
void mik__deploy_session_reset(void) {
    if (!s_deploy_active) return;
    rmdir_recursive(DEPLOY_TMP);
    deploy_cleanup();
}

/**
 * Handle a deploy command from the unified protocol loop.
 * The payload bytes have NOT been read yet — this handler reads them
 * directly from the transport, enabling streaming for large files.
 */
bool mik__handle_deploy_command(MIKReplTransport* transport, uint8_t cmd_type,
                                uint32_t payload_len) {
    deploy_ensure_init();

    switch (cmd_type) {
        case MIK_CMD_DEPLOY_CHECKSUM: {
            /* Payload: u16le name_len | name | sha256[32] */
            uint8_t hdr[2];
            if (!mik__proto_read_exact(transport, hdr, 2)) return false;
            uint16_t name_len = hdr[0] | (hdr[1] << 8);

            char name[256];
            if (name_len >= sizeof(name)) {
                mik__proto_drain(transport, payload_len - 2);
                mik__proto_send_err(transport, "checksum filename too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, name, name_len)) return false;

            uint8_t hash[32];
            if (!mik__proto_read_exact(transport, hash, 32)) return false;

            bool match = manifest_matches(s_deploy_manifest, name, name_len, hash);

            /* Verify the file is actually on disk. A stale manifest (e.g. after
             * a partial deploy or FS glitch) would otherwise trick the client
             * into sending KEEP for a file that no longer exists, and KEEP
             * would then fail. Report "no match" so the client re-PUTs it. */
            if (match) {
                char terminated[257];
                memcpy(terminated, name, name_len);
                terminated[name_len] = '\0';
                char src_path[512];
                snprintf(src_path, sizeof(src_path), "%s%s", FS_BASE, terminated);
                if (!path_exists(src_path)) match = false;
            }

            uint8_t result_byte = match ? 0x01 : 0x00;
            mik__proto_send(transport, MIK_MSG_CHECKSUM_RESULT, &result_byte, 1);
            return true;
        }

        case MIK_CMD_DEPLOY_ERASE:
            mik__proto_drain(transport, payload_len);
            rmdir_recursive(APP_DIR);
            s_deploy_erased = true;
            mik__proto_send_ok(transport);
            return true;

        case MIK_CMD_DEPLOY_KEEP: {
            /* Payload: u16le name_len | name */
            uint8_t nl[2];
            if (!mik__proto_read_exact(transport, nl, 2)) return false;
            uint16_t name_len = nl[0] | (nl[1] << 8);

            char name[256];
            if (name_len >= sizeof(name)) {
                mik__proto_drain(transport, name_len);
                mik__proto_send_err(transport, "keep filename too long");
                return true;
            }
            if (!mik__proto_read_exact(transport, name, name_len)) return false;
            name[name_len] = '\0';

            char src_path[512], dst_path[512];
            snprintf(src_path, sizeof(src_path), "%s%s", FS_BASE, name);
            snprintf(dst_path, sizeof(dst_path), "%s%s", DEPLOY_TMP, name);

            char dir_path[512];
            snprintf(dir_path, sizeof(dir_path), "%s", dst_path);
            char* last_slash = strrchr(dir_path, '/');
            if (last_slash && last_slash != dir_path) {
                *last_slash = '\0';
                mkdirs(dir_path);
            }

            if (copy_file(src_path, dst_path)) {
                mik__proto_send_ok(transport);
            } else {
                char msg[128];
                snprintf(msg, sizeof(msg), "keep copy failed: %s", strerror(errno));
                mik__proto_send_err(transport, msg);
            }
            return true;
        }

        case MIK_CMD_DEPLOY_PUT: {
            /* Begin a streaming PUT.
             * Payload: u16le name_len | name | u32le total_size
             * Opens the staged file, records the expected body size, and
             * replies OK. The body itself arrives in subsequent
             * CMD_DEPLOY_PUT_CHUNK frames. */
            put_close_and_clear();

            if (payload_len < 2 + 4) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "put header too short");
                return true;
            }

            uint8_t nl[2];
            if (!mik__proto_read_exact(transport, nl, 2)) return false;
            uint16_t name_len = nl[0] | (nl[1] << 8);

            if (name_len >= 256 || (uint32_t)name_len + 6 > payload_len) {
                mik__proto_drain(transport, payload_len - 2);
                mik__proto_send_err(transport, "put filename too long");
                return true;
            }

            char name[256];
            if (!mik__proto_read_exact(transport, name, name_len)) return false;
            name[name_len] = '\0';

            uint8_t sz[4];
            if (!mik__proto_read_exact(transport, sz, 4)) return false;
            uint32_t total_size = (uint32_t)sz[0] | ((uint32_t)sz[1] << 8) |
                                  ((uint32_t)sz[2] << 16) | ((uint32_t)sz[3] << 24);

            /* Drain any trailing bytes the host accidentally tacked on
             * (defensive — the wire format is fixed-size after the name). */
            uint32_t consumed = 2 + name_len + 4;
            if (payload_len > consumed) {
                mik__proto_drain(transport, payload_len - consumed);
            }

            char full_path[512];
            snprintf(full_path, sizeof(full_path), "%s%s", DEPLOY_TMP, name);

            char dir_path[512];
            snprintf(dir_path, sizeof(dir_path), "%s", full_path);
            char* last_slash = strrchr(dir_path, '/');
            if (last_slash && last_slash != dir_path) {
                *last_slash = '\0';
                mkdirs(dir_path);
            }

            FILE* f = fopen(full_path, "w");
            if (!f) {
                mik__proto_send_err(transport, "open failed");
                return true;
            }

            if (total_size == 0) {
                /* Empty file: nothing to chunk, close now. */
                fflush(f);
                fclose(f);
            } else {
                s_put_file = f;
                s_put_remaining = total_size;
            }
            mik__proto_send_ok(transport);
            return true;
        }

        case MIK_CMD_DEPLOY_PUT_CHUNK: {
            /* Append payload bytes to the file opened by the preceding PUT.
             * Streams in a small fixed buffer — never holds the chunk in
             * full, regardless of chunk size. Closes the file and clears
             * state when total_remaining reaches zero. */
            if (!s_put_file) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "put chunk without active put");
                return true;
            }
            if (payload_len > s_put_remaining) {
                mik__proto_drain(transport, payload_len);
                put_close_and_clear();
                mik__proto_send_err(transport, "put chunk overruns declared size");
                return true;
            }

            uint8_t buf[512];
            uint32_t remaining = payload_len;
            bool ok = true;
            while (remaining > 0) {
                uint32_t chunk = remaining > sizeof(buf) ? sizeof(buf) : remaining;
                if (!mik__proto_read_exact(transport, buf, chunk)) return false;
                if (fwrite(buf, 1, chunk, s_put_file) != chunk) {
                    /* Write failure: keep the protocol in sync by draining
                     * the rest of this chunk's bytes, then abort the PUT. */
                    remaining -= chunk;
                    if (remaining > 0) mik__proto_drain(transport, remaining);
                    ok = false;
                    break;
                }
                remaining -= chunk;
                s_put_remaining -= chunk;
            }

            if (!ok) {
                put_close_and_clear();
                mik__proto_send_err(transport, "write failed");
                return true;
            }

            if (s_put_remaining == 0) {
                put_close_and_clear();
            }
            mik__proto_send_ok(transport);
            return true;
        }

        case MIK_CMD_DEPLOY_DONE: {
            mik__proto_drain(transport, payload_len);

            /* Guard against a CLI bug where DONE arrives mid-stream: the
             * half-written file would otherwise be promoted into APP_DIR.
             * Drop the in-flight file, nuke staging, and surface the error
             * to the host so the caller sees a real failure. */
            if (s_put_file) {
                put_close_and_clear();
                rmdir_recursive(DEPLOY_TMP);
                mik__proto_send_err(transport, "deploy done while put in progress");
                deploy_cleanup();
                return true;
            }

            /* Atomic swap: staging dir → app dir */
            MIKAppCommitResult commit = mik__app_commit(FS_BASE, s_deploy_erased);
            if (commit == MIK_APP_COMMIT_STASH_FAILED) {
                mik__proto_send_err(transport, "rename app to old failed");
                deploy_cleanup();
                return true;
            }
            if (commit == MIK_APP_COMMIT_SWAP_FAILED) {
                mik__proto_send_err(transport, "rename staged to app failed");
                deploy_cleanup();
                return true;
            }

            stamp_checksums_manifest();
            mik__proto_send_ok(transport);
            deploy_cleanup();
            return true;
        }

        case MIK_CMD_DEPLOY_BUILD: {
            /* Adopt a streamed .tgz as the live app via the OTA install path,
             * establishing the rollback baseline. The build was streamed via
             * PUT("/.build.tgz") + chunks into BUILD_TGZ_PATH.
             * Payload: u16le checksum_len | checksum. */
            if (payload_len < 2) {
                mik__proto_drain(transport, payload_len);
                mik__proto_send_err(transport, "build header too short");
                deploy_cleanup();
                return true;
            }
            uint8_t cl[2];
            if (!mik__proto_read_exact(transport, cl, 2)) return false;
            uint16_t chk_len = cl[0] | (cl[1] << 8);

            char checksum[96];
            if (chk_len >= sizeof(checksum) || (uint32_t)chk_len + 2 > payload_len) {
                mik__proto_drain(transport, payload_len - 2);
                mik__proto_send_err(transport, "build checksum too long");
                deploy_cleanup();
                return true;
            }
            if (!mik__proto_read_exact(transport, checksum, chk_len)) return false;
            checksum[chk_len] = '\0';
            uint32_t consumed = 2 + (uint32_t)chk_len;
            if (payload_len > consumed) mik__proto_drain(transport, payload_len - consumed);

            /* Flush the staged .tgz to disk before adopt reads it back. */
            put_close_and_clear();

            const char* err = nullptr;
            if (mik__ota_adopt_build(BUILD_TGZ_PATH, checksum, &err)) {
                mik__proto_send_ok(transport);
            } else {
                mik__proto_send_err(transport, err ? err : "build install failed");
            }
            deploy_cleanup();
            return true;
        }

        case MIK_CMD_DEPLOY_ABORT:
            mik__proto_drain(transport, payload_len);
            rmdir_recursive(DEPLOY_TMP);
            mik__proto_send_ok(transport);
            deploy_cleanup();
            return true;

        default:
            mik__proto_drain(transport, payload_len);
            return false;
    }
}

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

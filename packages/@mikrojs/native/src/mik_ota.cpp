// Native OTA install module for Mikro.js firmware, shared by every port.
//
// Registers `native:mikro/ota`, the privileged half of over-the-air updates the
// JS layer can't do: /app is read-only from JS and there is no gunzip/untar in
// the runtime, but C in firmware has a writable FS, miniz, and plain file I/O.
//
// The surface (consumed by the JS helper that owns the OTA protocol):
//   stageBegin(checksum, size)               stage a download, resume if partial
//   stageWrite(bytes)                         append to the staged .tgz
//   stageFinish(trialBoots, requireConfirm, installNow)  verify + schedule install
//   stageAbort()                              drop the in-progress staging file
//   markValid()                               confirm the running trial (promote)
//   revert()                                  roll back to the last-good build
//   running()                                 { checksum?, trial }
//   reconcile()                               outcome of the boot-time reconcile
//
// The actual install (gunzip -> untar -> atomic swap) runs at boot on a clean
// heap from MIK_OtaBootReconcile(), which also drives the trial/rollback
// state machine. The unpack itself (gunzip + untar + SHA-256 + swap) is
// mik__install_build (mikrojs/build_install.h), host-tested in
// @mikrojs/firmware's test/ota_host/. The install state and the app filesystem
// come from the device store (mikrojs/device_store.h): NVS and LittleFS on the
// ESP32.

#include "mikrojs/app_store.h"
#include "mikrojs/build_install.h"
#include "mikrojs/device_store.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/ota.h"
#include "mikrojs/ota_env.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "quickjs.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/stat.h>
#include <unistd.h>

namespace {

const char* err_kind(MIKBuildErr k) {
    switch (k) {
        case MIK_BUILD_ERR_CORRUPT:
            return "corrupt";
        case MIK_BUILD_ERR_OOM:
            return "oom";
        case MIK_BUILD_ERR_TRANSIENT:
        default:
            return "transient";
    }
}

// ── On-disk layout (under the device store's fs_base) ────────────────────────
struct Paths {
    const char* base;
    const char* staging;        // in-progress download sink
    const char* pending;        // verified, awaiting install
    const char* last_good;      // revert target
    const char* last_good_tmp;  // adopt: install source (legacy)
};

// The paths share one heap block, rebuilt when the base changes. All empty
// without a store that names an app filesystem, or when out of memory.
const Paths& paths(void) {
    static Paths p = {"", "", "", "", ""};
    static char* block = nullptr;
    const MIKDeviceStore* store = mik__device_store();
    const char* base = store ? store->fs_base : nullptr;
    if (block && base && strcmp(p.base, base) == 0) return p;

    free(block);
    block = nullptr;
    p = {"", "", "", "", ""};
    if (!base) return p;

    static const char* const suffixes[] = {"", "/.ota-staging.tgz", "/.ota-pending.tgz",
                                           "/.ota-last-good.tgz", "/.ota-last-good.tmp"};
    const char** const slots[] = {&p.base, &p.staging, &p.pending, &p.last_good,
                                  &p.last_good_tmp};
    block = mik__join_paths(base, suffixes, sizeof(suffixes) / sizeof(suffixes[0]), slots);
    return p;
}

// State keys, in the store's "mik.ota" namespace. Kept <= 15 chars (the ESP32's
// NVS limit).
constexpr const char* kKeyState = "state";        // u8: 0 GOOD, 1 TRIAL
constexpr const char* kKeyTrialLeft = "trialLeft"; // u8
constexpr const char* kKeyTrialN = "trialN";      // u8: trial budget for a pending install
constexpr const char* kKeyConfirm = "confirm";    // u8: trial requires markValid() to promote
constexpr const char* kKeyPending = "pending";    // u8: 1 = .ota-pending.tgz awaits clean-heap install
constexpr const char* kKeyPendMode = "pendMode";  // u8: how to install the pending build (see below)
constexpr const char* kKeyInstLeft = "instLeft";  // u8: install-attempt budget
constexpr const char* kKeyPromLeft = "promLeft";  // u8: promote-attempt budget
constexpr const char* kKeyRbLeft = "rbLeft";      // u8: rollback-attempt budget
constexpr const char* kKeyNeutLeft = "neutLeft";  // u8: brownout boots a trial may absorb
constexpr const char* kKeyInstChk = "instChk";    // str: running good (last-good) checksum
constexpr const char* kKeyPendChk = "pendChk";    // str: pending/trial checksum
constexpr const char* kKeyStgChk = "stgChk";      // str: in-progress staging expected checksum
constexpr const char* kKeyStgSize = "stgSize";    // u32: expected staged size
constexpr const char* kKeyFwHash = "fwHash";      // str: firmware elf sha256 (reflash guard)
constexpr const char* kKeyTrialBad = "trialBad";  // u8: trial app hit a fatal JS error this boot
constexpr const char* kKeyBadDetail = "badDetail"; // str: that error, for the revert diagnostic
// Boot-reconcile outcome, read once by reconcile() and then cleared.
constexpr const char* kKeyOInst = "oInst";        // str: checksum just installed
constexpr const char* kKeyORevert = "oRevert";    // u8
constexpr const char* kKeyORsn = "oRsn";          // str: diagnostic reason
constexpr const char* kKeyODetail = "oDetail";    // str: diagnostic detail
// Adopt-install outcome, read once by MIK_CMD_DEPLOY_RESULT and then cleared.
// Separate from the reconcile record above: that one reaches the registry as
// `lastInstall` and would blacklist a checksum the developer is re-pushing.
constexpr const char* kKeyDRes = "dRes";          // u8: 1 ok, 2 fail
constexpr const char* kKeyDChk = "dChk";          // str: staged checksum
constexpr const char* kKeyDRsn = "dRsn";          // str: failure reason
constexpr const char* kKeyDDetail = "dDetail";    // str: failure detail

constexpr uint8_t kStateGood = 0;
constexpr uint8_t kStateTrial = 1;
// kKeyPendMode values. Trial is the OTA path (trialBoots, rollback, abandon
// policy); adopt is the cable-deploy path (straight to GOOD, no trial, no
// rollback baseline, one install attempt). Absent defaults to trial so a
// pending build staged by older firmware keeps its semantics.
constexpr uint8_t kPendModeTrial = 0;
constexpr uint8_t kPendModeAdopt = 1;
constexpr uint8_t kInstallBudget = 3;  // boot install attempts before abandoning a pending build
// Boot attempts to make a survived trial the revert target before giving up on
// the revert target rather than on the device: a trial that cannot promote and
// never resolves leaves applyOffer skipping every future offer, so the device
// stops being updatable at all and only a reflash recovers it.
constexpr uint8_t kPromoteBudget = 3;
// Boot attempts to install the revert target before keeping the trial build
// instead. install_build can panic rather than return, so an unbudgeted rollback
// that crashes mid-install re-enters itself every boot forever.
constexpr uint8_t kRollbackBudget = 3;
// Brownout boots a trial absorbs before they start counting as ordinary boots.
// A brownout is ambiguous (bad supply, or the new build drawing more than the
// board can deliver), so don't convict on the first one -- but don't absorb them
// forever either: applyOffer skips every offer while a trial is unresolved, so a
// trial held open indefinitely shuts the one channel that could ship a fix.
constexpr uint8_t kNeutralBudget = 3;

// ── small fs helpers ─────────────────────────────────────────────────────────
bool path_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0;
}

// Make the pending build the new revert target. The old last-good is only
// dropped once the replacement is in hand: unlinking first and then failing the
// rename (ENOSPC on littlefs metadata, or paths().pending lost to a power cut) would
// leave a GOOD state whose instChk names a build with no .tgz on disk, so a
// later revert() would have nothing to reinstall.
bool promote_pending(void) {
    if (!path_exists(paths().pending)) return false;
    // rename replaces an existing destination atomically (lfs_rename removes it
    // as part of the same commit), so paths().last_good must NOT be unlinked first: a
    // failed rename after the unlink would leave a GOOD state whose instChk
    // names a build with no .tgz on disk, and a later revert() would have
    // nothing to reinstall.
    return rename(paths().pending, paths().last_good) == 0;
}

// ── State store helpers ──────────────────────────────────────────────────────
// The device store's state hooks, open for one operation.
struct State {
    const MIKDeviceStore* store = nullptr;
    void* h = nullptr;
};

bool state_open(State* st, bool writable) {
    const MIKDeviceStore* store = mik__device_store();
    if (!store || !store->state_open || !paths().base[0]) return false;
    st->store = store;
    st->h = store->state_open(writable);
    return st->h != nullptr;
}

void state_close(State& st) { st.store->state_close(st.h); }
void state_commit(State& st) { st.store->state_commit(st.h); }
void state_erase(State& st, const char* key) { st.store->state_erase(st.h, key); }
void state_set_u8(State& st, const char* key, uint8_t v) { st.store->state_set_u8(st.h, key, v); }
void state_set_u32(State& st, const char* key, uint32_t v) {
    st.store->state_set_u32(st.h, key, v);
}
void state_set_str(State& st, const char* key, const char* v) {
    st.store->state_set_str(st.h, key, v);
}

uint8_t state_u8(State& st, const char* key, uint8_t def) {
    uint8_t v = def;
    if (!st.store->state_get_u8(st.h, key, &v)) v = def;
    return v;
}

uint32_t state_u32(State& st, const char* key, uint32_t def) {
    uint32_t v = def;
    if (!st.store->state_get_u32(st.h, key, &v)) v = def;
    return v;
}

// Read a string key into `buf`. Returns true and a non-empty string on success.
bool state_str(State& st, const char* key, char* buf, size_t cap) {
    if (!st.store->state_get_str(st.h, key, buf, cap)) {
        buf[0] = 0;
        return false;
    }
    return buf[0] != 0;
}

// Drop the trial crash flag and its diagnostic. Must run wherever the state
// machine leaves a trial or starts a new one: the flag outliving the build that
// set it makes the *next* trial roll back on its first reboot, blamed with the
// previous build's error string.
void clear_trial_failure(State& h) {
    state_erase(h, kKeyTrialBad);
    state_erase(h, kKeyBadDetail);
}

// Record a boot/promote diagnostic for the next reconcile() call to report.
void record_diag(State& h, const char* reason, const char* detail) {
    state_set_str(h, kKeyORsn, reason);
    if (detail && detail[0]) state_set_str(h, kKeyODetail, detail);
}

// ── staging write cache ──────────────────────────────────────────────────────
// stageBegin fills these, stageWrite appends without reopening, and
// stageFinish/stageAbort flush them. Without the cache every 4 KB chunk cost a
// state-store open + stat + fopen/fclose (~50 flash metadata commits for a 200 KB
// build). Safe as plain statics because staging writes and the boot reconcile
// never overlap: both run on the single main task.
FILE* g_stage_file = nullptr;
uint32_t g_stage_cap = 0;  // declared size from stageBegin; 0 = uncapped
long g_stage_have = 0;     // bytes in the staging file

// Flush and close the staging file. False if the close failed, which on
// littlefs is where a full disk surfaces.
bool stage_close(void) {
    if (!g_stage_file) return true;
    bool ok = fclose(g_stage_file) == 0;
    g_stage_file = nullptr;
    return ok;
}

// ── JS result-object builders ────────────────────────────────────────────────
JSValue ok_obj(JSContext* ctx) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "ok", JS_TRUE);
    return o;
}

JSValue err_obj(JSContext* ctx, const char* msg) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "ok", JS_FALSE);
    JS_SetPropertyStr(ctx, o, "error", JS_NewString(ctx, msg));
    return o;
}

JSValue err_obj_kind(JSContext* ctx, const char* msg, MIKBuildErr kind) {
    JSValue o = err_obj(ctx, msg);
    JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, err_kind(kind)));
    return o;
}

// ── JS bindings ──────────────────────────────────────────────────────────────

// sha256_file emits lowercase hex and the comparison in stageFinish is strcmp,
// so anything else can never match. Rejecting it here matters because the
// mismatch would otherwise surface as corrupt, which the policy layer treats
// as "these bytes can never succeed" and abandons the checksum permanently: an
// uppercase digest from a registry would blacklist a perfectly good build.
bool valid_checksum(const char* s) {
    size_t i = 0;
    for (; s[i]; i++) {
        if (i >= 64) return false;
        const char c = s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return i == 64;
}

// ── Staging cores ────────────────────────────────────────────────────────────
// The install machinery, with no JSContext in sight. Two callers sit on top: the
// native:mikro/ota JS bindings below, and the MIKOtaEnv install ops the native
// OTA client drives (mik__ota_fill_install_ops). One implementation, so the two
// can never drift on something as unforgiving as install safety.

struct CoreErr {
    const char* msg = nullptr;
    MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
};

bool core_fail(CoreErr* e, const char* msg, MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT) {
    if (e) {
        e->msg = msg;
        e->kind = kind;
    }
    return false;
}

bool core_stage_begin(const char* checksum, int64_t size, int64_t* out_resume, CoreErr* e) {
    if (!checksum) return core_fail(e, "checksum not a string");
    if (!valid_checksum(checksum)) {
        // transient, not the default: the build is fine, the offer is
        // malformed, so this must not count against the build's retry budget.
        return core_fail(e, "checksum must be 64 lowercase hex characters",
                         MIK_BUILD_ERR_TRANSIENT);
    }
    if (size <= 0) return core_fail(e, "invalid size");
    // Reject an impossible size while it is still int64: stgSize is u32, so a
    // bogus offer above 4 GB would otherwise truncate into a small cap.
    long fs_total = 0;
    long fs_free = 0;
    if (mik__fs_space(&fs_total, &fs_free) && size > fs_total) {
        return core_fail(e, "offered build is larger than the filesystem");
    }

    stage_close();  // flush any prior staging file before stat/unlink below

    State h;
    if (!state_open(&h, true)) return core_fail(e, "OTA state unavailable");

    // Resume only if the in-progress staging file is for the same checksum+size
    // and hasn't already grown past the declared size.
    char prev[96];
    uint32_t prev_size = state_u32(h, kKeyStgSize, 0);
    long have = mik__file_size(paths().staging);
    int64_t resume = 0;
    if (state_str(h, kKeyStgChk, prev, sizeof(prev)) && strcmp(prev, checksum) == 0 &&
        prev_size == (uint32_t)size && have >= 0 && have <= size) {
        resume = have;
    } else {
        unlink(paths().staging);  // different target — start fresh
        state_set_str(h, kKeyStgChk, checksum);
        state_set_u32(h, kKeyStgSize, (uint32_t)size);
        state_commit(h);
    }
    state_close(h);

    g_stage_cap = (uint32_t)size;
    g_stage_have = resume;
    if (out_resume) *out_resume = resume;
    return true;
}

bool core_stage_write(const uint8_t* data, size_t len, CoreErr* e) {
    if (!data) return core_fail(e, "bytes not a Uint8Array");
    if (len == 0) return true;

    // Enforce the size cap from stageBegin so a runaway download can't fill flash.
    if (g_stage_cap > 0 && (uint64_t)g_stage_have + len > g_stage_cap) {
        return core_fail(e, "staged write exceeds declared size", MIK_BUILD_ERR_TRANSIENT);
    }

    if (!g_stage_file) {
        g_stage_file = fopen(paths().staging, "ab");
        if (!g_stage_file) return core_fail(e, "open staging file", MIK_BUILD_ERR_TRANSIENT);
    }
    size_t wrote = fwrite(data, 1, len, g_stage_file);
    if (wrote != len) {
        // A short write still leaves `wrote` bytes on disk. Close first so the
        // stream flushes, then resync from the file itself: an understated
        // g_stage_have desyncs the resume offset from the real file, and the
        // duplicated/skipped bytes surface later as a checksum mismatch, which
        // is classified corrupt and blacklists the checksum forever. A full
        // filesystem must stay transient.
        stage_close();
        long actual = mik__file_size(paths().staging);
        g_stage_have = actual < 0 ? g_stage_have + (long)wrote : actual;
        return core_fail(e, "write staging file (disk full?)", MIK_BUILD_ERR_TRANSIENT);
    }
    g_stage_have += (long)len;
    return true;
}

bool core_stage_finish(int64_t trial_boots, bool require_confirm, bool install_now, CoreErr* e) {
    if (trial_boots < 0) trial_boots = 0;
    // A confirm-gated trial needs at least one boot to run in. Boot reconcile
    // evaluates the trial before the app loads, so trialBoots:0 with confirm set
    // reverts at the next boot without the new build ever having had the chance
    // to call markValid() -- every such update would revert, deterministically.
    if (require_confirm && trial_boots < 1) trial_boots = 1;
    if (trial_boots > 255) trial_boots = 255;

    if (!stage_close()) {
        return core_fail(e, "write staging file (disk full?)", MIK_BUILD_ERR_TRANSIENT);
    }

    State h;
    if (!state_open(&h, true)) {
        return core_fail(e, "OTA state unavailable", MIK_BUILD_ERR_TRANSIENT);
    }
    char want_chk[96];
    bool has_chk = state_str(h, kKeyStgChk, want_chk, sizeof(want_chk));
    uint32_t want_size = state_u32(h, kKeyStgSize, 0);

    if (!has_chk) {
        state_close(h);
        return core_fail(e, "no staged build", MIK_BUILD_ERR_TRANSIENT);
    }
    long have = mik__file_size(paths().staging);
    if (have < 0) {
        state_close(h);
        return core_fail(e, "staging file missing", MIK_BUILD_ERR_TRANSIENT);
    }
    if ((uint32_t)have != want_size) {
        state_close(h);
        return core_fail(e, "staged size mismatch", MIK_BUILD_ERR_CORRUPT);
    }
    char got_chk[65];
    if (!mik__sha256_file(paths().staging, got_chk)) {
        state_close(h);
        return core_fail(e, "read staging file", MIK_BUILD_ERR_TRANSIENT);
    }
    if (strcmp(got_chk, want_chk) != 0) {
        state_close(h);
        return core_fail(e, "checksum mismatch (corrupt download)", MIK_BUILD_ERR_CORRUPT);
    }

    // Verified. Promote the staging file to the pending build.
    unlink(paths().pending);
    if (rename(paths().staging, paths().pending) != 0) {
        state_close(h);
        return core_fail(e, "stage pending build", MIK_BUILD_ERR_TRANSIENT);
    }
    g_stage_cap = 0;
    g_stage_have = 0;
    state_erase(h, kKeyStgChk);
    state_erase(h, kKeyStgSize);
    state_set_str(h, kKeyPendChk, want_chk);
    // Explicit even though trial is the default: a leftover adopt marker from
    // an earlier cable deploy must not turn this OTA build into an adopt.
    state_set_u8(h, kKeyPendMode, kPendModeTrial);
    state_set_u8(h, kKeyTrialN, (uint8_t)trial_boots);
    state_set_u8(h, kKeyConfirm, require_confirm ? 1 : 0);

    if (install_now) {
        const char* err = nullptr;
        MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
        if (!mik__install_build(paths().base, paths().pending, &err, &kind)) {
            // The verified .tgz is already on flash. Leaving it with pending=0
            // would strand it there forever and let the next stageBegin build a
            // second staging file beside it.
            if (kind == MIK_BUILD_ERR_CORRUPT) {
                state_set_u8(h, kKeyPending, 0);  // identical bytes can't succeed
                unlink(paths().pending);
            } else {
                state_set_u8(h, kKeyPending, 1);  // boot reconcile retries it
                state_set_u8(h, kKeyInstLeft, kInstallBudget);
            }
            state_commit(h);
            state_close(h);
            return core_fail(e, err, kind);
        }
        // New app is live but unproven: enter the trial. The caller restarts.
        state_set_u8(h, kKeyState, kStateTrial);
        state_set_u8(h, kKeyTrialLeft, (uint8_t)trial_boots);
        state_set_u8(h, kKeyPending, 0);
        state_erase(h, kKeyPromLeft);   // per-trial budgets
        state_erase(h, kKeyRbLeft);
        state_erase(h, kKeyNeutLeft);
        clear_trial_failure(h);  // fresh trial: this build has not failed yet
        state_commit(h);
        state_close(h);
        return true;
    }

    // Defer: install at the next boot on a clean heap.
    state_set_u8(h, kKeyPending, 1);
    state_set_u8(h, kKeyInstLeft, kInstallBudget);
    state_commit(h);
    state_close(h);
    return true;
}

void core_stage_abort(void) {
    stage_close();
    g_stage_cap = 0;
    g_stage_have = 0;
    unlink(paths().staging);
    State h;
    if (state_open(&h, true)) {
        state_erase(h, kKeyStgChk);
        state_erase(h, kKeyStgSize);
        state_commit(h);
        state_close(h);
    }
}

// Confirm the running trial: promote it to GOOD and make the pending build the
// new revert target.
void core_mark_valid(void) {
    State h;
    if (!state_open(&h, true)) return;
    if (state_u8(h, kKeyState, kStateGood) == kStateTrial) {
        // Stay in the trial if the promotion failed: going GOOD anyway would
        // point instChk at a build that has no .tgz left to revert to.
        if (promote_pending()) {
            char chk[96];
            if (state_str(h, kKeyPendChk, chk, sizeof(chk))) state_set_str(h, kKeyInstChk, chk);
            state_set_u8(h, kKeyState, kStateGood);
            state_set_u8(h, kKeyTrialLeft, 0);
            state_set_u8(h, kKeyPending, 0);
            state_erase(h, kKeyPromLeft);
            clear_trial_failure(h);
        } else {
            record_diag(h, "promote-failed", "could not make the trial build the revert target");
        }
        state_commit(h);
    }
    state_close(h);
}

bool core_revert(CoreErr* e) {
    if (!path_exists(paths().last_good)) return core_fail(e, "no last-good build to revert to");
    const char* err = nullptr;
    MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
    if (!mik__install_build(paths().base, paths().last_good, &err, &kind)) {
        return core_fail(e, err, kind);
    }
    State h;
    if (state_open(&h, true)) {
        state_set_u8(h, kKeyState, kStateGood);
        state_set_u8(h, kKeyTrialLeft, 0);
        state_set_u8(h, kKeyPending, 0);
        clear_trial_failure(h);
        unlink(paths().pending);
        state_commit(h);
        state_close(h);
    }
    return true;
}

void core_running(char* chk, size_t chk_len, bool* out_trial) {
    bool trial = false;
    if (chk && chk_len) chk[0] = '\0';
    State h;
    if (state_open(&h, false)) {
        trial = state_u8(h, kKeyState, kStateGood) == kStateTrial;
        if (chk && chk_len) state_str(h, trial ? kKeyPendChk : kKeyInstChk, chk, chk_len);
        state_close(h);
    }
    if (out_trial) *out_trial = trial;
}

// Read the outcome the boot-time reconcile recorded, then clear it so a second
// call reads empty.
void core_reconcile(char* installed, size_t installed_len, bool* out_reverted, char* reason,
                    size_t reason_len, char* detail, size_t detail_len) {
    if (installed && installed_len) installed[0] = '\0';
    if (reason && reason_len) reason[0] = '\0';
    if (detail && detail_len) detail[0] = '\0';
    bool reverted = false;

    State h;
    if (state_open(&h, true)) {
        reverted = state_u8(h, kKeyORevert, 0) != 0;
        if (installed && installed_len) state_str(h, kKeyOInst, installed, installed_len);
        if (reason && reason_len) state_str(h, kKeyORsn, reason, reason_len);
        if (detail && detail_len) state_str(h, kKeyODetail, detail, detail_len);
        state_erase(h, kKeyOInst);
        state_erase(h, kKeyORevert);
        state_erase(h, kKeyORsn);
        state_erase(h, kKeyODetail);
        state_commit(h);
        state_close(h);
    }
    if (out_reverted) *out_reverted = reverted;
}

// ── JS bindings ──────────────────────────────────────────────────────────────
// Argument coercion and result shaping only; the work is in the cores above.

JSValue core_err_obj(JSContext* ctx, const CoreErr& e) {
    return err_obj_kind(ctx, e.msg ? e.msg : "ota error", e.kind);
}

// stageBegin(checksum, size) -> { ok, resumeOffset } | { ok:false, error }
JSValue js_stage_begin(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2) return err_obj(ctx, "missing checksum/size");
    const char* checksum = JS_ToCString(ctx, argv[0]);
    if (!checksum) {
        // JS_ToCString throws on a value with a throwing toString. Clear it
        // rather than strand it on the context for some unrelated later
        // operation to surface, the same way the size path below does.
        JS_FreeValue(ctx, JS_GetException(ctx));
        return err_obj(ctx, "checksum not a string");
    }
    int64_t size = 0;
    if (JS_ToInt64(ctx, &size, argv[1])) {
        JS_FreeCString(ctx, checksum);
        // JS_ToInt64 throws on a value with a throwing valueOf. We report through
        // the result object, so clear it rather than strand it on the context.
        JS_FreeValue(ctx, JS_GetException(ctx));
        return err_obj(ctx, "invalid size");
    }

    CoreErr e;
    int64_t resume = 0;
    bool ok = core_stage_begin(checksum, size, &resume, &e);
    JS_FreeCString(ctx, checksum);
    if (!ok) return core_err_obj(ctx, e);

    JSValue o = ok_obj(ctx);
    JS_SetPropertyStr(ctx, o, "resumeOffset", JS_NewInt64(ctx, resume));
    return o;
}

// stageWrite(bytes) -> { ok } | { ok:false, error, kind? }
JSValue js_stage_write(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return err_obj(ctx, "missing bytes");
    size_t len = 0;
    const uint8_t* data = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!data) {
        JS_FreeValue(ctx, JS_GetException(ctx));  // JS_GetUint8Array throws; we report via err_obj
        return err_obj(ctx, "bytes not a Uint8Array");
    }
    CoreErr e;
    if (!core_stage_write(data, len, &e)) return core_err_obj(ctx, e);
    return ok_obj(ctx);
}

// stageFinish(trialBoots, requireConfirm, installNow)
//   -> { ok } | { ok:false, error, kind }
// Verifies SHA-256 + size over the whole staged file, then either installs in
// place now (installNow) or marks a verified build staged-for-install so the
// next boot's reconcile installs it on a clean heap.
JSValue js_stage_finish(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    int64_t trial_boots = 1;
    if (argc >= 1 && JS_ToInt64(ctx, &trial_boots, argv[0])) {
        // A throwing valueOf leaves trial_boots indeterminate and an exception
        // pending; we report through the result object, so clear it and default.
        JS_FreeValue(ctx, JS_GetException(ctx));
        trial_boots = 1;
    }
    bool require_confirm = argc >= 2 && JS_ToBool(ctx, argv[1]);
    bool install_now = argc >= 3 && JS_ToBool(ctx, argv[2]);

    CoreErr e;
    if (!core_stage_finish(trial_boots, require_confirm, install_now, &e)) {
        return core_err_obj(ctx, e);
    }
    return ok_obj(ctx);
}

// stageAbort() -> void
JSValue js_stage_abort(JSContext*, JSValueConst, int, JSValueConst*) {
    core_stage_abort();
    return JS_UNDEFINED;
}

// markValid() -> void
JSValue js_mark_valid(JSContext*, JSValueConst, int, JSValueConst*) {
    core_mark_valid();
    return JS_UNDEFINED;
}

// revert() -> { ok } | { ok:false, error }. Re-install the last-good build.
JSValue js_revert(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    CoreErr e;
    // Historically reported without a kind, and the policy maps every revert
    // failure to transient anyway.
    if (!core_revert(&e)) return err_obj(ctx, e.msg ? e.msg : "revert failed");
    return ok_obj(ctx);
}

// running() -> { checksum?, trial }
JSValue js_running(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue o = JS_NewObject(ctx);
    char chk[96] = {0};
    bool trial = false;
    core_running(chk, sizeof(chk), &trial);
    if (chk[0]) JS_SetPropertyStr(ctx, o, "checksum", JS_NewString(ctx, chk));
    JS_SetPropertyStr(ctx, o, "trial", JS_NewBool(ctx, trial));
    return o;
}

// reconcile() -> { installed?, reverted, diagnostic? }
JSValue js_reconcile(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue o = JS_NewObject(ctx);
    char installed[96] = {0};
    char reason[96] = {0};
    char detail[160] = {0};
    bool reverted = false;
    core_reconcile(installed, sizeof(installed), &reverted, reason, sizeof(reason), detail,
                   sizeof(detail));

    if (installed[0]) JS_SetPropertyStr(ctx, o, "installed", JS_NewString(ctx, installed));
    JS_SetPropertyStr(ctx, o, "reverted", JS_NewBool(ctx, reverted));
    if (reason[0]) {
        JSValue diag = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, diag, "reason", JS_NewString(ctx, reason));
        if (detail[0]) JS_SetPropertyStr(ctx, diag, "detail", JS_NewString(ctx, detail));
        JS_SetPropertyStr(ctx, o, "diagnostic", diag);
    }
    return o;
}

// ── MIKOtaEnv install ops ────────────────────────────────────────────────────
// The native OTA client reaches the staging machinery through these. They are
// the same cores the JS bindings above call, so nothing can drift between the
// two implementations while both are in the tree.

namespace {

int env_err_kind(MIKBuildErr kind) {
    switch (kind) {
        case MIK_BUILD_ERR_CORRUPT:
            return MIK_OTA_ERR_CORRUPT;
        case MIK_BUILD_ERR_OOM:
            return MIK_OTA_ERR_OOM;
        case MIK_BUILD_ERR_TRANSIENT:
            break;
    }
    return MIK_OTA_ERR_TRANSIENT;
}

void env_copy_err(const CoreErr& e, char* err_buf, size_t err_len) {
    if (err_buf && err_len) snprintf(err_buf, err_len, "%s", e.msg ? e.msg : "ota error");
}

bool env_stage_begin(void*, const char* checksum, size_t size, size_t* out_resume, char* err_buf,
                     size_t err_len) {
    CoreErr e;
    int64_t resume = 0;
    if (!core_stage_begin(checksum, (int64_t)size, &resume, &e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    if (out_resume) *out_resume = (size_t)resume;
    return true;
}

bool env_stage_write(void*, const uint8_t* data, size_t len, char* err_buf, size_t err_len) {
    CoreErr e;
    if (!core_stage_write(data, len, &e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    return true;
}

bool env_stage_finish(void*, int trial_boots, bool require_confirm, bool install_now, char* err_buf,
                      size_t err_len, int* out_err_kind) {
    CoreErr e;
    if (!core_stage_finish(trial_boots, require_confirm, install_now, &e)) {
        env_copy_err(e, err_buf, err_len);
        if (out_err_kind) *out_err_kind = env_err_kind(e.kind);
        return false;
    }
    return true;
}

void env_stage_abort(void*) { core_stage_abort(); }
void env_mark_valid(void*) { core_mark_valid(); }

bool env_revert(void*, char* err_buf, size_t err_len) {
    CoreErr e;
    if (!core_revert(&e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    return true;
}

bool env_running(void*, MIKOtaRunningBuild* out) {
    if (!out) return false;
    *out = {};
    char chk[96] = {0};
    bool trial = false;
    core_running(chk, sizeof(chk), &trial);
    // The checksum field is a 64-hex digest plus its terminator; a longer value
    // could only come from a corrupted store, and truncating it is what the JS path
    // effectively did too.
    snprintf(out->checksum, sizeof(out->checksum), "%s", chk);
    out->trial = trial;
    // version is left empty on purpose: the policy fills it from the app's
    // package.json through read_app_version.
    return true;
}

void env_reconcile(void*, MIKOtaReconcileOutcome* out) {
    if (!out) return;
    *out = {};
    char installed[96] = {0};
    char reason[96] = {0};
    char detail[160] = {0};
    bool reverted = false;
    core_reconcile(installed, sizeof(installed), &reverted, reason, sizeof(reason), detail,
                   sizeof(detail));
    snprintf(out->installed, sizeof(out->installed), "%s", installed);
    out->reverted = reverted;
    if (reason[0]) {
        out->has_diagnostic = true;
        snprintf(out->diagnostic.reason, sizeof(out->diagnostic.reason), "%s", reason);
        snprintf(out->diagnostic.detail, sizeof(out->diagnostic.detail), "%s", detail);
    }
}

}  // namespace

// ── module registration ──────────────────────────────────────────────────────
int mik__ota_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "stageBegin",
                       JS_NewCFunction(ctx, js_stage_begin, "stageBegin", 2));
    JS_SetModuleExport(ctx, m, "stageWrite",
                       JS_NewCFunction(ctx, js_stage_write, "stageWrite", 1));
    JS_SetModuleExport(ctx, m, "stageFinish",
                       JS_NewCFunction(ctx, js_stage_finish, "stageFinish", 3));
    JS_SetModuleExport(ctx, m, "stageAbort",
                       JS_NewCFunction(ctx, js_stage_abort, "stageAbort", 0));
    JS_SetModuleExport(ctx, m, "markValid", JS_NewCFunction(ctx, js_mark_valid, "markValid", 0));
    JS_SetModuleExport(ctx, m, "revert", JS_NewCFunction(ctx, js_revert, "revert", 0));
    JS_SetModuleExport(ctx, m, "running", JS_NewCFunction(ctx, js_running, "running", 0));
    JS_SetModuleExport(ctx, m, "reconcile", JS_NewCFunction(ctx, js_reconcile, "reconcile", 0));
    return 0;
}

JSModuleDef* mik__ota_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/ota", mik__ota_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "stageBegin");
    JS_AddModuleExport(ctx, m, "stageWrite");
    JS_AddModuleExport(ctx, m, "stageFinish");
    JS_AddModuleExport(ctx, m, "stageAbort");
    JS_AddModuleExport(ctx, m, "markValid");
    JS_AddModuleExport(ctx, m, "revert");
    JS_AddModuleExport(ctx, m, "running");
    JS_AddModuleExport(ctx, m, "reconcile");
    return m;
}

// ── boot-time reconcile (trial state machine) ────────────────────────────────

// Map a reset reason to a trial verdict.
enum class TrialVerdict { kCrash, kNeutral, kClean };

// The platform's reset reason (MIKPlatform.get_reset_reason), as a stable string.
const char* reset_reason(void) {
    const MIKPlatform* p = MIK_GetPlatform();
    const char* r = p && p->get_reset_reason ? p->get_reset_reason() : nullptr;
    return r ? r : "unknown";
}

bool is_crash_reset(const char* r) {
    return strcmp(r, MIK_RESET_PANIC) == 0 || strcmp(r, MIK_RESET_INT_WATCHDOG) == 0 ||
           strcmp(r, MIK_RESET_TASK_WATCHDOG) == 0 || strcmp(r, MIK_RESET_WATCHDOG) == 0;
}

TrialVerdict classify_reset(const char* r) {
    if (is_crash_reset(r)) return TrialVerdict::kCrash;
    if (strcmp(r, MIK_RESET_BROWNOUT) == 0) {
        // Ambiguous: a bad supply, or the new build drawing more than the
        // board can deliver. Absorbed a bounded number of times (kNeutralBudget).
        return TrialVerdict::kNeutral;
    }
    // "power-on", "software", "deep-sleep", "external", ...: a cold start is an
    // ordinary boot: nothing went wrong, and the app is about to get its chance
    // to run and confirm. Counting it as neutral would let a mains device that
    // only ever power-cycles sit in an unresolved trial forever.
    return TrialVerdict::kClean;
}

// The crash's name for the revert diagnostic.
const char* reset_reason_name(const char* r) { return is_crash_reset(r) ? r : "crash"; }

// Record the just-installed checksum so reconcile() can report it after the
// post-install restart.
void record_installed(State& h, const char* chk) {
    state_set_str(h, kKeyOInst, chk);
}

void record_revert(State& h, const char* reason, const char* detail) {
    state_set_u8(h, kKeyORevert, 1);
    record_diag(h, reason, detail);
}

// The trial build is still what /app holds, so make instChk name it. Leaving
// instChk on the previous build would make running() report a checksum the
// device is not running: the registry would never re-offer the build that is
// actually live, and revert() would install the older build over the newer one.
void keep_trial_as_installed(State& h) {
    char chk[96];
    if (state_str(h, kKeyPendChk, chk, sizeof(chk))) state_set_str(h, kKeyInstChk, chk);
}

// Install the revert target, ending the trial. Both trial-failure paths funnel
// here so the attempt budget is charged identically.
//
// The budget is charged and committed BEFORE the install, for the reason the
// deferred-install path documents: install_build does not only return false, it
// can panic (a littlefs assert, the task watchdog, an allocation the OOM handler
// turns into a restart). Charging on the return paths alone means a rollback
// that crashes mid-install leaves the state untouched, so the next boot re-enters the
// identical rollback and the budget is never reached -- a loop only a reflash
// escapes, and one every device that took the bad build enters together.
//
// Returns false if the last-good build is not live, in which case the caller
// keeps the trial build and must carry pendChk across.
bool attempt_rollback(State& h, const char* reason, const char* detail) {
    if (!path_exists(paths().last_good)) {
        record_revert(h, reason, "no rollback build available");
        return false;
    }
    uint8_t left = state_u8(h, kKeyRbLeft, kRollbackBudget);
    if (left == 0) {
        record_revert(h, reason, "rollback install failed repeatedly; keeping this build");
        return false;
    }
    state_set_u8(h, kKeyRbLeft, (uint8_t)(left - 1));
    state_commit(h);

    const char* err = nullptr;
    MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
    if (!mik__install_build(paths().base, paths().last_good, &err, &kind)) {
        record_revert(h, reason, "rollback install failed");
        return false;
    }
    state_erase(h, kKeyRbLeft);
    record_revert(h, reason, detail);
    return true;
}

// Resolve a failed adopt install: drop the pending build, record the outcome
// for MIK_CMD_DEPLOY_RESULT, and leave the previous /app running. No rollback
// and no retry -- the developer is on the serial cable and re-pushes. Never
// touches the reconcile record (oRsn/oDetail), which reaches the registry.
void adopt_fail(State& h, const char* chk, const char* reason, const char* detail) {
    state_set_u8(h, kKeyPending, 0);
    state_erase(h, kKeyPendChk);
    state_erase(h, kKeyPendMode);
    state_erase(h, kKeyInstLeft);
    unlink(paths().pending);
    state_set_u8(h, kKeyDRes, 2);
    state_set_str(h, kKeyDChk, chk);
    state_set_str(h, kKeyDRsn, reason);
    state_set_str(h, kKeyDDetail, detail);
    state_commit(h);
}

}  // namespace

void mik__ota_fill_install_ops(MIKOtaEnv* env) {
    if (!env) return;
    env->stage_begin = env_stage_begin;
    env->stage_write = env_stage_write;
    env->stage_finish = env_stage_finish;
    env->stage_abort = env_stage_abort;
    env->mark_valid = env_mark_valid;
    env->revert = env_revert;
    env->running = env_running;
    env->reconcile = env_reconcile;
}

// Stage a streamed .tgz for adopt install at the next boot (the cable-deploy
// path, distinct from an OTA download which runs a trial). The install itself
// runs from MIK_OtaBootReconcile() on a clean heap: doing it here, with the
// app live, needs a 32 KB contiguous inflate window a fragmented heap cannot
// provide. Verification stays synchronous so a corrupt upload still fails over
// serial; empty checksum skips the check. NOT JS-exposed — called from the
// serial DEPLOY_BUILD handler.
bool MIK_OtaStageAdopt(const char* tgz_path, const char* checksum, const char** err) {
    if (!path_exists(tgz_path)) {
        *err = "build not staged";
        return false;
    }
    if (checksum && checksum[0]) {
        char got[65];
        if (!mik__sha256_file(tgz_path, got)) {
            *err = "read staged build";
            return false;
        }
        if (strcmp(got, checksum) != 0) {
            *err = "checksum mismatch (corrupt build)";
            return false;
        }
    }
    State h;
    if (!state_open(&h, true)) {
        *err = "OTA state unavailable";
        return false;
    }
    // Move the .tgz out of the deploy tmp tree before acking: MIK_DeployRecover
    // cleans that tree at boot, before the reconcile would read it. Rename
    // before anything else mutates: a failed rename (e.g. littlefs metadata
    // ENOSPC) must error back over serial having left trial state untouched.
    unlink(paths().pending);
    if (rename(tgz_path, paths().pending) != 0) {
        state_close(h);
        *err = "stage pending build";
        return false;
    }
    // A cable deploy supersedes an in-flight trial. Resolve it to GOOD now,
    // while the trial's checksum is still in pendChk (overwritten below): the
    // trial build is what /app holds, so it becomes the installed build, the
    // same accounting the reflash guard does. Without this, the next boot's
    // trial verdict would roll back or promote against the pending slot this
    // deploy just replaced.
    if (state_u8(h, kKeyState, kStateGood) == kStateTrial) {
        char trial_chk[96];
        if (state_str(h, kKeyPendChk, trial_chk, sizeof(trial_chk))) {
            state_set_str(h, kKeyInstChk, trial_chk);
        }
        state_set_u8(h, kKeyState, kStateGood);
        state_set_u8(h, kKeyTrialLeft, 0);
        state_erase(h, kKeyPromLeft);
        state_erase(h, kKeyRbLeft);
        state_erase(h, kKeyNeutLeft);
        clear_trial_failure(h);
    }
    state_set_str(h, kKeyPendChk, checksum ? checksum : "");
    state_set_u8(h, kKeyPendMode, kPendModeAdopt);
    state_set_u8(h, kKeyPending, 1);
    state_set_u8(h, kKeyInstLeft, 1);  // one attempt: the developer is on the cable
    // Drop any unread outcome from an earlier adopt (e.g. a --no-restart deploy
    // that installed at a natural boot), so the post-restart result read can
    // only ever see this deploy's outcome.
    state_erase(h, kKeyDRes);
    state_erase(h, kKeyDChk);
    state_erase(h, kKeyDRsn);
    state_erase(h, kKeyDDetail);
    state_commit(h);
    state_close(h);
    return true;
}

// Read and clear the adopt-install outcome for MIK_CMD_DEPLOY_RESULT.
void mik__ota_take_deploy_result(MIKDeployResult* out) {
    memset(out, 0, sizeof(*out));
    State h;
    if (!state_open(&h, true)) return;
    out->status = state_u8(h, kKeyDRes, 0);
    state_str(h, kKeyDChk, out->checksum, sizeof(out->checksum));
    state_str(h, kKeyDRsn, out->reason, sizeof(out->reason));
    state_str(h, kKeyDDetail, out->detail, sizeof(out->detail));
    if (out->status != 0) {
        state_erase(h, kKeyDRes);
        state_erase(h, kKeyDChk);
        state_erase(h, kKeyDRsn);
        state_erase(h, kKeyDDetail);
        state_commit(h);
    }
    state_close(h);
}

// MIK_CMD_DEPLOY_RESULT. Reply: u8 status | 3 x (u16le len | bytes) for the
// checksum, the reason and the detail.
bool MIK_OtaHandleDeployResult(MIKReplTransport* transport, uint32_t payload_len) {
    mik__proto_drain(transport, payload_len);
    MIKDeployResult res;
    mik__ota_take_deploy_result(&res);
    uint8_t buf[1 + 3 * 2 + sizeof(res.checksum) + sizeof(res.reason) + sizeof(res.detail)];
    size_t n = 0;
    buf[n++] = res.status;
    const char* fields[] = {res.checksum, res.reason, res.detail};
    for (const char* s : fields) {
        size_t len = strlen(s);
        buf[n++] = (uint8_t)(len & 0xFF);
        buf[n++] = (uint8_t)((len >> 8) & 0xFF);
        memcpy(buf + n, s, len);
        n += len;
    }
    mik__proto_send(transport, MIK_MSG_OK, buf, n);
    return true;
}

// True while an unconfirmed OTA trial is the running build.
bool mik__ota_in_trial(void) {
    State h;
    if (!state_open(&h, false)) return false;
    bool trial = state_u8(h, kKeyState, kStateGood) == kStateTrial;
    state_close(h);
    return trial;
}

// Flag the running trial as failed after a fatal JS error, so the next reconcile
// reverts it even though the reboot will look like a clean software reset. No-op
// outside a trial; the first detail recorded wins.
static void note_trial_failure(const char* detail) {
    State h;
    if (!state_open(&h, true)) return;
    if (state_u8(h, kKeyState, kStateGood) == kStateTrial && state_u8(h, kKeyTrialBad, 0) == 0) {
        state_set_u8(h, kKeyTrialBad, 1);
        if (detail && detail[0]) state_set_str(h, kKeyBadDetail, detail);
        state_commit(h);
    }
    state_close(h);
}

void MIK_OtaTrialErrorHandler(JSContext* ctx, JSValue error, void* /*opaque*/) {
    if (!mik__ota_in_trial()) {
        return;
    }
    char detail[160] = "uncaught error";
    if (JS_IsObject(error)) {
        JSValue name_v = JS_GetPropertyStr(ctx, error, "name");
        JSValue msg_v = JS_GetPropertyStr(ctx, error, "message");
        const char* name = JS_ToCString(ctx, name_v);
        const char* msg = JS_ToCString(ctx, msg_v);
        if (name && name[0] && msg && msg[0]) {
            snprintf(detail, sizeof(detail), "%s: %s", name, msg);
        } else if (msg && msg[0]) {
            snprintf(detail, sizeof(detail), "%s", msg);
        } else if (name && name[0]) {
            snprintf(detail, sizeof(detail), "%s", name);
        }
        /* A throwing getter (or a toString that throws) leaves an exception
         * pending on ctx that nothing downstream would ever clear. */
        if (!name || !msg) {
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
        if (name) JS_FreeCString(ctx, name);
        if (msg) JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, name_v);
        JS_FreeValue(ctx, msg_v);
    }
    note_trial_failure(detail);
}

// Boot reconcile: NOT JS-exposed. Called by the port before the JS app loads,
// after MIK_DeployRecover(). Runs the reflash guard, an adopt install (cable
// deploy), the trial verdict, and a deferred trial install in that order. True
// when it installed a build the port should start fresh (see mikrojs/ota.h).
bool MIK_OtaBootReconcile(void) {
    State h;
    if (!state_open(&h, true)) return false;

    // Legacy leftover: firmware that installed cable deploys synchronously
    // staged its install source here and could die before promoting it. Never
    // valid across a boot, and a whole build's worth of flash.
    unlink(paths().last_good_tmp);

    // 1. Reflash guard. An out-of-band flash (`idf.py flash`) swaps
    //    the firmware without touching OTA state; a stale pending/staged build
    //    must not then revert or overwrite the freshly-flashed /app. Detect via
    //    the device store's firmware hash and scrub OTA install state when it
    //    changed.
    const char* fw_now = h.store->firmware_hash ? h.store->firmware_hash() : nullptr;
    char fw_stored[65];
    bool have_fw = state_str(h, kKeyFwHash, fw_stored, sizeof(fw_stored));
    if (fw_now && (!have_fw || strcmp(fw_stored, fw_now) != 0)) {
        // A firmware flash leaves /appfs alone, so if a trial was in flight the
        // trial build is what /app still holds. Forcing GOOD without moving
        // pendChk across would leave instChk naming the previous build: the
        // device would report the wrong checksum to the registry forever, and
        // revert() would install that older build over the newer live one.
        if (state_u8(h, kKeyState, kStateGood) == kStateTrial) {
            char pend_chk[96];
            if (state_str(h, kKeyPendChk, pend_chk, sizeof(pend_chk))) {
                state_set_str(h, kKeyInstChk, pend_chk);
            }
        }
        state_erase(h, kKeyPendChk);
        state_erase(h, kKeyPendMode);
        state_set_u8(h, kKeyState, kStateGood);
        state_set_u8(h, kKeyTrialLeft, 0);
        state_set_u8(h, kKeyPending, 0);
        unlink(paths().pending);
        unlink(paths().staging);
        state_erase(h, kKeyStgChk);
        state_erase(h, kKeyStgSize);
        state_set_str(h, kKeyFwHash, fw_now);
        state_commit(h);
    }

    // 2. Adopt install: a cable deploy staged by MIK_CMD_DEPLOY_BUILD. No
    //    trial, no rollback baseline, one attempt (charged before the attempt,
    //    same crash reasoning as the deferred install below). Runs before the
    //    trial verdict as a backstop: stage_adopt resolves an in-flight trial
    //    at stage time, but stale trial state must never roll back or promote
    //    against the pending slot the deploy overwrote.
    if (state_u8(h, kKeyPending, 0) == 1 &&
        state_u8(h, kKeyPendMode, kPendModeTrial) == kPendModeAdopt) {
        char chk[96] = {0};
        state_str(h, kKeyPendChk, chk, sizeof(chk));
        if (!path_exists(paths().pending)) {
            adopt_fail(h, chk, "install-failed", "staged build missing");
            state_close(h);
            return false;
        }
        uint8_t left = state_u8(h, kKeyInstLeft, 1);
        if (left == 0) {
            // The charged attempt never came back: the install panicked.
            adopt_fail(h, chk, "install-failed", "install did not complete (device restarted)");
            state_close(h);
            return false;
        }
        state_set_u8(h, kKeyInstLeft, (uint8_t)(left - 1));
        state_commit(h);

        const char* err = nullptr;
        MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
        if (!mik__install_build(paths().base, paths().pending, &err, &kind)) {
            adopt_fail(h, chk, kind == MIK_BUILD_ERR_CORRUPT ? "install-corrupt" : "install-failed",
                       err != nullptr ? err : "install failed");
            state_close(h);
            return false;
        }
        // Installed. A cable deploy resets the OTA safety story like a reflash
        // does: nothing to roll back to until the next OTA trial promotes.
        unlink(paths().pending);
        unlink(paths().last_good);
        state_set_str(h, kKeyInstChk, chk);
        state_set_u8(h, kKeyState, kStateGood);
        state_set_u8(h, kKeyTrialLeft, 0);
        state_set_u8(h, kKeyPending, 0);
        state_erase(h, kKeyPendChk);
        state_erase(h, kKeyPendMode);
        state_erase(h, kKeyInstLeft);
        state_erase(h, kKeyPromLeft);
        state_erase(h, kKeyRbLeft);
        state_erase(h, kKeyNeutLeft);
        clear_trial_failure(h);
        state_set_u8(h, kKeyDRes, 1);
        state_set_str(h, kKeyDChk, chk);
        state_erase(h, kKeyDRsn);
        state_erase(h, kKeyDDetail);
        state_commit(h);
        state_close(h);
        return true;  // start the deployed app on a clean heap
    }

    // 3. Trial verdict. Evaluate why we just reset while a trial was in flight.
    if (state_u8(h, kKeyState, kStateGood) == kStateTrial) {
        const char* reason = reset_reason();
        TrialVerdict verdict = classify_reset(reason);
        // A fatal JS error the trial app flagged in-process (a top-level throw or
        // an unhandled rejection) reboots as a clean software reset, which would
        // otherwise be read as "survived". Treat it like a crash.
        bool js_failed = state_u8(h, kKeyTrialBad, 0) != 0;
        if (js_failed || verdict == TrialVerdict::kCrash) {
            // The new app failed: roll back to last-good immediately, bypassing
            // the counter. If no rollback build exists (first-ever OTA), we
            // can't reinstall — stop the trial loop and record the diagnostic so
            // the app can surface it (the deploy app remains serial-recoverable).
            char detail[160];
            const char* rsn;
            const char* why;
            if (js_failed) {
                rsn = "startup-crash";
                if (!state_str(h, kKeyBadDetail, detail, sizeof(detail))) {
                    snprintf(detail, sizeof(detail), "trial app threw at startup");
                }
                why = detail;
            } else {
                rsn = reset_reason_name(reason);
                why = "reverted to last-good build";
            }
            if (!attempt_rollback(h, rsn, why)) keep_trial_as_installed(h);
            state_set_u8(h, kKeyState, kStateGood);
            state_set_u8(h, kKeyTrialLeft, 0);
            state_set_u8(h, kKeyPending, 0);
            state_erase(h, kKeyPendChk);
            state_erase(h, kKeyTrialBad);
            state_erase(h, kKeyBadDetail);
            unlink(paths().pending);
            state_commit(h);
            state_close(h);
            return false;
        }
        if (verdict == TrialVerdict::kNeutral) {
            uint8_t left = state_u8(h, kKeyNeutLeft, kNeutralBudget);
            if (left > 0) {
                state_set_u8(h, kKeyNeutLeft, (uint8_t)(left - 1));
                state_commit(h);
            } else {
                // Budget spent: stop absorbing and let the trial progress on the
                // clean path, so it reaches a verdict instead of staying open.
                verdict = TrialVerdict::kClean;
            }
        }
        if (verdict == TrialVerdict::kClean) {
            uint8_t left = state_u8(h, kKeyTrialLeft, 0);
            bool confirm = state_u8(h, kKeyConfirm, 0) != 0;
            if (left == 0) {
                if (confirm) {
                    // Trial elapsed without an explicit markValid(): roll back.
                    if (!attempt_rollback(h, "unconfirmed",
                                          "trial elapsed without markValid()")) {
                        keep_trial_as_installed(h);
                    }
                    state_set_u8(h, kKeyState, kStateGood);
                    state_set_u8(h, kKeyPending, 0);
                    state_erase(h, kKeyPendChk);
                    unlink(paths().pending);
                } else if (promote_pending()) {
                    // Promote: the trial proved stable.
                    char chk[96];
                    if (state_str(h, kKeyPendChk, chk, sizeof(chk))) {
                        state_set_str(h, kKeyInstChk, chk);
                    }
                    state_set_u8(h, kKeyState, kStateGood);
                    state_erase(h, kKeyPromLeft);
                } else if (uint8_t prom = state_u8(h, kKeyPromLeft, kPromoteBudget); prom > 1) {
                    // Stay in the trial rather than go GOOD with no revert
                    // target; the next clean boot retries the promotion.
                    state_set_u8(h, kKeyPromLeft, (uint8_t)(prom - 1));
                    record_diag(h, "promote-failed",
                                "could not make the trial build the revert target");
                } else {
                    // Budget spent, so the failure is not transient (paths().pending
                    // lost, or a filesystem that will not take the rename).
                    // Resolve to GOOD with no revert target. That is the lesser
                    // loss: the build has survived its whole trial and is
                    // running, whereas staying in TRIAL makes applyOffer skip
                    // every future offer, so the one channel that could ship a
                    // fix is shut. The next update re-establishes a baseline.
                    char chk[96];
                    if (state_str(h, kKeyPendChk, chk, sizeof(chk))) {
                        state_set_str(h, kKeyInstChk, chk);
                    }
                    state_set_u8(h, kKeyState, kStateGood);
                    state_set_u8(h, kKeyPending, 0);
                    state_erase(h, kKeyPromLeft);
                    unlink(paths().pending);
                    record_diag(h, "promote-failed",
                                "gave up making the trial build the revert target; "
                                "this build is kept but cannot be rolled back");
                }
                state_commit(h);
            } else {
                state_set_u8(h, kKeyTrialLeft, (uint8_t)(left - 1));
                state_commit(h);
            }
        }
        // kNeutral: don't penalize — leave the trial untouched and proceed.
    }

    // 4. Deferred trial install. A build verified by stageFinish(installNow=
    //    false) is installed here, on a clean heap, then we restart into its
    //    trial. (An adopt-mode pending build never reaches this: step 2
    //    returns.)
    if (state_u8(h, kKeyPending, 0) == 1 && state_u8(h, kKeyState, kStateGood) == kStateGood) {
        if (!path_exists(paths().pending)) {
            state_set_u8(h, kKeyPending, 0);
            state_commit(h);
            state_close(h);
            return false;
        }
        // Charge the attempt BEFORE making it, and commit, so the budget
        // survives a boot that never comes back. install_build does not only
        // return false: it can panic (a littlefs assert, the task watchdog, an
        // allocation the OOM handler turns into a restart). Decrementing on the
        // return paths alone means a build that crashes mid-install leaves the state
        // untouched, so the next boot re-enters the identical install and the
        // budget is never reached — a fleet-wide loop only a reflash escapes.
        // Same reasoning the install's rmtree depth cap is documented with.
        uint8_t inst_left = state_u8(h, kKeyInstLeft, kInstallBudget);
        if (inst_left == 0) {
            state_set_u8(h, kKeyPending, 0);
            unlink(paths().pending);
            state_commit(h);
            state_close(h);
            return false;
        }
        state_set_u8(h, kKeyInstLeft, (uint8_t)(inst_left - 1));
        state_commit(h);

        const char* err = nullptr;
        MIKBuildErr kind = MIK_BUILD_ERR_TRANSIENT;
        if (mik__install_build(paths().base, paths().pending, &err, &kind)) {
            char chk[96] = {0};
            state_str(h, kKeyPendChk, chk, sizeof(chk));
            record_installed(h, chk);
            uint8_t trial_n = state_u8(h, kKeyTrialN, 1);
            state_set_u8(h, kKeyState, kStateTrial);
            state_set_u8(h, kKeyTrialLeft, trial_n);
            state_set_u8(h, kKeyPending, 0);
            state_erase(h, kKeyPromLeft);  // per-trial budgets
            state_erase(h, kKeyRbLeft);
            state_erase(h, kKeyNeutLeft);
            state_set_u8(h, kKeyTrialBad, 0);  // fresh trial: clear any prior crash flag
            state_erase(h, kKeyBadDetail);
            state_commit(h);
            state_close(h);
            return true;  // start the freshly-installed app on a clean heap
        }
        // Recorded like every other failure, and for a reason this path needs
        // more than most: the diagnostic is what reaches the registry as
        // `lastInstall`, and that is what stops the same build being offered
        // again. Without it a build that verifies but will not unpack is
        // re-downloaded and rewritten to flash on every boot, forever, since
        // nothing on either side learns it failed. `install: 'next-boot'` is
        // the default, so this is the ordinary path, not a corner.
        record_diag(h, kind == MIK_BUILD_ERR_CORRUPT ? "install-corrupt" : "install-failed",
                    err != nullptr ? err : "deferred install failed");
        // The attempt is already charged above; this only decides whether to
        // keep the build for another boot.
        if (kind == MIK_BUILD_ERR_CORRUPT) {
            state_set_u8(h, kKeyPending, 0);  // identical bytes can't succeed — abandon
            unlink(paths().pending);
        } else if (inst_left <= 1) {
            state_set_u8(h, kKeyPending, 0);  // budget exhausted — abandon
            unlink(paths().pending);
        }
        state_commit(h);
    }
    state_close(h);
    return false;
}

MIK_REGISTER_MODULE(ota, "native:mikro/ota", mik__ota_init, nullptr, nullptr)

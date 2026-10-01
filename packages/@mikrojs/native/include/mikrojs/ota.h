/* Over-the-air updates of the app build (mik_ota.cpp, mik_ota_env.cpp,
 * mik_ota_client_module.cpp): the platform-facing entry points. The install
 * state and the app filesystem come from the device store (device_store.h),
 * the network from the HTTP module's native path (http_native.h). */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_env.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Boot reconcile. Runs before the JS app loads, after MIK_DeployRecover():
 * reflash guard, a cable-deploy (adopt) install, the trial verdict, and a
 * deferred clean-heap install of a staged build. True when it installed a
 * build the platform should now start fresh: the ESP32 restarts the chip, a
 * port that restarts the app in place starts a new session. */
bool MIK_OtaBootReconcile(void);

/* Stage a streamed .tgz for install at the next boot with adopt semantics:
 * no trial, no rollback baseline, one install attempt. Backs
 * MIK_CMD_DEPLOY_BUILD through the device store's stage_build. Verifies the
 * build against `checksum` (lowercase hex, may be empty to skip) so a corrupt
 * upload still fails synchronously over serial, then marks it pending for the
 * boot reconcile's adopt install. Returns false with *err pointing at a static
 * reason string on failure. */
bool MIK_OtaStageAdopt(const char* tgz_path, const char* checksum, const char** err);

/* Outcome of the last adopt-mode boot install, for MIK_CMD_DEPLOY_RESULT.
 * Kept separate from the reconcile record on purpose: that record reaches the
 * registry as `lastInstall` and would blacklist a checksum a developer is
 * about to legitimately re-push over the cable. */
typedef struct MIKDeployResult {
    uint8_t status; /* 0 none, 1 ok, 2 fail */
    char checksum[96];
    char reason[32];
    char detail[160];
} MIKDeployResult;

/* Handle MIK_CMD_DEPLOY_RESULT: reply with the recorded adopt-install outcome
 * and clear it. Not part of MIK_HandleDeployCommand, because it is read after
 * the post-deploy restart and must not start a deploy session. */
bool MIK_OtaHandleDeployResult(MIKReplTransport* transport, uint32_t payload_len);

/* Error handler (MIK_SetErrorHandler) for the app runtime. A fatal JS error
 * (an uncaught exception or unhandled rejection) during a trial is recorded,
 * so the next reconcile reverts the build even though the restart looks clean.
 * No-op outside a trial. */
void MIK_OtaTrialErrorHandler(JSContext* ctx, JSValue error, void* opaque);

/* ── Internal to the library ─────────────────────────────────────── */

/* Read and clear the recorded adopt-install outcome. status 0 with empty
 * strings when nothing is recorded. */
void mik__ota_take_deploy_result(MIKDeployResult* out);

/* True while the running build is an unconfirmed OTA trial. */
bool mik__ota_in_trial(void);

/* Fill the install-op slots of an OTA env with the staging machinery, the same
 * cores the native:mikro/ota JS bindings call. */
void mik__ota_fill_install_ops(MIKOtaEnv* env);

/* The OTA environment for this runtime, fully populated (install ops, kv,
 * HTTP, identity, clock). Valid until the runtime is freed. `bytecode_version`
 * comes from the module init, which has a JSContext. */
const MIKOtaEnv* mik__ota_env_for(struct MIKRuntime* rt, int bytecode_version);

#ifdef __cplusplus
}
#endif

#pragma once

/**
 * The config sync slots, as the device persists them.
 *
 * Three slots mirror the build's install slots: `current` is what the running
 * build reads, `next` is staged alongside an offered build, `prev` is the
 * rollback baseline while a delivery is unresolved. Shared by the check-in
 * client and the `ota.config()` reader so the two agree on keys and shapes.
 */

#include <cstdint>
#include <vector>

#include "mikrojs/ota_env.h"

namespace mikrojs {

/* A stored config, plus the buffer its `doc` span points into. */
struct MIKOtaLoadedConfig {
    MIKOtaStoredConfig cfg = {};
    std::vector<uint8_t> bytes;
    /* A well-formed document was read. */
    bool present = false;
    /* The store could not answer. `present` is false but says nothing: callers
     * that must not mistake a starved read for a clear check this first. */
    bool failed = false;
};

MIKOtaLoadedConfig mik__ota_load_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot);
void mik__ota_store_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot,
                         const MIKOtaStoredConfig& cfg);
void mik__ota_clear_slot(const MIKOtaEnv* env, MIKOtaConfigSlot slot);

/* The running-release delivery trial; absent = no trial in progress. A
 * malformed value reads as absent, but an unreadable store reads as ERROR: the
 * config reader must not burn a trial boot on a read it never got. */
MIKOtaKvStatus mik__ota_load_trial(const MIKOtaEnv* env, MIKOtaConfigTrial* out);
void mik__ota_store_trial(const MIKOtaEnv* env, const MIKOtaConfigTrial& trial);
void mik__ota_clear_trial(const MIKOtaEnv* env);

/* The rolled-back document's rev and why, reported until replaced. */
bool mik__ota_load_config_error(const MIKOtaEnv* env, MIKOtaConfigErrorReport* out);
void mik__ota_store_config_error(const MIKOtaEnv* env, const MIKOtaConfigErrorReport& report);
void mik__ota_clear_config_error(const MIKOtaEnv* env);

}  // namespace mikrojs

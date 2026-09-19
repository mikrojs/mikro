#ifndef MIKROJS_DEVICE_STORE_H
#define MIKROJS_DEVICE_STORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_env.h"

#ifdef __cplusplus
extern "C" {
#endif

/* `value` is NULL for a secret and for a value that could not be read. */
typedef void (*MIKEnvEachFn)(const char* key, const char* value, bool secret, void* ud);

/* Storage the deploy and config handlers and the OTA install core need from a
 * platform: the app filesystem root, a key store for env vars and kv seeds, a
 * firmware identity and the OTA install state. LittleFS + NVS on the ESP32. */
typedef struct MIKDeviceStore {
    /* App filesystem root, e.g. "/appfs". Deploy paths are appended to it. */
    const char* fs_base;
    /* Hex identity of the running firmware, stamped into the deploy checksums
     * manifest so a reflash invalidates it. NULL disables the stamp. */
    const char* (*firmware_hash)(void);
    /* Stage a streamed build archive for install: MIK_OtaStageAdopt on a port
     * with OTA. A hook because builds without mik_ota.cpp, the host library
     * among them, cannot link it. NULL: builds unsupported. */
    bool (*stage_build)(const char* tgz_path, const char* checksum, const char** err);

    /* Config hooks. Any may be NULL: env_each then lists no env vars, and the
     * command behind each of the others is refused. */
    void (*env_each)(MIKEnvEachFn fn, void* ud);
    bool (*env_set)(const char* key, const char* value, bool secret, bool* out_changed);
    /* Returns true if the key existed. */
    bool (*env_delete)(const char* key);
    /* ns is "mik.kv" or "mik.sys"; blob is one CBOR value. */
    bool (*kv_set)(const char* ns, const char* key, const uint8_t* blob, size_t len);
    /* 1 existed, 0 absent, -1 failed. */
    int (*kv_delete)(const char* ns, const char* key);

    /* OTA hooks (mik_ota.cpp, mik_ota_env.cpp). NULL state_open: no OTA.
     *
     * kv_get reads a blob that kv_set wrote. With `out` NULL it writes the size
     * into *inout_len. Absent and failed are different answers: see
     * MIKOtaKvStatus. */
    MIKOtaKvStatus (*kv_get)(const char* ns, const char* key, uint8_t* out, size_t* inout_len);
    /* The install state: small typed values in the "mik.ota" namespace, read
     * and written between state_open and state_close. state_commit makes the
     * writes durable. The ESP32 keeps them in NVS with its own types, so the
     * state of a device updated from older firmware stays readable. */
    void* (*state_open)(bool writable);
    void (*state_close)(void* h);
    bool (*state_commit)(void* h);
    bool (*state_get_u8)(void* h, const char* key, uint8_t* out);
    bool (*state_set_u8)(void* h, const char* key, uint8_t value);
    bool (*state_get_u32)(void* h, const char* key, uint32_t* out);
    bool (*state_set_u32)(void* h, const char* key, uint32_t value);
    /* A NUL-terminated string that fits `cap`. False when absent, empty or
     * too long. */
    bool (*state_get_str)(void* h, const char* key, char* out, size_t cap);
    bool (*state_set_str)(void* h, const char* key, const char* value);
    void (*state_erase)(void* h, const char* key);
} MIKDeviceStore;

void MIK_SetDeviceStore(const MIKDeviceStore* store);
/* Internal to the library: the store set above, or NULL. */
const MIKDeviceStore* mik__device_store(void);

/* Protocol handlers (mik_deploy.cpp, mik_config.cpp). They read their payload
 * from the transport themselves. */
bool MIK_HandleDeployCommand(MIKReplTransport* transport, uint8_t cmd_type, uint32_t payload_len);
bool MIK_HandleConfigCommand(MIKReplTransport* transport, uint8_t cmd_type, uint32_t payload_len);
void MIK_DeploySessionReset(void);

/* Finish an interrupted deploy swap. Call at boot before loading the app. */
void MIK_DeployRecover(void);

#ifdef __cplusplus
}
#endif

#endif /* MIKROJS_DEVICE_STORE_H */

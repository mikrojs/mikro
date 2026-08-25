#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MIKOtaEnv MIKOtaEnv;

/* HTTP callbacks. All three fire *after* http_request has returned, from
 * whatever drains the transport (the loop consumer on device, Tick() in the
 * host tests) — never re-entrantly from inside the call itself. */

/* Response status, delivered before any body byte. The client needs it ahead
 * of the body: a 206 means the Range was honoured and no prefix must be
 * dropped, and a 401 body is discarded rather than staged. */
typedef void (*MIKOtaHttpHeadersCb)(void* user_data, int status);
typedef void (*MIKOtaHttpDataCb)(void* user_data, const uint8_t* data, size_t len);
/* Terminal, exactly once per request. `status` repeats the response status, or
 * is 0 when the exchange never completed; `error_msg` is NULL on success. */
typedef void (*MIKOtaHttpDoneCb)(void* user_data, int status, const char* error_msg);

typedef struct MIKOtaHttpCallbacks {
    MIKOtaHttpHeadersCb headers;
    MIKOtaHttpDataCb data;
    MIKOtaHttpDoneCb done;
    void* user_data;
} MIKOtaHttpCallbacks;

typedef struct MIKOtaHttpRequest {
    const char* url;
    const char* method; /* "GET" or "POST" */
    const char* const* header_keys;
    const char* const* header_values;
    size_t header_count;
    const uint8_t* body;
    size_t body_len;
    uint32_t timeout_ms;
} MIKOtaHttpRequest;

/* Device identity */
typedef struct MIKDeviceIdentity {
    char device_id[64];
    char firmware_version[32];
    char firmware_hash[65];
    int bytecode_version;
} MIKDeviceIdentity;

/* Diagnostic info from reconcile */
typedef struct MIKOtaDiagnostic {
    char reason[64];
    char detail[128];
} MIKOtaDiagnostic;

/* Reconcile outcome */
typedef struct MIKOtaReconcileOutcome {
    char installed[65]; /* SHA-256 hex or empty string if none */
    bool reverted;
    bool has_diagnostic;
    MIKOtaDiagnostic diagnostic;
} MIKOtaReconcileOutcome;

/* Running build info */
typedef struct MIKOtaRunningBuild {
    char checksum[65]; /* SHA-256 hex or empty string if none */
    char version[32];  /* package.json version or empty string if none */
    bool trial;
} MIKOtaRunningBuild;

/* Install error kind: 0 = corrupt, 1 = transient, 2 = oom */
enum {
    MIK_OTA_ERR_CORRUPT = 0,
    MIK_OTA_ERR_TRANSIENT = 1,
    MIK_OTA_ERR_OOM = 2,
};

/* Outcome of a kv read. */
typedef enum MIKOtaKvStatus {
    MIK_OTA_KV_OK = 0,
    /* Nothing was ever stored under this key. */
    MIK_OTA_KV_ABSENT = 1,
    /* The store could not answer — out of heap, backend error. Says nothing
     * about whether a value exists. */
    MIK_OTA_KV_ERROR = 2,
} MIKOtaKvStatus;

/* Config slots */
typedef enum MIKOtaConfigSlot {
    MIK_OTA_CFG_CURRENT = 0,
    MIK_OTA_CFG_NEXT = 1,
    MIK_OTA_CFG_PREV = 2,
} MIKOtaConfigSlot;

/* Config trial state */
typedef struct MIKOtaConfigTrial {
    int left;
    bool read;
} MIKOtaConfigTrial;

/* The spec caps a config rev at 64 characters (the reference registry emits
 * 16); plus the NUL. A short buffer truncates, and a truncated echo never
 * matches the current rev, so the registry re-sends the document forever. */
#define MIK_OTA_REV_MAX 65

/* Config error report */
typedef struct MIKOtaConfigErrorReport {
    char rev[MIK_OTA_REV_MAX];
    char message[256];
} MIKOtaConfigErrorReport;

/* Stored config document representation */
typedef struct MIKOtaStoredConfig {
    char rev[MIK_OTA_REV_MAX]; /* empty string if none */
    char version[32];          /* required */
    uint8_t* doc_cbor;         /* CBOR-encoded document bytes, or NULL if absent/clear */
    size_t doc_cbor_len;
} MIKOtaStoredConfig;

/* MIKOtaEnv struct: the platform seam for OTA policy and client state machine */
struct MIKOtaEnv {
    void* opaque;

    /* ── HTTP ─────────────────────────────────────────────────────────── */
    /* Start a request. Returns an opaque handle, or NULL when it could not be
     * started (the client treats that as a failed round).
     *
     * Everything reachable from `req` and `cbs` is borrowed for the duration of
     * this call only — url, headers and body included. A transport that outlives
     * the call must copy what it needs before returning. */
    void* (*http_request)(void* opaque, const MIKOtaHttpRequest* req,
                          const MIKOtaHttpCallbacks* cbs);
    /* Abandon an in-flight request. No further callbacks fire for it. */
    void (*http_cancel)(void* opaque, void* req_handle);

    /* ── KV store (mik.sys namespace) ─────────────────────────────────── */
    /* Read a blob. With out_buf NULL, writes the required size into inout_len.
     *
     * Absent and failed are different answers and must not be merged: the config
     * reader falls back to the build's manifest defaults on absent, but holds the
     * last document it read on failure. Collapsing the two flips a live device
     * onto defaults for a beat whenever a read is starved of heap — which is
     * exactly when a TLS handshake is in flight. */
    MIKOtaKvStatus (*kv_get_blob)(void* opaque, const char* key, uint8_t* out_buf,
                                  size_t* inout_len);
    bool (*kv_set_blob)(void* opaque, const char* key, const uint8_t* data, size_t len);
    /* NOTE: the string and integer getters are still two-valued. Their callers
     * (the retry-budget store) read a failure as absence, which hands the budget
     * back a boot early. Same class of bug as the blob case above; worth the same
     * treatment when the policy's error handling is revisited. */
    bool (*kv_get_str)(void* opaque, const char* key, char* out_buf, size_t max_len);
    bool (*kv_set_str)(void* opaque, const char* key, const char* val);
    bool (*kv_get_i32)(void* opaque, const char* key, int32_t* out_val);
    bool (*kv_set_i32)(void* opaque, const char* key, int32_t val);
    bool (*kv_remove)(void* opaque, const char* key);

    /* ── Install ops (firmware mik_ota.cpp) ────────────────────────────── */
    bool (*stage_begin)(void* opaque, const char* checksum, size_t size, size_t* out_resume_offset,
                        char* err_buf, size_t err_len);
    bool (*stage_write)(void* opaque, const uint8_t* data, size_t len, char* err_buf,
                        size_t err_len);
    bool (*stage_finish)(void* opaque, int trial_boots, bool require_confirm, bool install_now,
                         char* err_buf, size_t err_len, int* out_err_kind);
    void (*stage_abort)(void* opaque);
    void (*mark_valid)(void* opaque);
    bool (*revert)(void* opaque, char* err_buf, size_t err_len);
    bool (*running)(void* opaque, MIKOtaRunningBuild* out_running);
    void (*reconcile)(void* opaque, MIKOtaReconcileOutcome* out_outcome);

    /* ── System / Identity ────────────────────────────────────────────── */
    bool (*identity)(void* opaque, MIKDeviceIdentity* out_id);
    bool (*storage_free)(void* opaque, size_t* out_free); /* returns true if supported */
    bool (*get_device_name)(void* opaque, int* out_rev, char* out_name, size_t name_len);
    void (*set_device_name)(void* opaque, int rev, const char* name);
    void (*restart)(void* opaque);
    int64_t (*monotonic_ms)(void* opaque);
    double (*random_fraction)(void* opaque); /* uniform [0, 1) */
    void (*log)(void* opaque, int level, const char* fmt, ...);
    bool (*read_app_version)(void* opaque, char* out_version, size_t ver_len);
    /* The running build's mikro.app.json, as text. Returns a malloc'd
     * NUL-terminated string the caller frees, or NULL when there is no manifest
     * — which is how a build that never went through deploy reads. Allocated
     * rather than copied into a caller buffer because a manifest carries the
     * build's whole configDefaults and has no useful fixed bound. */
    char* (*read_manifest)(void* opaque);
};

#ifdef __cplusplus
}
#endif

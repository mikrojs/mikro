#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "mikrojs/ota_env.h"

namespace mikrojs {

struct MIKOtaOffer {
    std::string url;
    std::string checksum;
    size_t size = 0;
};

struct MIKOtaInstallOptions {
    int trial_boots = 1;
    bool require_confirm = false;
    bool install_now = false;
};

enum class MIKOtaApplyOutcome {
    kStaged,
    kTrialPending,
    kCurrent,
    kAbandoned,
    kExhausted,
};

const char* mik__ota_outcome_to_str(MIKOtaApplyOutcome outcome);

struct MIKOtaError {
    // One of "StagingFailed", "TooLarge", "StagingFull", "DownloadFailed",
    // "InstallFailed".
    std::string name;
    std::string kind;    // "corrupt", "transient", "oom" (for InstallFailed)
    std::string message;
};

class MIKOtaUpdate {
public:
    virtual ~MIKOtaUpdate() = default;
    virtual size_t resume_offset() const = 0;
    virtual bool write(const uint8_t* bytes, size_t len, MIKOtaError* out_err) = 0;
    virtual bool finish(const MIKOtaInstallOptions& options, MIKOtaError* out_err) = 0;
    virtual void abort() = 0;
};

using MIKOtaDownloadFn = std::function<bool(MIKOtaUpdate& update, MIKOtaError* out_err)>;

/* Why the last offered build was not taken, in wire-string form, held in the
 * store until a completed check-in delivers it. Persisted rather than held in
 * memory (unlike the built-in client's copy) because an own-transport decline
 * happens after that wake's check-in, so it must survive a deep sleep to make
 * the next report. Field caps match the registry's checkin validation, which
 * rejects a body whose lastDecline oversteps them. */
struct MIKOtaDeclineRecord {
    char checksum[65] = {};
    char reason[65] = {};
    char detail[257] = {};
};

class MIKOtaStore {
public:
    explicit MIKOtaStore(const MIKOtaEnv* env) : env_(env) {}

    /* The offer url is stored as a digest, not verbatim: a presigned url can run
     * to several hundred bytes, past both the read buffer here and what the
     * device's kv can hold, and a url that fails to round-trip never compares
     * equal — which reset the retry budget on every round and let a build that
     * cannot install retry forever. */
    bool UrlMatches(const std::string& url) const;
    void SetUrl(const std::string& url);

    std::string GetAttempt() const;
    void SetAttempt(const std::string& checksum);

    int32_t GetTries() const;
    void SetTries(int32_t n);

    std::string GetBad() const;
    void SetBad(const std::string& checksum);

    bool GetInFlight() const;
    void SetInFlight(bool in_flight);

    /* False when no record stands. */
    bool GetDecline(MIKOtaDeclineRecord* out) const;
    void SetDecline(const MIKOtaDeclineRecord& record);
    void ClearDecline();

private:
    const MIKOtaEnv* env_;
};

/* Validate untrusted offer fields into a well-formed MIKOtaOffer */
bool mik__ota_parse_offer(const char* url, const char* checksum, int64_t size, bool allow_insecure,
                         MIKOtaOffer* out_offer, std::string* out_warn_reason);

/* Reconcile on-boot outcome and manage retry budget */
MIKOtaReconcileOutcome mik__ota_policy_reconcile(const MIKOtaEnv* env);

/* Query currently running build information */
MIKOtaRunningBuild mik__ota_policy_running(const MIKOtaEnv* env);

/* Revert current trial to last good build */
bool mik__ota_policy_revert(const MIKOtaEnv* env, MIKOtaError* out_err);

/* Confirm currently running build */
void mik__ota_policy_confirm(const MIKOtaEnv* env);

/* Apply an update offer according to the safety and retry policies. The
 * download runs to completion inside the call; callers whose transport is
 * asynchronous use the split form below instead. */
bool mik__ota_policy_apply_offer(const MIKOtaEnv* env, const MIKOtaOffer& offer,
                                 MIKOtaDownloadFn download, const MIKOtaInstallOptions& options,
                                 MIKOtaApplyOutcome* out_outcome, MIKOtaError* out_err);

/* One apply attempt, held open across an asynchronous download. `update` is
 * null when the policy declined the offer before any staging began. */
struct MIKOtaApplySession {
    const MIKOtaEnv* env = nullptr;
    std::string checksum;
    std::unique_ptr<MIKOtaUpdate> update;
};

/* Run the pre-download gates and, if the offer survives them, open the staging
 * session. Returns false with `out_err` set only for StagingFailed; a declined
 * offer returns true with `out_outcome` set and `session->update` left null.
 *
 * A session with an open `update` MUST be closed with mik__ota_policy_apply_end,
 * or the in-flight flag stays set and the attempt is counted as one that took
 * the device down — which is exactly what should happen if the caller dies. */
bool mik__ota_policy_apply_begin(const MIKOtaEnv* env, const MIKOtaOffer& offer,
                                 MIKOtaApplySession* session, MIKOtaApplyOutcome* out_outcome,
                                 MIKOtaError* out_err);

/* Close an attempt opened by mik__ota_policy_apply_begin. `download_message` is
 * used only when `download_ok` is false, as the DownloadFailed message. */
bool mik__ota_policy_apply_end(MIKOtaApplySession* session, bool download_ok,
                               const std::string& download_message,
                               const MIKOtaInstallOptions& options,
                               MIKOtaApplyOutcome* out_outcome, MIKOtaError* out_err);

}  // namespace mikrojs

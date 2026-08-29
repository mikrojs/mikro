#pragma once

#include <quickjs.h>

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "mikrojs/ota_env.h"
#include "mikrojs/ota_policy.h"

namespace mikrojs {

/* Why an offered build was not armed. Each is the policy working as intended;
 * the distinction is logged and reported because the app's next move differs. */
enum class MIKOtaDeclineReason {
    kTrialPending,
    kCurrent,
    kAbandoned,
    kExhausted,
    kDownloadFailed,
    kInstallFailed,
};

const char* mik__ota_decline_reason_to_str(MIKOtaDeclineReason reason);

enum class MIKOtaCheckStatus {
    kStaged,
    kUpToDate,
    kNotStaged,
    kFailed,
    kUnauthorized,
    kNotEnrolled,
};

const char* mik__ota_check_status_to_str(MIKOtaCheckStatus status);

struct MIKOtaCheckOptions {
    /* Budget for the check-in round trip. */
    uint32_t checkin_timeout_ms = 10000;
    /* Budget for the build download: a total deadline that cancels the
     * transfer mid-stream, so it needs orders of magnitude more than a
     * check-in body does. */
    uint32_t download_timeout_ms = 300000;
    bool require_confirm = true;
    int trial_boots = 1;
};

/* Where an asynchronous round hook stands. */
enum class MIKOtaHookState {
    kPending,
    kOk,
    kFailed,
};

/* The per-round network hook pair: `beforeCheck` and the teardown it hands
 * back. It belongs to one watch call rather than to the platform, so it lives
 * outside MIKOtaEnv. Begin* returns false when there is no hook to run, in
 * which case the machine moves straight on.
 *
 * A failed BeginBeforeCheck skips the round and no teardown runs: unwinding a
 * partial setup is the hook's own business. */
class MIKOtaRoundHooks {
public:
    virtual ~MIKOtaRoundHooks() = default;
    virtual bool BeginBeforeCheck() = 0;
    virtual MIKOtaHookState PollBeforeCheck() = 0;
    virtual bool BeginTeardown() = 0;
    virtual MIKOtaHookState PollTeardown() = 0;
};

struct MIKOtaCheckResult {
    MIKOtaCheckStatus status = MIKOtaCheckStatus::kFailed;
    /* Set on kStaged. */
    MIKOtaOffer offer;
    /* On kUpToDate: the running build's stored config changed since the app
     * could last have read it — delivered or cleared this round, or applied by
     * this boot's install or rollback. */
    bool config_updated = false;
    /* Set on kNotStaged. */
    MIKOtaDeclineReason decline_reason = MIKOtaDeclineReason::kCurrent;
    /* Set on kFailed and on kNotStaged with a download or install failure. */
    MIKOtaError error;
    /* The response status behind a kFailed/kUnauthorized, or 0. */
    int http_status = 0;
};

/* Fires exactly once per Check(), when that round settles. */
using MIKOtaCheckSink = std::function<void(const MIKOtaCheckResult&)>;

struct MIKOtaWatchOptions : MIKOtaCheckOptions {
    /* Steady interval between rounds, end-of-round to start-of-next. Floored
     * at 30s: each round's TLS session leaves heap and socket residue that
     * needs time to drain, and the value may arrive from remote config, so the
     * floor bounds the damage a mistyped document can do. */
    uint32_t checkin_interval_ms = 30 * 60 * 1000;
    uint32_t initial_delay_ms = 5000;
    /* Interval after a failed round, capped at checkin_interval_ms. */
    uint32_t retry_after_failure_ms = 60000;
    /* Spread every scheduled delay by ±10%, so a fleet that lost power
     * together does not check in phase-locked forever. */
    bool jitter = true;
    /* Borrowed, not owned: must outlive the watch. */
    MIKOtaRoundHooks* hooks = nullptr;
    /* Fires as each round settles, before any restart. A watch loop otherwise
     * reports nothing to the app, which then has to poll for what changed —
     * config delivery in particular, which is invisible from outside. */
    MIKOtaCheckSink on_round;
};


/* Why the device did not take the build it was last offered.
 *
 * Without this a registry cannot tell "still working on it" from "gave up": the
 * device stops retrying, its running checksum never changes, and the registry
 * waits for an install that is never coming. `exhausted` is per-boot and clears
 * on reboot; `abandoned` is permanent for those bytes. */
struct MIKOtaDeclineReport {
    char checksum[65] = {};
    MIKOtaDeclineReason reason = MIKOtaDeclineReason::kExhausted;
    /* The underlying error, when there was one. */
    std::string detail;
};

/* Everything the check-in report carries. A struct because the list grew past
 * what positional arguments stay readable at. */
struct MIKOtaCheckinFacts {
    const MIKDeviceIdentity* identity = nullptr;
    const MIKOtaRunningBuild* running = nullptr;
    int name_rev = 0;
    /* NULL or empty sends the cleared `[rev]` pair. */
    const char* name = nullptr;
    bool has_free = false;
    size_t free_bytes = 0;
    const MIKOtaDiagnostic* last_install = nullptr;
    /* NULL or empty omits the key. */
    const char* echo_rev = nullptr;
    const MIKOtaConfigErrorReport* config_error = nullptr;
    const MIKOtaDeclineReport* last_decline = nullptr;
};

/* The states a round can rest in between Poll() calls. Parsing the response and
 * closing the install are synchronous, so they are transitions, not states. */
enum class MIKOtaClientState {
    kIdle,
    kBeforeCheck,
    kCheckIn,
    kDownload,
    kTeardown,
};

/* Largest check-in response the client will buffer. Real ones run to a few
 * hundred bytes; the cap is what keeps a confused or hostile registry from
 * growing the buffer until the device runs out of heap. */
constexpr size_t MIK__OTA_MAX_RESPONSE_BYTES = 8192;

/**
 * The OTA client: one check-in round at a time, driven by Poll().
 *
 * `Check()` queues a forced round. `Watch()` runs rounds on a jittered cadence
 * and restarts the device after staging a build. Both share one queue, because
 * staging is a single native session and two interleaved rounds would corrupt
 * it — a Check() issued mid-round waits its turn and still gets its own result.
 */
class MIKOtaClient {
public:
    /* `config` is borrowed and may be NULL: it is only read for the defaults
     * rev the check-in reports, and must outlive the client. */
    explicit MIKOtaClient(const MIKOtaEnv* env);
    ~MIKOtaClient();
    MIKOtaClient(const MIKOtaClient&) = delete;
    MIKOtaClient& operator=(const MIKOtaClient&) = delete;

    /* Queue one forced round. `sink` fires from a later Poll() — except on an
     * un-enrolled device, which settles inline before Check() returns. */
    void Check(const MIKOtaCheckOptions& options, MIKOtaCheckSink sink);

    /* Start the free-running loop. Returns false, with no loop started, on an
     * un-enrolled device. At most one watch per client. */
    bool Watch(const MIKOtaWatchOptions& options);

    /* No further rounds, and the pending delay is cancelled. A round in flight
     * still completes, but a build it stages no longer auto-restarts — it stays
     * armed for the next natural reboot. */
    void StopWatch();

    /* Change the cadence of a running watch, floored the same way Watch() floors
     * it. A wait already counting is re-timed from when it started, so lowering
     * the interval brings the next round forward instead of waiting out the old
     * one — which is the case this exists for, a cadence arriving from remote
     * config. The initial delay is left alone: it is not the interval. */
    void SetCheckinInterval(uint32_t interval_ms);

    /* One turn of the machine: settle what is ready, start what is due. Call it
     * once per loop pass. */
    void Poll();

    MIKOtaClientState state() const { return state_; }
    /* The delay last handed to the scheduler, jitter included, or -1 when no
     * round is scheduled. */
    int64_t scheduled_delay_ms() const { return scheduled_delay_ms_; }
    bool watching() const { return watching_ && !watch_stopped_; }
    bool HasLastInstall() const { return has_last_install_; }
    bool BootConfigChanged() const { return boot_config_changed_; }

private:
    /* Which delay the pending wait is counting, so a cadence change can re-time
     * it against the right one. */
    enum class PendingWait { kNone, kInitial, kInterval, kRetry };

    /* What the loop does after a round: retry at the shortened interval, or
     * wait the full one. Deliberately not "did the check-in succeed" — a
     * rejected update key also waits the full interval, so a dead key does not
     * hammer the registry every retry interval forever. */
    enum class NextRound { kSoon, kLater };

    struct Round {
        bool is_watch = false;
        MIKOtaCheckOptions options;
        MIKOtaCheckSink sink;
        std::string registry_url;
        std::string bearer;
    };

    /* One transition. Returns true when it moved, so Poll can keep going. */
    bool Step();

    /* Transport callbacks. They only record what arrived (and, for a download,
     * stream it into staging); every decision is taken from Poll(), so the
     * machine never advances re-entrantly from inside the transport. */
    static void HeadersThunk(void* user_data, int status);
    static void DownloadHeadersThunk(void* user_data, int status);
    static void DataThunk(void* user_data, const uint8_t* data, size_t len);
    static void DoneThunk(void* user_data, int status, const char* error_msg);

    bool Enrollment(std::string* out_url, std::string* out_bearer) const;
    void StartRound();
    void BeginCheckIn();
    void OnCheckInSettled();
    bool BeginDownload();
    void OnDownloadSettled();
    void FinishRound(NextRound next);
    void Finalize(NextRound next);

    void ReconcileOnce();
    /* Record a decline worth telling the registry about. Reasons that are the
     * policy working normally — already current, a trial still resolving — are
     * not failures and are not reported. */
    void NoteDecline(MIKOtaDeclineReason reason, const std::string& detail);
    void ScheduleNext(NextRound next);
    int64_t Jitter(int64_t ms);
    int64_t Now() const;
    void Log(int level, const char* fmt, ...) const;

    const MIKOtaEnv* env_;
    MIKOtaClientState state_ = MIKOtaClientState::kIdle;

    std::vector<Round> queue_;
    Round active_;

    /* Boot-once bookkeeping, held across rounds. */
    bool reconciled_ = false;
    bool has_last_install_ = false;
    MIKOtaDiagnostic last_install_ = {};
    bool boot_config_changed_ = false;
    bool warned_insecure_ = false;
    /* Held until a check-in delivers it, exactly like last_install_. A reboot
     * loses an undelivered one, which is right for `exhausted` (the budget
     * resets anyway) and harmless for `abandoned` (the next offer re-declines
     * immediately and reports again). */
    bool has_last_decline_ = false;
    MIKOtaDeclineReport last_decline_;

    /* The round in flight. */
    bool allow_insecure_ = false;
    MIKOtaRunningBuild running_ = {};
    MIKOtaCheckResult result_;
    bool teardown_armed_ = false;
    NextRound pending_next_ = NextRound::kLater;

    /* The exchange in flight. */
    void* http_handle_ = nullptr;
    bool http_done_ = false;
    int http_status_ = 0;
    std::string http_error_;
    std::vector<uint8_t> response_body_;
    bool response_too_large_ = false;

    /* The download in flight. */
    MIKOtaApplySession apply_;
    MIKOtaOffer offer_;
    size_t download_skip_ = 0;
    bool write_failed_ = false;
    MIKOtaError write_error_;
    /* The config the response carried, if any, kept until the round settles. */
    bool have_response_config_ = false;
    MIKOtaStoredConfig response_config_ = {};
    std::vector<uint8_t> response_config_doc_;

    /* Watch state. */
    bool watching_ = false;
    bool watch_stopped_ = false;
    MIKOtaWatchOptions watch_options_;
    std::string watch_registry_url_;
    std::string watch_bearer_;
    int64_t deadline_ms_ = -1;
    int64_t scheduled_delay_ms_ = -1;
    PendingWait pending_wait_ = PendingWait::kNone;
    /* When the pending wait began, so it can be re-timed without drifting. */
    int64_t wait_started_ms_ = 0;
};

/* True when both urls share a scheme and authority. Deliberately literal: with
 * no URL parser here, a spelled-out default port does not compare equal. */
bool mik__ota_same_origin(const std::string& a, const std::string& b);

/* True for http:// on a LAN/loopback/mDNS host: development, not the internet.
 * Anywhere else the scheme is not a judgement call — over http the offer's
 * checksum is forgeable in the same response that names it. */
bool mik__ota_is_private_http(const std::string& url);

/* Validate an untrusted registry value into an offer.
 *
 * The JS-value twin of mik__ota_parse_offer, for a caller holding a decoded
 * check-in response rather than the fields. Absent or malformed reads as no
 * offer; a url that is present but unusable also warns on the console, the way
 * the TypeScript parseOffer did, because that case is a registry misconfiguring
 * itself rather than a device with nothing to do. */
bool mik__ota_parse_offer_js(JSContext* ctx, JSValueConst raw, bool allow_insecure,
                             MIKOtaOffer* out_offer);

/* The check-in report, CBOR-encoded. The shape is a contract with the
 * registry's /api/v1/checkin; optional keys are omitted, never sent as null. */
std::vector<uint8_t> mik__ota_build_checkin_report(const MIKOtaCheckinFacts& facts);

}  // namespace mikrojs

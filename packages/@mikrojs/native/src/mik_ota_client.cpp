#include "mikrojs/ota_client.h"

#include <nanocbor/nanocbor.h>

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/ota_slots.h"
#include "mikrojs/platform.h"

namespace mikrojs {

const char* mik__ota_decline_reason_to_str(MIKOtaDeclineReason reason) {
    switch (reason) {
        case MIKOtaDeclineReason::kTrialPending:
            return "trial-pending";
        case MIKOtaDeclineReason::kCurrent:
            return "current";
        case MIKOtaDeclineReason::kAbandoned:
            return "abandoned";
        case MIKOtaDeclineReason::kExhausted:
            return "exhausted";
        case MIKOtaDeclineReason::kDownloadFailed:
            return "download-failed";
        case MIKOtaDeclineReason::kInstallFailed:
            return "install-failed";
    }
    return "unknown";
}

const char* mik__ota_check_status_to_str(MIKOtaCheckStatus status) {
    switch (status) {
        case MIKOtaCheckStatus::kStaged:
            return "staged";
        case MIKOtaCheckStatus::kUpToDate:
            return "up-to-date";
        case MIKOtaCheckStatus::kNotStaged:
            return "not-staged";
        case MIKOtaCheckStatus::kFailed:
            return "failed";
        case MIKOtaCheckStatus::kUnauthorized:
            return "unauthorized";
        case MIKOtaCheckStatus::kNotEnrolled:
            return "not-enrolled";
    }
    return "unknown";
}

bool mik__ota_same_origin(const std::string& a, const std::string& b) {
    auto origin = [](const std::string& url) -> std::string {
        size_t sep = url.find("://");
        if (sep == std::string::npos) return "";
        size_t start = sep + 3;
        size_t end = url.find('/', start);
        std::string authority =
            (end == std::string::npos) ? url.substr(start) : url.substr(start, end - start);
        if (authority.empty()) return "";
        std::string out = url.substr(0, start) + authority;
        for (char& c : out) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
        return out;
    };
    std::string left = origin(a);
    return !left.empty() && left == origin(b);
}

bool mik__ota_is_private_http(const std::string& url) {
    if (url.rfind("http://", 0) != 0) return false;
    std::string rest = url.substr(7);
    size_t slash = rest.find('/');
    std::string host_port = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    size_t colon = host_port.find(':');
    std::string host = (colon == std::string::npos) ? host_port : host_port.substr(0, colon);

    if (host == "localhost") return true;
    if (host.size() >= 6 && host.compare(host.size() - 6, 6, ".local") == 0) return true;

    // Dotted quad only: anything else is a name, and a name is not private.
    int p[4] = {};
    char extra = 0;
    if (sscanf(host.c_str(), "%d.%d.%d.%d%c", &p[0], &p[1], &p[2], &p[3], &extra) != 4) {
        return false;
    }
    for (int part : p) {
        if (part < 0 || part > 255) return false;
    }
    if (p[0] == 10 || p[0] == 127) return true;
    if (p[0] == 192 && p[1] == 168) return true;
    if (p[0] == 169 && p[1] == 254) return true;
    return p[0] == 172 && p[1] >= 16 && p[1] <= 31;
}

namespace {

/* console.warn, so a misconfigured registry says so on the same channel the
 * TypeScript client used. */
void warn_offer(JSContext* ctx, const char* reason) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_GetPropertyStr(ctx, global, "console");
    JSValue warn = JS_GetPropertyStr(ctx, console, "warn");
    if (JS_IsFunction(ctx, warn)) {
        char buf[256];
        snprintf(buf, sizeof(buf), "ota: ignoring offer (%s)", reason);
        JSValue msg = JS_NewString(ctx, buf);
        JSValue ret = JS_Call(ctx, warn, console, 1, &msg);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, msg);
    }
    JS_FreeValue(ctx, warn);
    JS_FreeValue(ctx, console);
    JS_FreeValue(ctx, global);
}

}  // namespace

bool mik__ota_parse_offer_js(JSContext* ctx, JSValueConst raw, bool allow_insecure,
                             MIKOtaOffer* out_offer) {
    // null/undefined is the registry's "no update available" signal, not a
    // malformed offer, so it returns quietly.
    if (JS_IsNull(raw) || JS_IsUndefined(raw)) return false;
    if (!JS_IsObject(raw)) {
        warn_offer(ctx, "not an object");
        return false;
    }

    // No url is "no update", not a malformed offer: a check-in with nothing
    // newer still returns a body when the registry has something else to say —
    // a name to adopt, say. Warning here would log on every device whenever a
    // dashboard rename coincided with "up to date".
    JSValue url_val = JS_GetPropertyStr(ctx, raw, "url");
    if (JS_IsUndefined(url_val)) {
        JS_FreeValue(ctx, url_val);
        return false;
    }
    if (!JS_IsString(url_val)) {
        JS_FreeValue(ctx, url_val);
        warn_offer(ctx, "missing url");
        return false;
    }
    const char* url_cstr = JS_ToCString(ctx, url_val);
    std::string url = url_cstr ? url_cstr : "";
    if (url_cstr) JS_FreeCString(ctx, url_cstr);
    JS_FreeValue(ctx, url_val);

    JSValue csum_val = JS_GetPropertyStr(ctx, raw, "checksum");
    bool csum_is_str = JS_IsString(csum_val);
    std::string csum;
    if (csum_is_str) {
        const char* c = JS_ToCString(ctx, csum_val);
        if (c) {
            csum = c;
            JS_FreeCString(ctx, c);
        }
    }
    JS_FreeValue(ctx, csum_val);

    // Must be a positive integer: a negative size fails the first write with
    // TooLarge, and 0 disables the cap on both sides.
    JSValue size_val = JS_GetPropertyStr(ctx, raw, "size");
    int64_t size = -1;
    if (JS_IsNumber(size_val)) {
        double d = 0;
        if (JS_ToFloat64(ctx, &d, size_val) == 0 && d > 0 &&
            d == static_cast<double>(static_cast<int64_t>(d))) {
            size = static_cast<int64_t>(d);
        }
    }
    JS_FreeValue(ctx, size_val);

    std::string reason;
    if (!mik__ota_parse_offer(url.c_str(), csum_is_str ? csum.c_str() : nullptr, size,
                              allow_insecure, out_offer, &reason)) {
        if (!reason.empty()) warn_offer(ctx, reason.c_str());
        return false;
    }
    return true;
}

// ── CBOR ─────────────────────────────────────────────────────────────────────

namespace {

/* Encode twice: once against a zero-capacity buffer to size it, once for real.
 * The measuring base must be non-null: zero-length appends still reach memcpy,
 * and memcpy(NULL, ..., 0) is undefined behavior. */
template <typename Fn>
std::vector<uint8_t> encode_to_vector(Fn&& encode) {
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    encode(&enc);
    std::vector<uint8_t> out(nanocbor_encoded_len(&enc));
    nanocbor_encoder_init(&enc, out.data(), out.size());
    encode(&enc);
    return out;
}

/* Read a text string into a fixed field. Returns false without consuming when
 * the next item is not a string. */
bool take_str(nanocbor_value_t* it, char* out, size_t out_len) {
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(it, &ptr, &len) < 0) return false;
    snprintf(out, out_len, "%.*s", static_cast<int>(len), reinterpret_cast<const char*>(ptr));
    return true;
}

bool take_string(nanocbor_value_t* it, std::string* out) {
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(it, &ptr, &len) < 0) return false;
    out->assign(reinterpret_cast<const char*>(ptr), len);
    return true;
}

/* Read the next map key as a string, or false when the map is malformed. */
bool take_key(nanocbor_value_t* map, std::string* out) { return take_string(map, out); }

void encode_report(nanocbor_encoder_t* enc, const MIKOtaCheckinFacts& f) {
    const MIKDeviceIdentity& identity = *f.identity;
    const MIKOtaRunningBuild& running = *f.running;
    bool has_echo = f.echo_rev && f.echo_rev[0];

    size_t map_size = 6;  // deviceId, firmware, firmwareHash, bytecode, running, name
    if (f.has_free) map_size++;
    if (f.last_install) map_size++;
    if (has_echo) map_size++;
    if (f.config_error) map_size++;
    if (f.last_decline) map_size++;

    nanocbor_fmt_map(enc, map_size);

    nanocbor_put_tstr(enc, "deviceId");
    nanocbor_put_tstr(enc, identity.device_id);
    nanocbor_put_tstr(enc, "firmware");
    nanocbor_put_tstr(enc, identity.firmware_version);
    nanocbor_put_tstr(enc, "firmwareHash");
    nanocbor_put_tstr(enc, identity.firmware_hash);
    nanocbor_put_tstr(enc, "bytecode");
    nanocbor_fmt_int(enc, identity.bytecode_version);

    size_t run_size = 1;  // trial
    if (running.checksum[0]) run_size++;
    if (running.version[0]) run_size++;
    nanocbor_put_tstr(enc, "running");
    nanocbor_fmt_map(enc, run_size);
    nanocbor_put_tstr(enc, "trial");
    nanocbor_fmt_bool(enc, running.trial);
    if (running.checksum[0]) {
        nanocbor_put_tstr(enc, "checksum");
        nanocbor_put_tstr(enc, running.checksum);
    }
    if (running.version[0]) {
        nanocbor_put_tstr(enc, "version");
        nanocbor_put_tstr(enc, running.version);
    }

    // The name pair: [rev] when cleared, [rev, name] otherwise. Sent every time
    // so a lost response settles on the next check-in.
    nanocbor_put_tstr(enc, "name");
    if (f.name && f.name[0]) {
        nanocbor_fmt_array(enc, 2);
        nanocbor_fmt_int(enc, f.name_rev);
        nanocbor_put_tstr(enc, f.name);
    } else {
        nanocbor_fmt_array(enc, 1);
        nanocbor_fmt_int(enc, f.name_rev);
    }

    if (f.has_free) {
        nanocbor_put_tstr(enc, "free");
        nanocbor_fmt_uint(enc, f.free_bytes);
    }

    if (f.last_install) {
        nanocbor_put_tstr(enc, "lastInstall");
        nanocbor_fmt_map(enc, f.last_install->detail[0] ? 2 : 1);
        nanocbor_put_tstr(enc, "reason");
        nanocbor_put_tstr(enc, f.last_install->reason);
        if (f.last_install->detail[0]) {
            nanocbor_put_tstr(enc, "detail");
            nanocbor_put_tstr(enc, f.last_install->detail);
        }
    }

    // Why the last offered build was not taken. Without it a registry cannot
    // tell a device still working through a download from one that has stopped.
    if (f.last_decline) {
        nanocbor_put_tstr(enc, "lastDecline");
        nanocbor_fmt_map(enc, f.last_decline->detail.empty() ? 2 : 3);
        nanocbor_put_tstr(enc, "checksum");
        nanocbor_put_tstr(enc, f.last_decline->checksum);
        nanocbor_put_tstr(enc, "reason");
        nanocbor_put_tstr(enc, mik__ota_decline_reason_to_str(f.last_decline->reason));
        if (!f.last_decline->detail.empty()) {
            nanocbor_put_tstr(enc, "detail");
            nanocbor_put_tstr(enc, f.last_decline->detail.c_str());
        }
    }

    if (has_echo) {
        nanocbor_put_tstr(enc, "configRev");
        nanocbor_put_tstr(enc, f.echo_rev);
    }

    if (f.config_error) {
        nanocbor_put_tstr(enc, "configError");
        nanocbor_fmt_map(enc, 2);
        nanocbor_put_tstr(enc, "rev");
        nanocbor_put_tstr(enc, f.config_error->rev);
        nanocbor_put_tstr(enc, "message");
        nanocbor_put_tstr(enc, f.config_error->message);
    }
}

}  // namespace

std::vector<uint8_t> mik__ota_build_checkin_report(const MIKOtaCheckinFacts& facts) {
    return encode_to_vector(
        [&](nanocbor_encoder_t* enc) { encode_report(enc, facts); });
}

// ── MIKOtaClient ─────────────────────────────────────────────────────────────

MIKOtaClient::MIKOtaClient(const MIKOtaEnv* env) : env_(env) {}
MIKOtaClient::~MIKOtaClient() {
    if (http_handle_ && env_ && env_->http_cancel) {
        env_->http_cancel(env_->opaque, http_handle_);
    }
}

int64_t MIKOtaClient::Now() const {
    return (env_ && env_->monotonic_ms) ? env_->monotonic_ms(env_->opaque) : 0;
}

void MIKOtaClient::Log(int level, const char* fmt, ...) const {
    if (!env_ || !env_->log) return;
    char buf[320];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    env_->log(env_->opaque, level, "%s", buf);
}

bool MIKOtaClient::Enrollment(std::string* out_url, std::string* out_bearer) const {
    // Written as a pair over the cable by `mikro ota enroll`; enrollment is the
    // opt-in, and update keys never arrive over the network.
    char url[256] = {};
    char bearer[128] = {};
    if (!env_ || !env_->kv_get_str) return false;
    if (!env_->kv_get_str(env_->opaque, "ota.registry", url, sizeof(url)) || url[0] == '\0') {
        return false;
    }
    if (!env_->kv_get_str(env_->opaque, "ota.updateKey", bearer, sizeof(bearer)) ||
        bearer[0] == '\0') {
        return false;
    }
    *out_url = url;
    *out_bearer = bearer;
    return true;
}

void MIKOtaClient::Check(const MIKOtaCheckOptions& options, MIKOtaCheckSink sink) {
    Round round;
    round.options = options;
    round.sink = std::move(sink);
    if (!Enrollment(&round.registry_url, &round.bearer)) {
        MIKOtaCheckResult result;
        result.status = MIKOtaCheckStatus::kNotEnrolled;
        if (round.sink) round.sink(result);
        return;
    }
    queue_.push_back(std::move(round));
}

/* Floor for the check-in cadence: each round's TLS session leaves heap and
 * socket residue that needs time to drain, and the value may arrive from remote
 * config — the floor is what bounds the damage a mistyped document can do. */
constexpr uint32_t kMinCheckinIntervalMs = 30000;

void MIKOtaClient::Watch(const MIKOtaWatchOptions& options) {
    if (!Enrollment(&watch_registry_url_, &watch_bearer_)) {
        Log(MIK_LOG_INFO, "ota: device not enrolled; run `mikro ota enroll` to enable OTA updates");
        return;
    }
    watch_options_ = options;
    if (watch_options_.checkin_interval_ms < kMinCheckinIntervalMs) {
        watch_options_.checkin_interval_ms = kMinCheckinIntervalMs;
    }
    if (watch_options_.retry_after_failure_ms > watch_options_.checkin_interval_ms) {
        watch_options_.retry_after_failure_ms = watch_options_.checkin_interval_ms;
    }
    watching_ = true;
    watch_stopped_ = false;
    scheduled_delay_ms_ = Jitter(watch_options_.initial_delay_ms);
    wait_started_ms_ = Now();
    deadline_ms_ = wait_started_ms_ + scheduled_delay_ms_;
    pending_wait_ = PendingWait::kInitial;
}

void MIKOtaClient::SetCheckinInterval(uint32_t interval_ms) {
    if (!watching_ || watch_stopped_) return;
    uint32_t floored =
        interval_ms < kMinCheckinIntervalMs ? kMinCheckinIntervalMs : interval_ms;
    if (floored == watch_options_.checkin_interval_ms) return;
    watch_options_.checkin_interval_ms = floored;
    /* The retry interval is capped at the check-in interval, so a cadence drop
     * pulls it down with it. */
    if (watch_options_.retry_after_failure_ms > floored) {
        watch_options_.retry_after_failure_ms = floored;
    }

    if (pending_wait_ != PendingWait::kInterval && pending_wait_ != PendingWait::kRetry) return;
    int64_t base = pending_wait_ == PendingWait::kInterval
                       ? watch_options_.checkin_interval_ms
                       : watch_options_.retry_after_failure_ms;
    scheduled_delay_ms_ = Jitter(base);
    /* From when the wait began, not from now: re-timing against `now` on every
     * change would let a config that changes often push the next round away
     * indefinitely. */
    deadline_ms_ = wait_started_ms_ + scheduled_delay_ms_;
}

void MIKOtaClient::StopWatch() {
    watch_stopped_ = true;
    deadline_ms_ = -1;
    scheduled_delay_ms_ = -1;
    pending_wait_ = PendingWait::kNone;
}

int64_t MIKOtaClient::Jitter(int64_t ms) {
    if (!watch_options_.jitter) return ms;
    double fraction =
        (env_ && env_->random_fraction) ? env_->random_fraction(env_->opaque) : 0.5;
    return static_cast<int64_t>(std::llround(static_cast<double>(ms) * (0.9 + fraction * 0.2)));
}

void MIKOtaClient::Poll() {
    while (Step()) {
    }
}

bool MIKOtaClient::Step() {
    switch (state_) {
        case MIKOtaClientState::kIdle: {
            if (!queue_.empty()) {
                StartRound();
                return true;
            }
            if (watching_ && !watch_stopped_ && deadline_ms_ >= 0 && Now() >= deadline_ms_) {
                Round round;
                round.is_watch = true;
                round.options = watch_options_;
                round.registry_url = watch_registry_url_;
                round.bearer = watch_bearer_;
                queue_.push_back(std::move(round));
                deadline_ms_ = -1;
                pending_wait_ = PendingWait::kNone;
                return true;
            }
            return false;
        }
        case MIKOtaClientState::kBeforeCheck: {
            MIKOtaHookState hook = watch_options_.hooks->PollBeforeCheck();
            if (hook == MIKOtaHookState::kPending) return false;
            if (hook == MIKOtaHookState::kFailed) {
                Log(MIK_LOG_WARN, "ota: beforeCheck failed; skipping this check");
                // No teardown: unwinding a partial setup is the hook's own job.
                Finalize(NextRound::kSoon);
                return true;
            }
            teardown_armed_ = true;
            BeginCheckIn();
            return true;
        }
        case MIKOtaClientState::kCheckIn: {
            if (!http_done_) return false;
            OnCheckInSettled();
            return true;
        }
        case MIKOtaClientState::kDownload: {
            // Nothing more can be written, so the rest of the body is a whole
            // firmware image pulled over TLS to be discarded. Cancel from here
            // rather than from the write callback, which is the transport's own
            // stack.
            if (write_failed_ && !http_done_ && http_handle_ && env_->http_cancel) {
                env_->http_cancel(env_->opaque, http_handle_);
                http_handle_ = nullptr;
                http_done_ = true;
            }
            if (!http_done_) return false;
            OnDownloadSettled();
            return true;
        }
        case MIKOtaClientState::kTeardown: {
            MIKOtaHookState hook = watch_options_.hooks->PollTeardown();
            if (hook == MIKOtaHookState::kPending) return false;
            if (hook == MIKOtaHookState::kFailed) Log(MIK_LOG_WARN, "ota: teardown failed");
            Finalize(pending_next_);
            return true;
        }
    }
    return false;
}

void MIKOtaClient::StartRound() {
    active_ = std::move(queue_.front());
    queue_.erase(queue_.begin());
    result_ = MIKOtaCheckResult();
    teardown_armed_ = false;

    if (active_.is_watch && watch_options_.hooks && watch_options_.hooks->BeginBeforeCheck()) {
        state_ = MIKOtaClientState::kBeforeCheck;
        return;
    }
    BeginCheckIn();
}

void MIKOtaClient::NoteDecline(MIKOtaDeclineReason reason, const std::string& detail) {
    // `current` and `trial-pending` are the policy working as intended, not a
    // build the device failed to take, so there is nothing to report.
    if (reason == MIKOtaDeclineReason::kCurrent || reason == MIKOtaDeclineReason::kTrialPending) {
        return;
    }
    has_last_decline_ = true;
    last_decline_ = MIKOtaDeclineReport();
    snprintf(last_decline_.checksum, sizeof(last_decline_.checksum), "%s", offer_.checksum.c_str());
    last_decline_.reason = reason;
    last_decline_.detail = detail;
}

void MIKOtaClient::ReconcileOnce() {
    if (reconciled_) return;
    reconciled_ = true;
    MIKOtaReconcileOutcome report = mik__ota_policy_reconcile(env_);
    if (report.has_diagnostic) {
        has_last_install_ = true;
        last_install_ = report.diagnostic;
    }

    bool touches_config = report.installed[0] != '\0' || report.reverted;
    std::vector<uint8_t> before;
    if (touches_config) before = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT).bytes;

    // Promote before restore: a trial that crashed before its first check-in
    // reports installed AND reverted on the same boot, and the promote is what
    // writes the `prev` baseline the restore reads back. Restoring first would
    // find `prev` empty and wipe every slot instead.
    if (report.installed[0] != '\0') {
        Log(MIK_LOG_INFO, "ota: installed build %.12s on this boot", report.installed);
        MIKOtaLoadedConfig previous = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT);
        if (previous.present) {
            mik__ota_store_slot(env_, MIK_OTA_CFG_PREV, previous.cfg);
        } else {
            mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
        }
        MIKOtaLoadedConfig next = mik__ota_load_slot(env_, MIK_OTA_CFG_NEXT);
        if (next.present) {
            mik__ota_store_slot(env_, MIK_OTA_CFG_CURRENT, next.cfg);
        } else {
            mik__ota_clear_slot(env_, MIK_OTA_CFG_CURRENT);
        }
        mik__ota_clear_slot(env_, MIK_OTA_CFG_NEXT);
        // The staged document rides the BUILD trial; a running-release trial or
        // rollback report from the previous build is settled by the install.
        mik__ota_clear_trial(env_);
        mik__ota_clear_config_error(env_);
    }

    if (report.reverted) {
        Log(MIK_LOG_WARN, "ota: previous update failed its trial and was rolled back");
        // The config pairs with the build: restore the document the previous
        // build ran with, exactly as the build itself was restored.
        MIKOtaLoadedConfig previous = mik__ota_load_slot(env_, MIK_OTA_CFG_PREV);
        if (previous.present) {
            mik__ota_store_slot(env_, MIK_OTA_CFG_CURRENT, previous.cfg);
        } else {
            mik__ota_clear_slot(env_, MIK_OTA_CFG_CURRENT);
        }
        mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
        mik__ota_clear_slot(env_, MIK_OTA_CFG_NEXT);
        mik__ota_clear_trial(env_);
        mik__ota_clear_config_error(env_);
    }

    if (touches_config && mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT).bytes != before) {
        boot_config_changed_ = true;
    }
}

void MIKOtaClient::BeginCheckIn() {
    allow_insecure_ = mik__ota_is_private_http(active_.registry_url);
    if (allow_insecure_ && !warned_insecure_) {
        // Every boot, not once at enrollment: a device that quietly runs a
        // forgeable update channel should say so for as long as it does.
        warned_insecure_ = true;
        Log(MIK_LOG_WARN,
            "ota: registry is http:// on a private network — updates are NOT authenticated");
    }
    ReconcileOnce();

    running_ = mik__ota_policy_running(env_);
    MIKDeviceIdentity identity = {};
    if (env_ && env_->identity) env_->identity(env_->opaque, &identity);

    int name_rev = 0;
    char name[64] = {};
    bool has_name = env_ && env_->get_device_name &&
                    env_->get_device_name(env_->opaque, &name_rev, name, sizeof(name));

    size_t free_bytes = 0;
    bool has_free = env_ && env_->storage_free && env_->storage_free(env_->opaque, &free_bytes);

    MIKOtaLoadedConfig held = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT);
    MIKOtaConfigErrorReport config_error = {};
    bool has_config_error = mik__ota_load_config_error(env_, &config_error);
    // After a config rollback the FAILED document's rev is echoed, not the
    // restored one's: echoed-equals-expected is what keeps the registry from
    // re-serving the document that just failed, until an operator changes it.
    const char* echo_rev = has_config_error ? config_error.rev : (held.present ? held.cfg.rev : "");

    Log(MIK_LOG_DEBUG, "ota: checking %s/api/v1/checkin (running %s v%s, bytecode %d, fw %s)",
        active_.registry_url.c_str(), running_.checksum[0] ? running_.checksum : "none",
        running_.version[0] ? running_.version : "?", identity.bytecode_version,
        identity.firmware_version);

    MIKOtaCheckinFacts facts;
    facts.identity = &identity;
    facts.running = &running_;
    facts.name_rev = name_rev;
    facts.name = has_name ? name : nullptr;
    facts.has_free = has_free;
    facts.free_bytes = free_bytes;
    facts.last_install = has_last_install_ ? &last_install_ : nullptr;
    facts.echo_rev = echo_rev;
    facts.config_error = has_config_error ? &config_error : nullptr;
    facts.last_decline = has_last_decline_ ? &last_decline_ : nullptr;
    std::vector<uint8_t> body = mik__ota_build_checkin_report(facts);

    std::string url = active_.registry_url + "/api/v1/checkin";
    std::string auth = "Bearer " + active_.bearer;
    const char* keys[] = {"content-type", "accept", "authorization"};
    const char* values[] = {"application/cbor", "application/cbor", auth.c_str()};

    MIKOtaHttpRequest req = {};
    req.url = url.c_str();
    req.method = "POST";
    req.header_keys = keys;
    req.header_values = values;
    req.header_count = 3;
    req.body = body.data();
    req.body_len = body.size();
    req.timeout_ms = active_.options.checkin_timeout_ms;

    http_done_ = false;
    http_status_ = 0;
    http_error_.clear();
    response_body_.clear();
    response_too_large_ = false;
    state_ = MIKOtaClientState::kCheckIn;

    MIKOtaHttpCallbacks cbs = {HeadersThunk, DataThunk, DoneThunk, this};
    http_handle_ = (env_ && env_->http_request) ? env_->http_request(env_->opaque, &req, &cbs)
                                               : nullptr;
    if (!http_handle_) {
        // Nothing will call back, so settle the exchange here.
        http_done_ = true;
        http_status_ = 0;
        if (http_error_.empty()) http_error_ = "request could not be started";
    }
}

void MIKOtaClient::HeadersThunk(void* ud, int status) {
    static_cast<MIKOtaClient*>(ud)->http_status_ = status;
}

void MIKOtaClient::DataThunk(void* ud, const uint8_t* data, size_t len) {
    auto* self = static_cast<MIKOtaClient*>(ud);
    bool status_known = self->http_status_ != 0;
    bool status_ok = self->http_status_ >= 200 && self->http_status_ < 300;
    if (status_known && !status_ok) return;  // an error body is not worth the heap

    if (self->state_ == MIKOtaClientState::kCheckIn) {
        if (self->response_body_.size() + len > MIK__OTA_MAX_RESPONSE_BYTES) {
            self->response_too_large_ = true;
            return;
        }
        self->response_body_.insert(self->response_body_.end(), data, data + len);
        return;
    }

    if (self->state_ != MIKOtaClientState::kDownload || self->write_failed_) return;
    // A server free to ignore Range answers 200 with the whole build. Drop the
    // prefix already on flash rather than failing, which would spend a retry
    // for nothing.
    if (self->download_skip_ > 0) {
        if (len <= self->download_skip_) {
            self->download_skip_ -= len;
            return;
        }
        data += self->download_skip_;
        len -= self->download_skip_;
        self->download_skip_ = 0;
    }
    if (self->apply_.update && !self->apply_.update->write(data, len, &self->write_error_)) {
        self->write_failed_ = true;
    }
}

void MIKOtaClient::DoneThunk(void* ud, int status, const char* error_msg) {
    auto* self = static_cast<MIKOtaClient*>(ud);
    if (status != 0) self->http_status_ = status;
    if (error_msg) self->http_error_ = error_msg;
    self->http_done_ = true;
    self->http_handle_ = nullptr;
}

void MIKOtaClient::OnCheckInSettled() {
    if (http_status_ == 0 || !http_error_.empty()) {
        // A transport error outranks the status: a body cut short mid-transfer
        // is a round that did not complete, not one that answered badly.
        Log(MIK_LOG_ERROR, "ota: checkin failed: %s",
            http_error_.empty() ? "no response" : http_error_.c_str());
        result_.status = MIKOtaCheckStatus::kFailed;
        result_.error.name = "Network";
        result_.error.message = http_error_;
        FinishRound(NextRound::kSoon);
        return;
    }
    if (http_status_ == 401) {
        // The update key no longer authenticates (rotated, device deleted).
        // There is no fallback secret — re-enroll over the cable.
        Log(MIK_LOG_ERROR,
            "ota: registry rejected the update key; re-enroll with `mikro ota enroll --re-enroll`");
        result_.status = MIKOtaCheckStatus::kUnauthorized;
        result_.http_status = 401;
        FinishRound(NextRound::kLater);
        return;
    }
    if (http_status_ == 415) {
        // The wire is CBOR-only by design; there is no JSON fallback to hide a
        // registry that predates it.
        Log(MIK_LOG_ERROR,
            "ota: registry does not accept CBOR check-ins; upgrade the registry to a version that "
            "supports application/cbor");
        result_.status = MIKOtaCheckStatus::kFailed;
        result_.http_status = 415;
        result_.error.name = "Status";
        FinishRound(NextRound::kSoon);
        return;
    }
    if (http_status_ < 200 || http_status_ >= 300) {
        Log(MIK_LOG_ERROR, "ota: checkin returned status %d", http_status_);
        result_.status = MIKOtaCheckStatus::kFailed;
        result_.http_status = http_status_;
        result_.error.name = "Status";
        FinishRound(NextRound::kSoon);
        return;
    }
    if (response_too_large_) {
        Log(MIK_LOG_ERROR, "ota: checkin response exceeds %zu bytes",
            MIK__OTA_MAX_RESPONSE_BYTES);
        result_.status = MIKOtaCheckStatus::kFailed;
        result_.error.name = "TooLarge";
        char buf[64];
        snprintf(buf, sizeof(buf), "check-in response exceeds %zu bytes",
                 MIK__OTA_MAX_RESPONSE_BYTES);
        result_.error.message = buf;
        FinishRound(NextRound::kSoon);
        return;
    }

    nanocbor_value_t val;
    nanocbor_decoder_init(&val, response_body_.data(), response_body_.size());
    nanocbor_value_t map;
    /* A registry with nothing to send (no offer, no config, no name) answers
     * with CBOR null or an empty body. That is a completed round, not a decode
     * failure: the JS client read it that way, and failing it here put every
     * quiet round on the 60s retry cadence instead of the configured interval. */
    bool empty_response = response_body_.empty() || nanocbor_get_null(&val) >= 0;
    if (!empty_response &&
        (nanocbor_get_type(&val) != NANOCBOR_TYPE_MAP || nanocbor_enter_map(&val, &map) < 0)) {
        Log(MIK_LOG_ERROR, "ota: invalid checkin response body");
        result_.status = MIKOtaCheckStatus::kFailed;
        result_.error.name = "DecodeFailed";
        result_.error.message = "check-in response is not a CBOR map";
        FinishRound(NextRound::kSoon);
        return;
    }

    // The check-in completed: the cached reports are delivered.
    has_last_install_ = false;
    has_last_decline_ = false;

    // Confirm before applying: a completed check-in is the whole health signal
    // require_confirm waits for, whether or not an offer follows — and resolving
    // the trial now lets an offer published during it stage in this same pass.
    if (running_.trial) {
        Log(MIK_LOG_INFO, "ota: check-in completed — confirming this build as healthy");
    }
    mik__ota_policy_confirm(env_);

    // A completed check-in is the health signal for BOTH trials: the build's
    // (confirmed above) and a running-release config delivery's. The config
    // trial additionally waits for the app to have READ the document — a
    // check-in completing before the app ever ran with the new values proves
    // nothing about them.
    // A read that FAILED is not a read that found nothing: it fails under the
    // heap pressure this check-in just created, and adopting on it would take a
    // document the app never read.
    MIKOtaConfigTrial config_trial = {};
    MIKOtaKvStatus trial_status = mik__ota_load_trial(env_, &config_trial);
    if (trial_status == MIK_OTA_KV_ABSENT || (trial_status == MIK_OTA_KV_OK && config_trial.read)) {
        mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
        mik__ota_clear_trial(env_);
    }

    bool has_url_key = false;
    std::string offer_url;
    std::string offer_checksum;
    int64_t offer_size = -1;

    bool has_name_key = false;
    bool name_valid = false;
    int name_rev = 0;
    std::string name_value;

    bool has_config_key = false;
    have_response_config_ = false;
    response_config_ = MIKOtaStoredConfig();
    response_config_doc_.clear();

    while (!empty_response && !nanocbor_at_end(&map)) {
        std::string key;
        if (!take_key(&map, &key)) break;
        if (key == "url") {
            has_url_key = true;
            if (!take_string(&map, &offer_url)) mik__cbor_skip_value(&map);
        } else if (key == "checksum") {
            if (!take_string(&map, &offer_checksum)) mik__cbor_skip_value(&map);
        } else if (key == "size") {
            uint64_t size = 0;
            if (nanocbor_get_uint64(&map, &size) >= 0) {
                offer_size = static_cast<int64_t>(size);
            } else {
                mik__cbor_skip_value(&map);
            }
        } else if (key == "name") {
            has_name_key = true;
            nanocbor_value_t arr;
            if (nanocbor_enter_array(&map, &arr) < 0) {
                mik__cbor_skip_value(&map);
                continue;
            }
            int32_t rev = 0;
            // No `name` field means "no change" and never "clear it"; junk in
            // the pair is treated the same way.
            if (nanocbor_get_int32(&arr, &rev) >= 0 && rev >= 0) {
                name_rev = rev;
                name_valid = true;
                if (!nanocbor_at_end(&arr)) take_string(&arr, &name_value);
            }
            mik__cbor_skip_value(&map);
        } else if (key == "config") {
            has_config_key = true;
            nanocbor_value_t cfg;
            if (nanocbor_enter_map(&map, &cfg) < 0) {
                mik__cbor_skip_value(&map);
                continue;
            }
            while (!nanocbor_at_end(&cfg)) {
                std::string cfg_key;
                if (!take_key(&cfg, &cfg_key)) break;
                if (cfg_key == "version") {
                    if (take_str(&cfg, response_config_.version,
                                 sizeof(response_config_.version)) &&
                        response_config_.version[0]) {
                        have_response_config_ = true;
                    } else {
                        mik__cbor_skip_value(&cfg);
                    }
                } else if (cfg_key == "rev") {
                    if (!take_str(&cfg, response_config_.rev, sizeof(response_config_.rev))) {
                        mik__cbor_skip_value(&cfg);
                    }
                } else if (cfg_key == "doc") {
                    const uint8_t* start = cfg.cur;
                    // An absent or null doc is the clear (spec, "Config sync").
                    if (nanocbor_get_null(&cfg) >= 0) continue;
                    if (mik__cbor_skip_value(&cfg) < 0) break;
                    response_config_doc_.assign(start, cfg.cur);
                } else {
                    mik__cbor_skip_value(&cfg);
                }
            }
            mik__cbor_skip_value(&map);
        } else {
            mik__cbor_skip_value(&map);
        }
    }
    // An empty rev normalises to absent (omit, never null).
    if (!have_response_config_) {
        response_config_doc_.clear();
    } else if (!response_config_doc_.empty()) {
        response_config_.doc_cbor = response_config_doc_.data();
        response_config_.doc_cbor_len = response_config_doc_.size();
    }

    if (has_name_key && name_valid) {
        if (env_ && env_->set_device_name) {
            env_->set_device_name(env_->opaque, name_rev,
                                  name_value.empty() ? nullptr : name_value.c_str());
        }
        Log(MIK_LOG_INFO, "ota: registry renamed this device to %s",
            name_value.empty() ? "(no name)" : name_value.c_str());
    }

    if (has_config_key && !have_response_config_) {
        // Malformed must not read as absent: a registry speaking a different
        // config dialect would otherwise look exactly like one sending none.
        Log(MIK_LOG_WARN,
            "ota: response carried a config field the client could not read; ignoring it");
    }

    std::string warn_reason;
    bool offer_valid = mik__ota_parse_offer(offer_url.c_str(), offer_checksum.c_str(), offer_size,
                                            allow_insecure_, &offer_, &warn_reason);
    // A check-in with nothing newer still returns a body when the registry has
    // something else to say, so a missing url is "no update", not a bad offer.
    if (has_url_key && !offer_valid && !warn_reason.empty()) {
        Log(MIK_LOG_WARN, "ota: ignoring offer (%s)", warn_reason.c_str());
    }

    if (!has_url_key || !offer_valid) {
        // OR in this boot's promote/restore, delivered once: the config those
        // applied is as new to the app as one this round delivered.
        bool updated = ApplyRunningConfig(have_response_config_ ? &response_config_ : nullptr,
                                          active_.options.trial_boots);
        updated = updated || boot_config_changed_;
        boot_config_changed_ = false;
        Log(MIK_LOG_DEBUG, "ota: up to date, running the latest build");
        result_.status = MIKOtaCheckStatus::kUpToDate;
        result_.config_updated = updated;
        FinishRound(NextRound::kLater);
        return;
    }

    // Announce the offer without promising action: the policy may decline it
    // before any download — the pump logs when bytes actually start moving.
    Log(MIK_LOG_INFO, "ota: update available (%.12s, %zu bytes)", offer_.checksum.c_str(),
        offer_.size);

    MIKOtaApplyOutcome outcome = MIKOtaApplyOutcome::kStaged;
    MIKOtaError error;
    if (!mik__ota_policy_apply_begin(env_, offer_, &apply_, &outcome, &error)) {
        Log(MIK_LOG_ERROR, "ota: update failed (%s: %s)", error.name.c_str(),
            error.message.c_str());
        result_.status = MIKOtaCheckStatus::kNotStaged;
        result_.decline_reason = MIKOtaDeclineReason::kInstallFailed;
        result_.error = error;
        NoteDecline(MIKOtaDeclineReason::kInstallFailed, error.message);
        FinishRound(NextRound::kLater);
        return;
    }
    if (!apply_.update) {
        Log(MIK_LOG_INFO, "ota: offer not staged (%s)", mik__ota_outcome_to_str(outcome));
        result_.status = MIKOtaCheckStatus::kNotStaged;
        switch (outcome) {
            case MIKOtaApplyOutcome::kTrialPending:
                result_.decline_reason = MIKOtaDeclineReason::kTrialPending;
                break;
            case MIKOtaApplyOutcome::kAbandoned:
                result_.decline_reason = MIKOtaDeclineReason::kAbandoned;
                break;
            case MIKOtaApplyOutcome::kExhausted:
                result_.decline_reason = MIKOtaDeclineReason::kExhausted;
                break;
            default:
                result_.decline_reason = MIKOtaDeclineReason::kCurrent;
                break;
        }
        NoteDecline(result_.decline_reason, "");
        FinishRound(NextRound::kLater);
        return;
    }

    if (!BeginDownload()) OnDownloadSettled();
}

bool MIKOtaClient::BeginDownload() {
    size_t from = apply_.update->resume_offset();
    // Already complete: a finish that failed transiently leaves every byte on
    // flash and the offer pending, so resuming would ask for `bytes=<size>-` and
    // take the 416 as a failed download forever. Go straight to re-verifying.
    if (from >= offer_.size) {
        http_done_ = true;
        http_status_ = 200;
        http_error_.clear();
        write_failed_ = false;
        return false;
    }

    if (from > 0) {
        Log(MIK_LOG_INFO, "ota: resuming download from byte %zu of %zu", from, offer_.size);
    } else {
        Log(MIK_LOG_INFO, "ota: downloading %zu bytes", offer_.size);
    }

    std::vector<const char*> keys;
    std::vector<std::string> values;
    char range[64] = {};
    if (from > 0) {
        snprintf(range, sizeof(range), "bytes=%zu-", from);
        keys.push_back("range");
        values.push_back(range);
    }
    // Same-origin only. offer.url may legitimately point at another host (a CDN,
    // an object store), so the update key goes out only when the download is on
    // the registry's own origin. A build fetched elsewhere is a public artifact
    // the checksum vouches for.
    if (mik__ota_same_origin(offer_.url, active_.registry_url)) {
        keys.push_back("authorization");
        values.push_back("Bearer " + active_.bearer);
    }
    std::vector<const char*> value_ptrs;
    value_ptrs.reserve(values.size());
    for (const std::string& value : values) value_ptrs.push_back(value.c_str());

    MIKOtaHttpRequest req = {};
    req.url = offer_.url.c_str();
    req.method = "GET";
    req.header_keys = keys.data();
    req.header_values = value_ptrs.data();
    req.header_count = keys.size();
    req.timeout_ms = active_.options.download_timeout_ms;

    http_done_ = false;
    http_status_ = 0;
    http_error_.clear();
    write_failed_ = false;
    write_error_ = MIKOtaError();
    download_skip_ = from;
    state_ = MIKOtaClientState::kDownload;

    MIKOtaHttpCallbacks cbs = {DownloadHeadersThunk, DataThunk, DoneThunk, this};
    http_handle_ = (env_ && env_->http_request) ? env_->http_request(env_->opaque, &req, &cbs)
                                               : nullptr;
    if (!http_handle_) {
        http_done_ = true;
        http_status_ = 0;
        if (http_error_.empty()) http_error_ = "request could not be started";
    }
    return true;
}

void MIKOtaClient::DownloadHeadersThunk(void* ud, int status) {
    auto* self = static_cast<MIKOtaClient*>(ud);
    self->http_status_ = status;
    // A 206 means the Range was honoured, so no prefix has to be dropped.
    if (status == 206) self->download_skip_ = 0;
}

void MIKOtaClient::OnDownloadSettled() {
    bool ok = true;
    std::string message;
    if (write_failed_) {
        ok = false;
        message = write_error_.message.empty() ? "staging write failed" : write_error_.message;
    } else if (http_status_ == 0 || !http_error_.empty()) {
        // A transport error means the transfer did not complete, whatever status
        // already arrived. Taking a truncated body as a finished download would
        // hand short bytes to finish(), fail the checksum, and abandon the
        // build as corrupt — permanently, since nothing ever clears `bad`.
        ok = false;
        message = "download failed: " + (http_error_.empty() ? "no response" : http_error_);
    } else if (http_status_ < 200 || http_status_ >= 300) {
        ok = false;
        char buf[64];
        snprintf(buf, sizeof(buf), "download returned status %d", http_status_);
        message = buf;
    }

    MIKOtaInstallOptions install;
    install.trial_boots = active_.options.trial_boots;
    install.require_confirm = active_.options.require_confirm;
    install.install_now = false;

    MIKOtaApplyOutcome outcome = MIKOtaApplyOutcome::kStaged;
    MIKOtaError error;
    if (!mik__ota_policy_apply_end(&apply_, ok, message, install, &outcome, &error)) {
        Log(MIK_LOG_ERROR, "ota: update failed (%s: %s)", error.name.c_str(),
            error.message.c_str());
        result_.status = MIKOtaCheckStatus::kNotStaged;
        result_.decline_reason = error.name == "DownloadFailed"
                                     ? MIKOtaDeclineReason::kDownloadFailed
                                     : MIKOtaDeclineReason::kInstallFailed;
        result_.error = error;
        NoteDecline(result_.decline_reason, error.message);
        FinishRound(NextRound::kLater);
        return;
    }

    // With an offer, the response's config is for the offered release: stage it
    // with the build, applied together at the trial boot. An absent doc is the
    // clear, so it stages "the new release holds no document" and the manifest
    // defaults stand in.
    if (have_response_config_ && response_config_.doc_cbor && response_config_.doc_cbor_len > 0) {
        mik__ota_store_slot(env_, MIK_OTA_CFG_NEXT, response_config_);
        Log(MIK_LOG_INFO, "ota: config staged for %s", response_config_.version);
    } else {
        mik__ota_clear_slot(env_, MIK_OTA_CFG_NEXT);
    }

    Log(MIK_LOG_INFO, "ota: download verified and staged");
    result_.status = MIKOtaCheckStatus::kStaged;
    result_.offer = offer_;
    FinishRound(NextRound::kLater);
}

bool MIKOtaClient::ApplyRunningConfig(const MIKOtaStoredConfig* config, int trial_boots) {
    if (!config) return false;

    if (!config->doc_cbor || config->doc_cbor_len == 0) {
        // A rev riding along does not turn a clear into a document.
        mik__ota_clear_trial(env_);
        mik__ota_clear_config_error(env_);
        mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
        if (!mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT).present) return false;
        mik__ota_clear_slot(env_, MIK_OTA_CFG_CURRENT);
        Log(MIK_LOG_INFO, "ota: config cleared by the registry");
        return true;
    }

    MIKOtaLoadedConfig previous = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT);

    // Without the document being replaced there is no baseline to roll back to,
    // and clearing the one already stored would strand a bad document with
    // nowhere to fall back to. Leave everything alone; the rev the device
    // echoes is unchanged, so the registry sends this again next round.
    if (previous.failed) return false;

    // A registry is meant to send config only when the rev the device echoed
    // differs, but one that sends it every round must not cost anything: taking
    // an identical document as a change would re-write NVS on every round, put
    // the document back on trial it had already passed, and tell the app its
    // config changed when nothing did. The rev counts as part of the document —
    // it is what the device echoes, so a new one has to be stored and echoed
    // back even when the values are the same.
    if (previous.present && strcmp(previous.cfg.rev, config->rev) == 0 &&
        strcmp(previous.cfg.version, config->version) == 0 &&
        previous.cfg.doc_cbor_len == config->doc_cbor_len &&
        (config->doc_cbor_len == 0 ||
         memcmp(previous.cfg.doc_cbor, config->doc_cbor, config->doc_cbor_len) == 0)) {
        return false;
    }

    // The old document is kept as the rollback baseline: a schema-valid value
    // can still be fatal to the app (a GPIO this board does not have), and the
    // crash it causes can fire before any check-in runs.
    if (previous.present) {
        mik__ota_store_slot(env_, MIK_OTA_CFG_PREV, previous.cfg);
    } else {
        mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
    }
    mik__ota_store_slot(env_, MIK_OTA_CFG_CURRENT, *config);
    MIKOtaConfigTrial trial = {trial_boots, false};
    mik__ota_store_trial(env_, trial);
    mik__ota_clear_config_error(env_);
    Log(MIK_LOG_INFO, "ota: config updated for %s", config->version);
    return true;
}

void MIKOtaClient::FinishRound(NextRound next) {
    // Teardown before any restart: the round is over either way, and the hook's
    // invariant — teardown runs whenever setup succeeded — must not depend on
    // what the check found.
    if (teardown_armed_ && watch_options_.hooks && watch_options_.hooks->BeginTeardown()) {
        pending_next_ = next;
        state_ = MIKOtaClientState::kTeardown;
        return;
    }
    Finalize(next);
}

void MIKOtaClient::Finalize(NextRound next) {
    teardown_armed_ = false;
    state_ = MIKOtaClientState::kIdle;

    if (!active_.is_watch) {
        MIKOtaCheckSink sink = std::move(active_.sink);
        active_ = Round();
        if (sink) sink(result_);
        return;
    }
    active_ = Round();

    /* Before the restart decision: a round that staged a build is still a round
     * the app is entitled to hear about. */
    if (watch_options_.on_round) watch_options_.on_round(result_);

    if (result_.status == MIKOtaCheckStatus::kStaged) {
        if (watch_stopped_) {
            // stop() won the race: leave the build armed for the next natural
            // reboot instead of restarting under the caller.
            Log(MIK_LOG_INFO, "ota: update staged; watcher stopped, restart deferred");
            return;
        }
        Log(MIK_LOG_INFO, "ota: staged; restarting to install");
        if (env_ && env_->restart) env_->restart(env_->opaque);
        return;
    }
    ScheduleNext(next);
}

void MIKOtaClient::ScheduleNext(NextRound next) {
    if (!watching_ || watch_stopped_) return;
    int64_t base = next == NextRound::kLater ? watch_options_.checkin_interval_ms
                                             : watch_options_.retry_after_failure_ms;
    scheduled_delay_ms_ = Jitter(base);
    wait_started_ms_ = Now();
    deadline_ms_ = wait_started_ms_ + scheduled_delay_ms_;
    pending_wait_ = next == NextRound::kLater ? PendingWait::kInterval : PendingWait::kRetry;
}

}  // namespace mikrojs

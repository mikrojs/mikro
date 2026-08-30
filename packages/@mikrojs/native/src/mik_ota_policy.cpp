#include "mikrojs/ota_policy.h"

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#include "mikrojs/ota_config.h"
#include "mikrojs/platform.h"

namespace mikrojs {

/* Staging attempts for one url before a checksum is abandoned. */
constexpr int32_t MIK__OTA_MAX_TRIES = 3;

const char* mik__ota_outcome_to_str(MIKOtaApplyOutcome outcome) {
    switch (outcome) {
        case MIKOtaApplyOutcome::kStaged:
            return "staged";
        case MIKOtaApplyOutcome::kTrialPending:
            return "trial-pending";
        case MIKOtaApplyOutcome::kCurrent:
            return "current";
        case MIKOtaApplyOutcome::kAbandoned:
            return "abandoned";
        case MIKOtaApplyOutcome::kExhausted:
            return "exhausted";
    }
    return "unknown";
}

// ── MIKOtaStore ──────────────────────────────────────────────────────────────

namespace {

/* FNV-1a, rendered as hex. Identity for a cache key, not a security property:
 * the worst a collision does is deny one build a fresh retry budget. */
std::string url_digest(const std::string& url) {
    uint64_t hash = 1469598103934665603ull;
    for (unsigned char c : url) {
        hash ^= c;
        hash *= 1099511628211ull;
    }
    char out[17];
    snprintf(out, sizeof(out), "%016llx", static_cast<unsigned long long>(hash));
    return out;
}

}  // namespace

bool MIKOtaStore::UrlMatches(const std::string& url) const {
    if (!env_ || !env_->kv_get_str) return false;
    char buf[17] = {};
    if (!env_->kv_get_str(env_->opaque, "ota.url", buf, sizeof(buf))) return false;
    return url_digest(url) == buf;
}

void MIKOtaStore::SetUrl(const std::string& url) {
    if (!env_ || !env_->kv_set_str) return;
    env_->kv_set_str(env_->opaque, "ota.url", url_digest(url).c_str());
}

std::string MIKOtaStore::GetAttempt() const {
    if (!env_ || !env_->kv_get_str) return "";
    char buf[128] = {};
    if (env_->kv_get_str(env_->opaque, "ota.att", buf, sizeof(buf))) {
        return buf;
    }
    return "";
}

void MIKOtaStore::SetAttempt(const std::string& checksum) {
    if (!env_ || !env_->kv_set_str) return;
    env_->kv_set_str(env_->opaque, "ota.att", checksum.c_str());
}

int32_t MIKOtaStore::GetTries() const {
    if (!env_ || !env_->kv_get_i32) return 0;
    int32_t val = 0;
    if (env_->kv_get_i32(env_->opaque, "ota.tries", &val)) {
        return val;
    }
    return 0;
}

void MIKOtaStore::SetTries(int32_t n) {
    if (!env_ || !env_->kv_set_i32) return;
    env_->kv_set_i32(env_->opaque, "ota.tries", n);
}

std::string MIKOtaStore::GetBad() const {
    if (!env_ || !env_->kv_get_str) return "";
    char buf[128] = {};
    if (env_->kv_get_str(env_->opaque, "ota.bad", buf, sizeof(buf))) {
        return buf;
    }
    return "";
}

void MIKOtaStore::SetBad(const std::string& checksum) {
    if (!env_ || !env_->kv_set_str) return;
    env_->kv_set_str(env_->opaque, "ota.bad", checksum.c_str());
}

bool MIKOtaStore::GetInFlight() const {
    if (!env_ || !env_->kv_get_i32) return false;
    int32_t val = 0;
    if (env_->kv_get_i32(env_->opaque, "ota.inflight", &val)) {
        return val == 1;
    }
    return false;
}

void MIKOtaStore::SetInFlight(bool in_flight) {
    if (!env_ || !env_->kv_set_i32) return;
    env_->kv_set_i32(env_->opaque, "ota.inflight", in_flight ? 1 : 0);
}

bool MIKOtaStore::GetDecline(MIKOtaDeclineRecord* out) const {
    if (!env_ || !env_->kv_get_str) return false;
    if (!env_->kv_get_str(env_->opaque, "ota.declined", out->checksum, sizeof(out->checksum)) ||
        out->checksum[0] == '\0') {
        return false;
    }
    if (!env_->kv_get_str(env_->opaque, "ota.declReason", out->reason, sizeof(out->reason)) ||
        out->reason[0] == '\0') {
        return false;
    }
    if (!env_->kv_get_str(env_->opaque, "ota.declDetail", out->detail, sizeof(out->detail))) {
        out->detail[0] = '\0';
    }
    return true;
}

void MIKOtaStore::SetDecline(const MIKOtaDeclineRecord& record) {
    if (!env_ || !env_->kv_set_str) return;
    env_->kv_set_str(env_->opaque, "ota.declined", record.checksum);
    env_->kv_set_str(env_->opaque, "ota.declReason", record.reason);
    if (record.detail[0]) {
        env_->kv_set_str(env_->opaque, "ota.declDetail", record.detail);
    } else if (env_->kv_remove) {
        env_->kv_remove(env_->opaque, "ota.declDetail");
    }
}

void MIKOtaStore::ClearDecline() {
    if (!env_ || !env_->kv_remove) return;
    env_->kv_remove(env_->opaque, "ota.declined");
    env_->kv_remove(env_->opaque, "ota.declReason");
    env_->kv_remove(env_->opaque, "ota.declDetail");
}

// ── Offer parsing ────────────────────────────────────────────────────────────

bool mik__ota_parse_offer(const char* url, const char* checksum, int64_t size, bool allow_insecure,
                         MIKOtaOffer* out_offer, std::string* out_warn_reason) {
    if (!url) return false;

    std::string s_url = url;
    bool is_https = s_url.rfind("https://", 0) == 0;
    bool is_http = s_url.rfind("http://", 0) == 0;
    bool scheme_ok = is_https || (allow_insecure && is_http);

    size_t query_pos = s_url.find_first_of("?#");
    std::string path = (query_pos == std::string::npos) ? s_url : s_url.substr(0, query_pos);

    bool ends_with_tgz = path.size() >= 4 && path.compare(path.size() - 4, 4, ".tgz") == 0;

    if (!scheme_ok || !ends_with_tgz) {
        if (out_warn_reason) {
            *out_warn_reason =
                allow_insecure ? "url must be an http(s) .tgz" : "url must be an https .tgz";
        }
        return false;
    }

    if (!checksum || strlen(checksum) == 0) {
        if (out_warn_reason) {
            *out_warn_reason = "missing checksum";
        }
        return false;
    }

    if (size <= 0) {
        if (out_warn_reason) {
            *out_warn_reason = "invalid size";
        }
        return false;
    }

    if (out_offer) {
        out_offer->url = s_url;
        out_offer->checksum = checksum;
        out_offer->size = static_cast<size_t>(size);
    }
    return true;
}

// ── Policy Operations ────────────────────────────────────────────────────────

MIKOtaReconcileOutcome mik__ota_policy_reconcile(const MIKOtaEnv* env) {
    MIKOtaStore store(env);
    if (store.GetInFlight()) {
        store.SetInFlight(false);
    } else {
        store.SetTries(0);
    }
    MIKOtaReconcileOutcome outcome = {};
    if (env && env->reconcile) {
        env->reconcile(env->opaque, &outcome);
    }
    return outcome;
}

MIKOtaRunningBuild mik__ota_policy_running(const MIKOtaEnv* env) {
    MIKOtaRunningBuild run = {};
    if (env && env->running) {
        env->running(env->opaque, &run);
    }
    if (strlen(run.version) == 0 && env && env->read_app_version) {
        env->read_app_version(env->opaque, run.version, sizeof(run.version));
    }
    return run;
}

bool mik__ota_policy_revert(const MIKOtaEnv* env, MIKOtaError* out_err) {
    char err_buf[256] = {};
    if (env && env->revert && env->revert(env->opaque, err_buf, sizeof(err_buf))) {
        return true;
    }
    if (out_err) {
        out_err->name = "InstallFailed";
        out_err->kind = "transient";
        out_err->message = err_buf[0] ? err_buf : "revert failed";
    }
    return false;
}

void mik__ota_policy_confirm(const MIKOtaEnv* env) {
    if (env && env->mark_valid) {
        env->mark_valid(env->opaque);
    }
    // One confirm settles both trials. A completed check-in is the health
    // signal each of them waits for, so an app running its own client gets the
    // config trial resolved by the same call the built-in client makes — and
    // the two cannot drift into settling one trial but not the other. The
    // config trial has its own extra gate (the app must have read the
    // document), which lives in mik__ota_adopt_config_trial.
    mik__ota_adopt_config_trial(env);
}

namespace {

/* The staging session handed to the download pump. Bounds every write against
 * the offered size, counting bytes already on flash from a resumed transfer. */
class UpdateImpl : public MIKOtaUpdate {
public:
    UpdateImpl(const MIKOtaEnv* env, size_t size, size_t resume_offset)
        : env_(env), size_(size), resume_offset_(resume_offset), written_(resume_offset) {}

    size_t resume_offset() const override { return resume_offset_; }

    bool write(const uint8_t* bytes, size_t len, MIKOtaError* out_err) override {
        if (written_ + len > size_) {
            if (out_err) {
                out_err->name = "TooLarge";
                char buf[128];
                snprintf(buf, sizeof(buf), "build exceeds offered size %zu", size_);
                out_err->message = buf;
            }
            return false;
        }
        char eb[256] = {};
        if (!env_ || !env_->stage_write ||
            !env_->stage_write(env_->opaque, bytes, len, eb, sizeof(eb))) {
            if (out_err) {
                out_err->name = "StagingFull";
                out_err->message = eb[0] ? eb : "staging full";
            }
            return false;
        }
        written_ += len;
        return true;
    }

    bool finish(const MIKOtaInstallOptions& opts, MIKOtaError* out_err) override {
        char eb[256] = {};
        int err_kind = 0;
        if (!env_ || !env_->stage_finish ||
            !env_->stage_finish(env_->opaque, opts.trial_boots, opts.require_confirm,
                                opts.install_now, eb, sizeof(eb), &err_kind)) {
            if (out_err) {
                out_err->name = "InstallFailed";
                out_err->kind = (err_kind == MIK_OTA_ERR_CORRUPT) ? "corrupt"
                                : (err_kind == MIK_OTA_ERR_OOM)   ? "oom"
                                                                  : "transient";
                out_err->message = eb[0] ? eb : "install failed";
            }
            return false;
        }
        return true;
    }

    void abort() override {
        if (env_ && env_->stage_abort) {
            env_->stage_abort(env_->opaque);
        }
    }

private:
    const MIKOtaEnv* env_;
    size_t size_;
    size_t resume_offset_;
    size_t written_;
};

}  // namespace

bool mik__ota_policy_apply_begin(const MIKOtaEnv* env, const MIKOtaOffer& offer,
                                 MIKOtaApplySession* session, MIKOtaApplyOutcome* out_outcome,
                                 MIKOtaError* out_err) {
    session->env = env;
    session->checksum = offer.checksum;
    session->update.reset();

    MIKOtaRunningBuild run = {};
    if (env && env->running) {
        env->running(env->opaque, &run);
    }

    // (a) a trial is unresolved. Reported distinctly because the caller's
    // response differs from every other skip: the build on trial still needs
    // confirming, and treating this like "nothing to do" lets the trial lapse
    // and roll back a healthy build just because a newer one was published.
    if (run.trial) {
        if (out_outcome) *out_outcome = MIKOtaApplyOutcome::kTrialPending;
        return true;
    }

    // (b) already running this build
    if (!offer.checksum.empty() && offer.checksum == run.checksum) {
        if (out_outcome) *out_outcome = MIKOtaApplyOutcome::kCurrent;
        return true;
    }

    // (d) device has given up on this build
    MIKOtaStore store(env);
    if (!offer.checksum.empty() && offer.checksum == store.GetBad()) {
        if (out_outcome) *out_outcome = MIKOtaApplyOutcome::kAbandoned;
        return true;
    }

    // (e) retry budget, keyed on url *and* checksum. Exhausting it only stops
    // attempts against this exact build at this exact url; the checksum is not
    // abandoned, because everything counted here is transient by construction
    // (a corrupt build is abandoned in apply_end instead).
    if (!store.UrlMatches(offer.url) || offer.checksum != store.GetAttempt()) {
        store.SetUrl(offer.url);
        store.SetAttempt(offer.checksum);
        store.SetTries(0);
    }
    int32_t tries = store.GetTries();
    if (tries >= MIK__OTA_MAX_TRIES) {
        if (out_outcome) *out_outcome = MIKOtaApplyOutcome::kExhausted;
        return true;
    }

    // (f) bump before the attempt, so an attempt that crashes the device still
    // counts — the in-flight flag is what carries that across the reboot (see
    // mik__ota_policy_reconcile). apply_end clears it on every ordinary exit,
    // and deliberately never runs when the attempt takes the device down.
    store.SetTries(tries + 1);
    store.SetInFlight(true);

    // (g) open staging
    size_t resume_offset = 0;
    char err_buf[256] = {};
    if (!env || !env->stage_begin ||
        !env->stage_begin(env->opaque, offer.checksum.c_str(), offer.size, &resume_offset, err_buf,
                          sizeof(err_buf))) {
        store.SetInFlight(false);
        if (out_err) {
            out_err->name = "StagingFailed";
            out_err->message = err_buf[0] ? err_buf : "staging failed";
        }
        return false;
    }

    session->update = std::make_unique<UpdateImpl>(env, offer.size, resume_offset);
    return true;
}

bool mik__ota_policy_apply_end(MIKOtaApplySession* session, bool download_ok,
                               const std::string& download_message,
                               const MIKOtaInstallOptions& options,
                               MIKOtaApplyOutcome* out_outcome, MIKOtaError* out_err) {
    MIKOtaStore store(session->env);
    MIKOtaUpdate* update = session->update.get();
    struct Closer {
        MIKOtaApplySession* s;
        MIKOtaStore& store;
        ~Closer() {
            s->update.reset();
            store.SetInFlight(false);
        }
    } closer{session, store};

    if (!update) {
        if (out_err) {
            out_err->name = "StagingFailed";
            out_err->message = "no staging session";
        }
        return false;
    }

    // A failure in the download is transient whatever tripped it: keep the
    // bumped tries so it retries next time, and do NOT abandon the checksum
    // (that is only for a corrupt build). The pump's own error name — a
    // TooLarge or StagingFull from a write — is folded into the message, so
    // the caller can key on DownloadFailed alone.
    if (!download_ok) {
        update->abort();
        if (out_err) {
            out_err->name = "DownloadFailed";
            out_err->kind.clear();
            out_err->message = download_message;
        }
        return false;
    }

    // A corrupt build is the one thing worth abandoning: the same bytes will
    // fail identically forever. Abort first, or the verified-bad staging file
    // (up to the whole build) sits on the app partition until some later offer
    // happens to reclaim it.
    if (!update->finish(options, out_err)) {
        if (out_err && out_err->name == "InstallFailed" && out_err->kind == "corrupt") {
            update->abort();
            store.SetBad(session->checksum);
        }
        return false;
    }

    store.SetTries(0);
    if (out_outcome) *out_outcome = MIKOtaApplyOutcome::kStaged;
    return true;
}

bool mik__ota_policy_apply_offer(const MIKOtaEnv* env, const MIKOtaOffer& offer,
                                 MIKOtaDownloadFn download, const MIKOtaInstallOptions& options,
                                 MIKOtaApplyOutcome* out_outcome, MIKOtaError* out_err) {
    MIKOtaApplySession session;
    if (!mik__ota_policy_apply_begin(env, offer, &session, out_outcome, out_err)) return false;
    if (!session.update) return true;  // declined before staging

    MIKOtaError dl_err;
    bool downloaded = download(*session.update, &dl_err);
    std::string message = dl_err.message.empty() ? "download failed" : dl_err.message;
    return mik__ota_policy_apply_end(&session, downloaded, message, options, out_outcome, out_err);
}

}  // namespace mikrojs

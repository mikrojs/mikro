#include "doctest.h"
#include "mikrojs/ota_policy.h"
#include "ota_fake_env.h"

using namespace mikrojs;
using namespace mikrojs::test;

TEST_SUITE("ota: policy") {

TEST_CASE("parseOffer: accepts a well-formed offer") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("https://updates.example.com/app-2.tgz", "abc123", 1024, false,
                                   &offer, &warn);
    CHECK(ok);
    CHECK(offer.url == "https://updates.example.com/app-2.tgz");
    CHECK(offer.checksum == "abc123");
    CHECK(offer.size == 1024);
    CHECK(warn.empty());
}

TEST_CASE("parseOffer: rejects invalid parameters") {
    MIKOtaOffer offer;
    std::string warn;
    CHECK(!mik__ota_parse_offer(nullptr, "abc123", 1024, false, &offer, &warn));
}

TEST_CASE("parseOffer: rejects a non-https url") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("http://updates.example.com/app.tgz", "abc123", 1024, false,
                                   &offer, &warn);
    CHECK(!ok);
    CHECK(!warn.empty());
}

TEST_CASE("parseOffer: accepts an http url only with allowInsecure") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("http://192.168.1.10:4873/app.tgz", "abc123", 1024, false,
                                   &offer, &warn);
    CHECK(!ok);

    ok = mik__ota_parse_offer("http://192.168.1.10:4873/app.tgz", "abc123", 1024, true, &offer,
                              &warn);
    CHECK(ok);
    CHECK(offer.url == "http://192.168.1.10:4873/app.tgz");

    ok = mik__ota_parse_offer("http://x/app.zip", "abc123", 1024, true, &offer, &warn);
    CHECK(!ok);
}

TEST_CASE("parseOffer: rejects a url that is not a .tgz") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("https://updates.example.com/app.zip", "abc123", 1024, false,
                                   &offer, &warn);
    CHECK(!ok);
}

TEST_CASE("parseOffer: accepts a query after the .tgz path, and still checks the path") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("https://updates.example.com/app-2.tgz?exp=123&sig=abc",
                                   "abc123",
                                   1024, false, &offer, &warn);
    CHECK(ok);
    CHECK(offer.url == "https://updates.example.com/app-2.tgz?exp=123&sig=abc");

    ok = mik__ota_parse_offer("https://updates.example.com/app.zip?x=.tgz", "abc123", 1024, false,
                              &offer, &warn);
    CHECK(!ok);
}

TEST_CASE("parseOffer: rejects an empty checksum") {
    MIKOtaOffer offer;
    std::string warn;
    bool ok = mik__ota_parse_offer("https://updates.example.com/app.tgz", "", 1024, false, &offer,
                                   &warn);
    CHECK(!ok);
    CHECK(warn == "missing checksum");
}

TEST_CASE("parseOffer: rejects non-positive size") {
    MIKOtaOffer offer;
    std::string warn;
    CHECK(!mik__ota_parse_offer("https://updates.example.com/app.tgz", "abc123", 0, false, &offer,
                                &warn));
    CHECK(!mik__ota_parse_offer("https://updates.example.com/app.tgz", "abc123", -5, false, &offer,
                                &warn));
}

TEST_CASE("applyOffer: stages a compatible, fresh offer (happy path)") {
    FakeOtaEnv env;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    bool download_called = false;
    auto download = [&](MIKOtaUpdate& update, MIKOtaError*) {
        download_called = true;
        uint8_t bytes[3] = {1, 2, 3};
        CHECK(update.write(bytes, 3, nullptr));
        return true;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kStaged);
    CHECK(download_called);
    CHECK(env.last_stage_finish_trial_boots == 1);
    CHECK(!env.last_stage_finish_require_confirm);
    CHECK(!env.last_stage_finish_install_now);

    MIKOtaStore store(env.env());
    CHECK(store.GetTries() == 0);
    CHECK(store.UrlMatches(offer.url));
}

TEST_CASE("applyOffer: returns DownloadFailed and does not abandon when the download fails") {
    FakeOtaEnv env;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    auto download = [&](MIKOtaUpdate&, MIKOtaError* out_err) {
        if (out_err) {
            out_err->name = "DownloadFailed";
            out_err->message = "network down";
        }
        return false;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(err.name == "DownloadFailed");
    CHECK(env.stage_abort_calls == 1);

    MIKOtaStore store(env.env());
    CHECK(store.GetBad() != offer.checksum);
    CHECK(store.GetTries() == 1);
}

TEST_CASE("applyOffer: forwards install options to stageFinish") {
    FakeOtaEnv env;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;
    opts.trial_boots = 3;
    opts.require_confirm = true;
    opts.install_now = true;

    auto download = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t bytes[3] = {1, 2, 3};
        return update.write(bytes, 3, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kStaged);
    CHECK(env.last_stage_finish_trial_boots == 3);
    CHECK(env.last_stage_finish_require_confirm);
    CHECK(env.last_stage_finish_install_now);
}

TEST_CASE("applyOffer: reports trial-pending when a trial is unresolved") {
    FakeOtaEnv env;
    env.running_build.trial = true;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(
        env.env(), offer, [](MIKOtaUpdate&, MIKOtaError*) { return true; }, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kTrialPending);
}

TEST_CASE("applyOffer: reports trial-pending even when the offer is the build on trial") {
    FakeOtaEnv env;
    env.running_build.trial = true;
    env.running_build.checksum[0] = 'a';
    snprintf(env.running_build.checksum, sizeof(env.running_build.checksum), "abc123");
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(
        env.env(), offer, [](MIKOtaUpdate&, MIKOtaError*) { return true; }, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kTrialPending);
}

TEST_CASE("applyOffer: reports current when the offer is already running") {
    FakeOtaEnv env;
    env.running_build.trial = false;
    snprintf(env.running_build.checksum, sizeof(env.running_build.checksum), "abc123");
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(
        env.env(), offer, [](MIKOtaUpdate&, MIKOtaError*) { return true; }, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kCurrent);
}

TEST_CASE("applyOffer: reports abandoned for a checksum the device has given up on") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetBad("abc123");

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(
        env.env(), offer, [](MIKOtaUpdate&, MIKOtaError*) { return true; }, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kAbandoned);
}

TEST_CASE("applyOffer: stops attempting a url once the budget is spent, without abandoning it") {
    FakeOtaEnv env;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    auto failDownload = [](MIKOtaUpdate&, MIKOtaError* out_err) {
        if (out_err) {
            out_err->name = "DownloadFailed";
            out_err->message = "net fail";
        }
        return false;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    CHECK(!mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err));
    CHECK(!mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err));
    CHECK(!mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err));

    MIKOtaStore store(env.env());
    CHECK(store.GetTries() == 3);
    CHECK(store.GetBad().empty());

    bool res = mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err);
    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kExhausted);
}

TEST_CASE("applyOffer: counts an attempt that crashed the device instead of returning") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetUrl("https://updates.example.com/app-2.tgz");
    store.SetAttempt("abc123");
    store.SetTries(2);
    store.SetInFlight(true);

    mik__ota_policy_reconcile(env.env());

    CHECK(!store.GetInFlight());
    CHECK(store.GetTries() == 2);

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;
    auto failDownload = [](MIKOtaUpdate&, MIKOtaError* out_err) {
        if (out_err) out_err->name = "DownloadFailed";
        return false;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    CHECK(!mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err));
    CHECK(store.GetTries() == 3);

    bool res = mik__ota_policy_apply_offer(env.env(), offer, failDownload, opts, &outcome, &err);
    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kExhausted);
}

TEST_CASE("applyOffer: returns the budget on the next boot") {
    // Everything the budget counts is transient (an OOM, a truncated download),
    // and a reboot is the only signal available here that conditions may have
    // changed. Without the reset the budget is a permanent latch: three OOM
    // failures would strand the device on the old build forever.
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetUrl("https://updates.example.com/app-2.tgz");
    store.SetAttempt("abc123");
    store.SetTries(3);

    mik__ota_policy_reconcile(env.env());
    CHECK(store.GetTries() == 0);

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;
    auto drain = [](MIKOtaUpdate&, MIKOtaError*) { return true; };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    CHECK(mik__ota_policy_apply_offer(env.env(), offer, drain, opts, &outcome, &err));
    CHECK(outcome == MIKOtaApplyOutcome::kStaged);
}

TEST_CASE("applyOffer: does not abandon the checksum when staging cannot begin") {
    // The failure is a property of the offer, not of the build's bytes, so it
    // must not reach the permanent blacklist: nothing clears `bad`, and the
    // abandoned check runs before the retry budget, so a corrected re-publish
    // could never revive it.
    FakeOtaEnv env;
    env.stage_begin_ok = false;
    env.stage_begin_err = "checksum must be 64 lowercase hex characters";

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;
    auto drain = [](MIKOtaUpdate&, MIKOtaError*) { return true; };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    CHECK(!mik__ota_policy_apply_offer(env.env(), offer, drain, opts, &outcome, &err));
    CHECK(err.name == "StagingFailed");

    MIKOtaStore store(env.env());
    CHECK(store.GetBad().empty());
    // The in-flight flag must not be left set either: nothing crashed, so the
    // next boot should still hand the budget back.
    CHECK(!store.GetInFlight());
}

TEST_CASE("applyOffer: still hands the budget back after a failure that returned") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetUrl("https://updates.example.com/app-2.tgz");
    store.SetAttempt("abc123");
    store.SetTries(2);
    store.SetInFlight(false);

    mik__ota_policy_reconcile(env.env());

    CHECK(!store.GetInFlight());
    CHECK(store.GetTries() == 0);
}

TEST_CASE("applyOffer: resets the budget when the url changes") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetUrl("https://updates.example.com/old.tgz");
    store.SetAttempt("abc123");
    store.SetTries(3);

    MIKOtaOffer newUrlOffer = {"https://updates.example.com/new.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;
    auto okDownload = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t b[1] = {1};
        return update.write(b, 1, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res =
        mik__ota_policy_apply_offer(env.env(), newUrlOffer, okDownload, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kStaged);
    CHECK(store.GetTries() == 0);
    CHECK(store.UrlMatches(newUrlOffer.url));
}

TEST_CASE("applyOffer: the budget still binds for a url too long to store") {
    // A presigned build url runs to several hundred bytes. Stored verbatim it
    // does not fit the device's kv, so it never compared equal, the budget reset
    // on every round, and a build that could not install retried forever without
    // ever reporting `exhausted`.
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    const std::string long_url =
        "https://updates.example.com/builds/" + std::string(600, 'q') + "/app.tgz";
    MIKOtaOffer offer = {long_url, "abc123", 1024};

    store.SetUrl(long_url);
    store.SetAttempt("abc123");
    store.SetTries(3);

    MIKOtaInstallOptions opts;
    auto okDownload = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t b[1] = {1};
        return update.write(b, 1, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, okDownload, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kExhausted);
}

TEST_CASE("applyOffer: resets the budget when a new build arrives at an unchanged url") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());
    store.SetUrl("https://updates.example.com/latest.tgz");
    store.SetAttempt("abc123");
    store.SetTries(3);

    MIKOtaOffer nextBuild = {"https://updates.example.com/latest.tgz", "def456", 1024};
    MIKOtaInstallOptions opts;
    auto okDownload = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t b[1] = {1};
        return update.write(b, 1, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), nextBuild, okDownload, opts, &outcome, &err);

    CHECK(res);
    CHECK(outcome == MIKOtaApplyOutcome::kStaged);
    CHECK(store.GetTries() == 0);
    CHECK(store.GetAttempt() == "def456");
}

TEST_CASE("applyOffer: marks a checksum bad, releases staging, and errors on a corrupt finish") {
    FakeOtaEnv env;
    env.stage_finish_ok = false;
    env.stage_finish_err = "bad sha";
    env.stage_finish_err_kind = MIK_OTA_ERR_CORRUPT;

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    auto download = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t b[1] = {1};
        return update.write(b, 1, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(err.name == "InstallFailed");
    CHECK(err.kind == "corrupt");
    CHECK(env.stage_abort_calls == 1);

    MIKOtaStore store(env.env());
    CHECK(store.GetBad() == offer.checksum);
}

TEST_CASE("applyOffer: keeps the checksum retryable on a transient finish failure") {
    FakeOtaEnv env;
    env.stage_finish_ok = false;
    env.stage_finish_err = "flash write timeout";
    env.stage_finish_err_kind = MIK_OTA_ERR_TRANSIENT;

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    auto download = [](MIKOtaUpdate& update, MIKOtaError*) {
        uint8_t b[1] = {1};
        return update.write(b, 1, nullptr);
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(err.name == "InstallFailed");
    CHECK(err.kind == "transient");
    CHECK(env.stage_abort_calls == 0);

    MIKOtaStore store(env.env());
    CHECK(store.GetBad() != offer.checksum);
    CHECK(store.GetTries() == 1);
}

TEST_CASE("applyOffer: reports StagingFailed when staging cannot begin, without downloading") {
    FakeOtaEnv env;
    env.stage_begin_ok = false;
    env.stage_begin_err = "not enough space";

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1024};
    MIKOtaInstallOptions opts;

    bool download_called = false;
    auto download = [&](MIKOtaUpdate&, MIKOtaError*) {
        download_called = true;
        return true;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(err.name == "StagingFailed");
    CHECK(err.message == "not enough space");
    CHECK(!download_called);

    MIKOtaStore store(env.env());
    CHECK(store.GetBad() != offer.checksum);
}

TEST_CASE("applyOffer: enforces the offered size with TooLarge") {
    FakeOtaEnv env;
    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 10};
    MIKOtaInstallOptions opts;

    // The name the pump sees is TooLarge; the name applyOffer reports is always
    // DownloadFailed, because every download failure is transient by
    // construction and the caller keys its retry on that one name.
    std::string seen_name;
    auto download = [&seen_name](MIKOtaUpdate& update, MIKOtaError* out_err) {
        uint8_t bytes[15] = {};
        bool ok = update.write(bytes, 15, out_err);
        if (!ok && out_err) seen_name = out_err->name;
        return ok;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(seen_name == "TooLarge");
    CHECK(err.name == "DownloadFailed");
    CHECK(err.message == "build exceeds offered size 10");
}

TEST_CASE("applyOffer: maps a native write failure to StagingFull") {
    FakeOtaEnv env;
    env.stage_write_ok = false;
    env.stage_write_err = "disk full";

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 100};
    MIKOtaInstallOptions opts;

    std::string seen_name;
    auto download = [&seen_name](MIKOtaUpdate& update, MIKOtaError* out_err) {
        uint8_t bytes[10] = {};
        bool ok = update.write(bytes, 10, out_err);
        if (!ok && out_err) seen_name = out_err->name;
        return ok;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(!res);
    CHECK(seen_name == "StagingFull");
    // Folded into a DownloadFailed, message preserved: it is the only thing that
    // survives to explain the failure on serial.
    CHECK(err.name == "DownloadFailed");
    CHECK(err.message == "disk full");
}

TEST_CASE("applyOffer: exposes native resume offset and counts already-staged bytes") {
    FakeOtaEnv env;
    env.stage_begin_resume_offset = 500;

    MIKOtaOffer offer = {"https://updates.example.com/app-2.tgz", "abc123", 1000};
    MIKOtaInstallOptions opts;

    // The cap counts the resumed bytes, so a pump that range-fetches writes
    // exactly the remainder. One that refetched from 0 trips TooLarge here and
    // loses the partial it was meant to resume.
    size_t seen_offset = 0;
    std::string seen_name;
    auto download = [&](MIKOtaUpdate& update, MIKOtaError* out_err) {
        seen_offset = update.resume_offset();
        uint8_t within[500] = {};
        if (!update.write(within, 500, out_err)) return false;
        uint8_t past_the_end[1] = {};
        bool ok = update.write(past_the_end, 1, out_err);
        if (!ok && out_err) seen_name = out_err->name;
        return ok;
    };

    MIKOtaApplyOutcome outcome;
    MIKOtaError err;
    bool res = mik__ota_policy_apply_offer(env.env(), offer, download, opts, &outcome, &err);

    CHECK(seen_offset == 500);
    CHECK(!res);
    CHECK(seen_name == "TooLarge");
    CHECK(err.name == "DownloadFailed");
}

TEST_CASE("reconcile: maps native diagnostic to lastInstall") {
    FakeOtaEnv env;
    env.reconcile_outcome.reverted = true;
    snprintf(env.reconcile_outcome.installed, sizeof(env.reconcile_outcome.installed), "abc123");
    env.reconcile_outcome.has_diagnostic = true;
    MIKOtaDiagnostic& diagnostic = env.reconcile_outcome.diagnostic;
    snprintf(diagnostic.reason, sizeof(diagnostic.reason), "panic");
    snprintf(diagnostic.detail, sizeof(diagnostic.detail), "pin 200 invalid");

    MIKOtaReconcileOutcome outcome = mik__ota_policy_reconcile(env.env());

    CHECK(outcome.reverted);
    CHECK(std::string(outcome.installed) == "abc123");
    CHECK(outcome.has_diagnostic);
    CHECK(std::string(outcome.diagnostic.reason) == "panic");
    CHECK(std::string(outcome.diagnostic.detail) == "pin 200 invalid");
}

TEST_CASE("running: augments running with app version") {
    FakeOtaEnv env;
    snprintf(env.running_build.checksum, sizeof(env.running_build.checksum), "abc123");
    env.running_build.version[0] = '\0';
    env.app_version = "2.3.4";

    MIKOtaRunningBuild run = mik__ota_policy_running(env.env());
    CHECK(std::string(run.checksum) == "abc123");
    CHECK(std::string(run.version) == "2.3.4");
}

TEST_CASE("decline record: absent until set, and round-trips through the store") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());

    MIKOtaDeclineRecord loaded;
    CHECK(!store.GetDecline(&loaded));

    MIKOtaDeclineRecord record;
    snprintf(record.checksum, sizeof(record.checksum), "%s", std::string(64, 'a').c_str());
    snprintf(record.reason, sizeof(record.reason), "exhausted");
    snprintf(record.detail, sizeof(record.detail), "link dropped");
    store.SetDecline(record);

    REQUIRE(store.GetDecline(&loaded));
    CHECK(std::string(loaded.checksum) == std::string(64, 'a'));
    CHECK(std::string(loaded.reason) == "exhausted");
    CHECK(std::string(loaded.detail) == "link dropped");
}

TEST_CASE("decline record: recording again overwrites, and an empty detail clears the old one") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());

    MIKOtaDeclineRecord first;
    snprintf(first.checksum, sizeof(first.checksum), "%s", std::string(64, 'a').c_str());
    snprintf(first.reason, sizeof(first.reason), "download-failed");
    snprintf(first.detail, sizeof(first.detail), "link dropped");
    store.SetDecline(first);

    MIKOtaDeclineRecord second;
    snprintf(second.checksum, sizeof(second.checksum), "%s", std::string(64, 'b').c_str());
    snprintf(second.reason, sizeof(second.reason), "abandoned");
    store.SetDecline(second);

    MIKOtaDeclineRecord loaded;
    REQUIRE(store.GetDecline(&loaded));
    CHECK(std::string(loaded.checksum) == std::string(64, 'b'));
    CHECK(std::string(loaded.reason) == "abandoned");
    CHECK(loaded.detail[0] == '\0');
}

TEST_CASE("decline record: cleared once a completed check-in delivered it") {
    FakeOtaEnv env;
    MIKOtaStore store(env.env());

    MIKOtaDeclineRecord record;
    snprintf(record.checksum, sizeof(record.checksum), "%s", std::string(64, 'c').c_str());
    snprintf(record.reason, sizeof(record.reason), "exhausted");
    store.SetDecline(record);
    store.ClearDecline();

    MIKOtaDeclineRecord loaded;
    CHECK(!store.GetDecline(&loaded));
}

TEST_CASE("revert: reports a revert failure as InstallFailed") {
    FakeOtaEnv env;
    env.revert_ok = false;
    env.revert_err = "no previous build";

    MIKOtaError err;
    bool res = mik__ota_policy_revert(env.env(), &err);

    CHECK(!res);
    CHECK(err.name == "InstallFailed");
    CHECK(err.kind == "transient");
    CHECK(err.message == "no previous build");
}

}  // TEST_SUITE

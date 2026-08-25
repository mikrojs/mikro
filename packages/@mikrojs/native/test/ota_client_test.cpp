/* Ported from runtime/ota/__test__/client.test.ts, which is the specification
 * for this behaviour. Each TEST_CASE keeps the name of the `it(...)` it came
 * from so the two suites can be diffed by eye.
 *
 * Two vitest cases have no counterpart here and are covered where they belong
 * instead:
 *   - "logs a delivered document with secret payloads redacted": redaction
 *     walks a decoded value, which only the JS reader has. The C++ client logs
 *     the document's version and never its contents, so there is nothing to
 *     redact.
 *   - "runs the teardown after the round, even when the check crashes": there
 *     is no throw to contain across the C seam; the equivalent (a round that
 *     failed) is covered below. */

#include "doctest.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_client.h"
#include "ota_fake_env.h"

using namespace mikrojs;
using namespace mikrojs::test;

namespace {

const char* kOfferUrl = "https://reg.example/builds/app-2.tgz";
const char* kOfferChecksum = "abc123def456xyz";
constexpr int64_t kOfferSize = 1024;

CheckinResponse OfferResponse() {
    CheckinResponse response;
    response.has_offer = true;
    response.url = kOfferUrl;
    response.checksum = kOfferChecksum;
    response.size = kOfferSize;
    return response;
}

std::vector<uint8_t> Bytes(size_t n, uint8_t fill = 0) {
    return std::vector<uint8_t>(n, fill);
}

struct Harness {
    FakeOtaEnv env;
    MIKOtaClient client{env.env()};
    std::vector<MIKOtaCheckResult> results;

    MIKOtaCheckSink sink() {
        return [this](const MIKOtaCheckResult& result) { results.push_back(result); };
    }

    /* Drive the machine to a standstill: poll, deliver whatever the client
     * issued, poll again, until nothing is left in flight. */
    void Run() {
        for (int i = 0; i < 32; i++) {
            client.Poll();
            if (!env.Tick()) break;
        }
        client.Poll();
    }

    MIKOtaCheckResult CheckAndRun(const MIKOtaCheckOptions& options = {}) {
        client.Check(options, sink());
        Run();
        REQUIRE(results.size() == 1);
        return results.back();
    }

    const std::vector<uint8_t>& SentBody(size_t index = 0) { return env.request(index).body; }
};

}  // namespace

TEST_SUITE("ota: client") {

// ── the asynchronous contract ────────────────────────────────────────────────

TEST_CASE("check: settles from a later Poll, never from the request itself") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.client.Poll();
    // The request is out and nothing has come back: a client that read the
    // response straight after issuing it would already have a result here.
    CHECK(h.env.requests.size() == 1);
    CHECK(h.results.empty());
    CHECK(h.client.state() == MIKOtaClientState::kCheckIn);

    h.env.Tick();
    h.client.Poll();
    REQUIRE(h.results.size() == 1);
    CHECK(h.results[0].status == MIKOtaCheckStatus::kUpToDate);
    CHECK(h.client.state() == MIKOtaClientState::kIdle);
}

TEST_CASE("check: copes with a transport that reports its status only at the end") {
    Harness h;
    FakeExchange exchange;
    exchange.status = 200;
    exchange.chunks.push_back(CheckinResponse{}.Encode());
    exchange.skip_headers = true;
    h.env.scripted.push_back(exchange);
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
}

// ── check ────────────────────────────────────────────────────────────────────

TEST_CASE("check: posts the CBOR-encoded report and returns up-to-date on an empty answer") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == false);
    CHECK(h.env.request(0).url == "https://reg.example/api/v1/checkin");
    CHECK(h.env.request(0).method == "POST");
    CHECK(h.env.HeaderOf(0, "content-type") == "application/cbor");
    CHECK(h.env.HeaderOf(0, "accept") == "application/cbor");
    CHECK(h.env.HeaderOf(0, "authorization") == "Bearer duk_secret");

    const std::vector<uint8_t>& body = h.SentBody();
    CHECK(CborStr(body, "deviceId") == "dev-1");
    CHECK(CborStr(body, "firmware") == "0.16.0");
    CHECK(CborStr(body, "firmwareHash") == "fwhash");
    CHECK(CborInt(body, "bytecode") == 42);
    CHECK(CborStr(body, "running.checksum") == "oldsum");
    CHECK(CborStr(body, "running.version") == "1.0.0");
    CHECK(CborBool(body, "running.trial") == false);
    CHECK(CborInt(body, "name.0") == 1);
    CHECK(CborStr(body, "name.1") == "shed");
    CHECK(CborInt(body, "free") == 900000);
    CHECK(h.env.mark_valid_calls == 1);
}

TEST_CASE("check: omits free from the report when the platform cannot say") {
    Harness h;
    h.env.has_storage_free = false;
    h.env.ReplyWith(CheckinResponse{});
    h.CheckAndRun();
    CHECK(!CborHas(h.SentBody(), "free"));
}

TEST_CASE("check: sends the name pair as [rev] only when the device has no name") {
    Harness h;
    h.env.has_device_name = false;
    h.env.ReplyWith(CheckinResponse{});
    h.CheckAndRun();
    CHECK(CborInt(h.SentBody(), "name.0") == 0);
    CHECK(!CborHas(h.SentBody(), "name.1"));
}

TEST_CASE("check: adopts a name the registry sends down") {
    Harness h;
    CheckinResponse response;
    response.has_name = true;
    response.name_rev = 2;
    response.name = "kitchen";
    h.env.ReplyWith(response);
    h.CheckAndRun();
    REQUIRE(h.env.names_set.size() == 1);
    CHECK(h.env.names_set[0].first == 2);
    CHECK(h.env.names_set[0].second == "kitchen");
}

TEST_CASE("check: adopts a cleared name as [rev] only") {
    Harness h;
    CheckinResponse response;
    response.has_name = true;
    response.name_rev = 3;
    h.env.ReplyWith(response);
    h.CheckAndRun();
    REQUIRE(h.env.names_set.size() == 1);
    CHECK(h.env.names_set[0].first == 3);
    CHECK(h.env.names_set[0].second.empty());
}

TEST_CASE("check: treats a junk name pair as no change") {
    Harness h;
    CheckinResponse response;
    response.has_name = true;
    response.name_junk = true;
    h.env.ReplyWith(response);
    h.CheckAndRun();
    CHECK(h.env.names_set.empty());
}

TEST_CASE("check: confirms a running trial before applying the offer") {
    Harness h;
    h.env.running_build = {"oldsum", "1.0.0", true};
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(8)});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kStaged);
    // Confirmed before staging: the policy skips every offer while a trial is
    // unresolved, so a confirm that came later would defer the offer a round.
    CHECK(h.env.mark_valid_calls == 1);
    CHECK(h.env.stage_finish_calls == 1);
    CHECK(h.env.LoggedContaining("confirming this build as healthy"));
}

TEST_CASE("check: stages an offered build and returns the offer") {
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {{1, 2, 3}, {4, 5}});
    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.status == MIKOtaCheckStatus::kStaged);
    CHECK(result.offer.url == kOfferUrl);
    CHECK(result.offer.checksum == kOfferChecksum);
    CHECK(result.offer.size == kOfferSize);
    CHECK(h.env.stage_written_bytes == std::vector<uint8_t>{1, 2, 3, 4, 5});
    // require_confirm defaults on; trial_boots defaults to 1
    CHECK(h.env.last_stage_finish_require_confirm == true);
    CHECK(h.env.last_stage_finish_trial_boots == 1);
    CHECK(h.env.last_stage_finish_install_now == false);
}

TEST_CASE("check: reports a declined offer as not-staged with the policy reason") {
    Harness h;
    // Already running the offered build.
    h.env.SetRunning(kOfferChecksum, "1.0.0", false);
    h.env.ReplyWith(OfferResponse());
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kCurrent);
    CHECK(h.env.requests.size() == 1);  // no download was attempted
}

TEST_CASE("check: reports a failed download as not-staged with the error") {
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithFailure("link dropped");
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kDownloadFailed);
    CHECK(result.error.name == "DownloadFailed");
    CHECK(result.error.message.find("link dropped") != std::string::npos);
    CHECK(h.env.stage_abort_calls == 1);
}

TEST_CASE("check: reports a non-2xx download as not-staged") {
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWith(404, {});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kDownloadFailed);
    CHECK(result.error.message == "download returned status 404");
}

TEST_CASE("check: reports a corrupt install as not-staged and abandons the checksum") {
    Harness h;
    h.env.stage_finish_ok = false;
    h.env.stage_finish_err = "checksum mismatch";
    h.env.stage_finish_err_kind = MIK_OTA_ERR_CORRUPT;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(4)});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kInstallFailed);
    CHECK(result.error.kind == "corrupt");
    CHECK(MIKOtaStore(h.env.env()).GetBad() == kOfferChecksum);
}

TEST_CASE("check: treats a body cut short mid-transfer as a failed round") {
    Harness h;
    h.env.running_build = {"oldsum", "1.0.0", true};
    // 200 headers, then the connection dies part-way through the body.
    h.env.ReplyWithTruncated(200, {{0xa1, 0x63}}, "connection reset");
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.error.message == "connection reset");
    CHECK(h.env.mark_valid_calls == 0);
}

TEST_CASE("check: returns failed and does not confirm when the check-in never completes") {
    Harness h;
    h.env.running_build = {"oldsum", "1.0.0", true};
    h.env.ReplyWithFailure("deadline");
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.error.message == "deadline");
    CHECK(h.env.mark_valid_calls == 0);
}

TEST_CASE("check: returns unauthorized on a 401") {
    Harness h;
    h.env.running_build = {"oldsum", "1.0.0", true};
    h.env.ReplyWith(401, {});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kUnauthorized);
    CHECK(result.http_status == 401);
    CHECK(h.env.mark_valid_calls == 0);
    CHECK(h.env.LoggedContaining("re-enroll"));
}

TEST_CASE("check: fails loudly on a 415: the wire is CBOR-only") {
    Harness h;
    h.env.ReplyWith(415, {});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.http_status == 415);
    CHECK(h.env.LoggedContaining("does not accept CBOR"));
}

TEST_CASE("check: fails on any other non-2xx status") {
    Harness h;
    h.env.ReplyWith(500, {});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.http_status == 500);
    CHECK(result.error.name == "Status");
}

TEST_CASE("check: fails on an undecodable response body") {
    Harness h;
    // A well-formed CBOR text string: decodable, but not the map a response is.
    h.env.ReplyWith(200, {0x63, 'a', 'b', 'c'});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.error.name == "DecodeFailed");
    // CheckError declares a message on every arm; an empty one is a lie the
    // types cannot catch.
    CHECK(!result.error.message.empty());
}

TEST_CASE("check: fails on a response body past the size cap") {
    Harness h;
    h.env.ReplyWith(200, Bytes(MIK__OTA_MAX_RESPONSE_BYTES + 1, 0x20));
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kFailed);
    CHECK(result.error.name == "TooLarge");
    CHECK(!result.error.message.empty());
}

TEST_CASE("check: returns not-enrolled without touching the network") {
    Harness h;
    h.env.kv_strings.erase("ota.registry");
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotEnrolled);
    CHECK(h.env.requests.empty());
}

TEST_CASE("check: returns not-enrolled when the update key is missing") {
    Harness h;
    h.env.kv_strings.erase("ota.updateKey");
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kNotEnrolled);
    CHECK(h.env.requests.empty());
}

TEST_CASE("check: reconciles once per boot and holds lastInstall until a check-in completes") {
    Harness h;
    h.env.reconcile_outcome = {"", false, true, {"ota_install_failed", "corrupt"}};
    h.env.ReplyWithFailure("down");
    h.env.ReplyWith(CheckinResponse{});
    h.env.ReplyWith(CheckinResponse{});

    h.client.Check({}, h.sink());
    h.Run();
    h.client.Check({}, h.sink());
    h.Run();
    h.client.Check({}, h.sink());
    h.Run();

    REQUIRE(h.results.size() == 3);
    CHECK(h.env.reconcile_calls == 1);
    // Held through the failed round, delivered by the first that completed,
    // gone by the next.
    CHECK(CborStr(h.SentBody(0), "lastInstall.reason") == "ota_install_failed");
    CHECK(CborStr(h.SentBody(0), "lastInstall.detail") == "corrupt");
    CHECK(CborStr(h.SentBody(1), "lastInstall.reason") == "ota_install_failed");
    CHECK(!CborHas(h.SentBody(2), "lastInstall"));
}

TEST_CASE("check: serializes overlapping checks") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.env.ReplyWith(CheckinResponse{});

    h.client.Check({}, h.sink());
    h.client.Check({}, h.sink());
    h.client.Poll();
    // Staging is a single native session, so the second round waits: only one
    // request may ever be in flight.
    CHECK(h.env.requests.size() == 1);
    CHECK(h.results.empty());

    h.Run();
    CHECK(h.env.requests.size() == 2);
    REQUIRE(h.results.size() == 2);
    CHECK(h.results[0].status == MIKOtaCheckStatus::kUpToDate);
    CHECK(h.results[1].status == MIKOtaCheckStatus::kUpToDate);
}

TEST_CASE("check: warns once per boot when the registry is private http") {
    Harness h;
    h.env.kv_strings["ota.registry"] = "http://192.168.1.10:4873";
    h.env.ReplyWith(CheckinResponse{});
    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(h.env.CountLoggedContaining("NOT authenticated") == 1);
}

TEST_CASE("check: accepts an http offer from a private-http registry") {
    Harness h;
    h.env.kv_strings["ota.registry"] = "http://192.168.1.10:4873";
    CheckinResponse response = OfferResponse();
    response.url = "http://192.168.1.10:4873/builds/app-2.tgz";
    h.env.ReplyWith(response);
    h.env.ReplyWithChunks(200, {Bytes(4)});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
}

TEST_CASE("check: warns and ignores an offer whose url is unusable") {
    Harness h;
    CheckinResponse response = OfferResponse();
    response.url = "http://cdn.example/builds/app-2.tgz";  // http, public registry
    h.env.ReplyWith(response);
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(h.env.LoggedContaining("ignoring offer"));
}

TEST_CASE("check: stays quiet when the response carries no url at all") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
    CHECK(!h.env.LoggedContaining("ignoring offer"));
}

// ── reporting a declined offer ──────────────────────────────────────────────

TEST_CASE("check: tells the registry when the retry budget is spent") {
    // The device stops trying after three failed downloads and its running
    // checksum never changes, so without this the registry waits forever for an
    // install that is not coming.
    Harness h;
    for (int attempt = 0; attempt < 3; attempt++) {
        h.env.ReplyWith(OfferResponse());
        h.env.ReplyWithFailure("link dropped");
        h.client.Check({}, h.sink());
        h.Run();
    }
    CHECK(MIKOtaStore(h.env.env()).GetTries() == 3);

    // The fourth round is where the budget bites, and the round after it is the
    // first that can carry the news.
    h.env.ReplyWith(OfferResponse());
    h.client.Check({}, h.sink());
    h.Run();
    REQUIRE(h.results.size() == 4);
    CHECK(h.results[3].decline_reason == MIKOtaDeclineReason::kExhausted);

    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    const std::vector<uint8_t>& body = h.env.request(h.env.requests.size() - 1).body;
    CHECK(CborStr(body, "lastDecline.reason") == "exhausted");
    CHECK(CborStr(body, "lastDecline.checksum") == kOfferChecksum);
}

TEST_CASE("check: reports a failed download, with the reason it failed") {
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithFailure("link dropped");
    h.client.Check({}, h.sink());
    h.Run();

    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    const std::vector<uint8_t>& body = h.SentBody(2);
    CHECK(CborStr(body, "lastDecline.reason") == "download-failed");
    CHECK(CborStr(body, "lastDecline.checksum") == kOfferChecksum);
    CHECK(CborStr(body, "lastDecline.detail").find("link dropped") != std::string::npos);
}

TEST_CASE("check: reports an abandoned build, which no reboot will retry") {
    Harness h;
    h.env.stage_finish_ok = false;
    h.env.stage_finish_err = "checksum mismatch";
    h.env.stage_finish_err_kind = MIK_OTA_ERR_CORRUPT;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(4)});
    h.client.Check({}, h.sink());
    h.Run();

    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(CborStr(h.SentBody(2), "lastDecline.reason") == "install-failed");

    // Reported once, then delivered: the next round has nothing to add.
    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(!CborHas(h.SentBody(3), "lastDecline"));
}

TEST_CASE("check: stays quiet about declines that are the policy working") {
    // Already running the offered build is not a failure to report.
    Harness h;
    h.env.SetRunning(kOfferChecksum, "1.0.0", false);
    h.env.ReplyWith(OfferResponse());
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(h.results[0].decline_reason == MIKOtaDeclineReason::kCurrent);

    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(!CborHas(h.SentBody(1), "lastDecline"));
}

// ── check: download ──────────────────────────────────────────────────────────

TEST_CASE("download: resumes with a Range request and writes only the new bytes on 206") {
    Harness h;
    h.env.stage_begin_resume_offset = 512;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(206, {{9, 9}});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
    CHECK(h.env.HeaderOf(1, "range") == "bytes=512-");
    CHECK(h.env.stage_written_bytes == std::vector<uint8_t>{9, 9});
}

TEST_CASE("download: skips the already-staged prefix when a resume is answered with a 200") {
    Harness h;
    h.env.stage_begin_resume_offset = 512;
    std::vector<uint8_t> full(1024);
    for (size_t i = 0; i < full.size(); i++) full[i] = static_cast<uint8_t>(i % 256);
    h.env.ReplyWith(OfferResponse());
    // A chunk boundary inside the prefix, so the skip has to span chunks.
    h.env.ReplyWithChunks(200, {std::vector<uint8_t>(full.begin(), full.begin() + 100),
                                std::vector<uint8_t>(full.begin() + 100, full.end())});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
    CHECK(h.env.stage_written_bytes ==
          std::vector<uint8_t>(full.begin() + 512, full.end()));
}

TEST_CASE("download: cancels the transfer once staging can no longer be written") {
    // Nothing more can go to flash, so the rest of the body is a whole firmware
    // image pulled over TLS to be thrown away. Left running it holds the task
    // and the TLS session until the server ends the body, and the watcher never
    // reaches another round.
    Harness h;
    h.env.stage_write_ok = false;
    h.env.stage_write_err = "no space left on device";
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithStall(200, {{1, 2, 3}, {4, 5, 6}});

    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(h.env.cancelled.size() == 1);
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.error.message == "no space left on device");
}

TEST_CASE("download: re-verifies without a request when the staged bytes are already complete") {
    Harness h;
    h.env.stage_begin_resume_offset = kOfferSize;
    h.env.ReplyWith(OfferResponse());
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
    CHECK(h.env.requests.size() == 1);  // the check-in only
    CHECK(h.env.stage_finish_calls == 1);
}

TEST_CASE("download: sends the update key only to the registry origin") {
    Harness same;
    same.env.ReplyWith(OfferResponse());
    same.env.ReplyWithChunks(200, {Bytes(1)});
    same.CheckAndRun();
    CHECK(same.env.HeaderOf(1, "authorization") == "Bearer duk_secret");

    Harness cdn;
    CheckinResponse response = OfferResponse();
    response.url = "https://cdn.example/builds/app-2.tgz";
    cdn.env.ReplyWith(response);
    cdn.env.ReplyWithChunks(200, {Bytes(1)});
    cdn.CheckAndRun();
    CHECK(cdn.env.HeaderOf(1, "authorization").empty());
}

TEST_CASE("download: treats a transfer cut short after a 200 as a failed download") {
    // The bytes on flash are short, so finish() would fail its checksum and the
    // policy would abandon the build as corrupt — permanently, since nothing
    // clears `bad`. A dropped connection must not cost a good build.
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithTruncated(200, {Bytes(16)}, "connection reset");
    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kDownloadFailed);
    CHECK(result.error.message.find("connection reset") != std::string::npos);
    CHECK(h.env.stage_finish_calls == 0);
    CHECK(h.env.stage_abort_calls == 1);
    CHECK(MIKOtaStore(h.env.env()).GetBad().empty());
}

TEST_CASE("download: reports a staging write failure as a failed download") {
    Harness h;
    h.env.stage_write_ok = false;
    h.env.stage_write_err = "no space";
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(4)});
    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kNotStaged);
    CHECK(result.decline_reason == MIKOtaDeclineReason::kDownloadFailed);
    CHECK(result.error.message == "no space");
    // Transient: the checksum stays retryable.
    CHECK(MIKOtaStore(h.env.env()).GetBad().empty());
}

TEST_CASE("download: carries the caller's timeouts onto both requests") {
    Harness h;
    MIKOtaCheckOptions options;
    options.checkin_timeout_ms = 1234;
    options.download_timeout_ms = 5678;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(2)});
    h.CheckAndRun(options);
    CHECK(h.env.request(0).timeout_ms == 1234);
    CHECK(h.env.request(1).timeout_ms == 5678);
}

// ── watch ────────────────────────────────────────────────────────────────────

namespace {

/* Advance the virtual clock onto the pending deadline and run the round. */
void RunScheduledRound(Harness& h) {
    REQUIRE(h.client.scheduled_delay_ms() >= 0);
    h.env.now_ms += h.client.scheduled_delay_ms();
    h.Run();
}

MIKOtaWatchOptions FastWatch() {
    MIKOtaWatchOptions options;
    options.initial_delay_ms = 0;
    return options;
}

}  // namespace

TEST_CASE("watch: is inert on an un-enrolled device") {
    Harness h;
    h.env.kv_strings.erase("ota.registry");
    h.client.Watch(FastWatch());
    h.Run();
    CHECK(!h.client.watching());
    CHECK(h.client.scheduled_delay_ms() == -1);
    CHECK(h.env.requests.empty());
    CHECK(h.env.LoggedContaining("not enrolled"));
}

TEST_CASE("watch: waits the full interval after a clean round") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch({});
    // Initial delay of 5s, jitter pinned to 1.0 by random_fraction 0.5.
    CHECK(h.client.scheduled_delay_ms() == 5000);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 30 * 60000);
}

TEST_CASE("watch: floors the check-in interval at 30s, whatever the caller asks for") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 5000;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 30000);
}

TEST_CASE("watch: retries sooner after a failed round") {
    Harness h;
    h.env.ReplyWithFailure("down");
    h.client.Watch(FastWatch());
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 60000);
}

TEST_CASE("watch: backs off to the full interval on a dead update key") {
    Harness h;
    h.env.ReplyWith(401, {});
    h.client.Watch(FastWatch());
    RunScheduledRound(h);
    // Not the retry interval: a dead key must not hammer the registry forever.
    CHECK(h.client.scheduled_delay_ms() == 30 * 60000);
}

TEST_CASE("check: a CBOR-null response is a completed quiet round") {
    // The reference registry answers a nothing-new check-in with CBOR null
    // (and third-party registries may send an empty body). Failing the decode
    // put every quiet round on the retry cadence, so the configured interval
    // never applied on a device with nothing to update.
    Harness h;
    h.env.ReplyWith(200, {0xf6});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
}

TEST_CASE("check: an empty response body is a completed quiet round") {
    Harness h;
    h.env.ReplyWith(200, {});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
}

TEST_CASE("watch: a quiet null response schedules the interval, not the retry") {
    Harness h;
    h.env.ReplyWith(200, {0xf6});
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 600000;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 600000);
}

TEST_CASE("watch: caps the retry interval at the check-in interval") {
    Harness h;
    h.env.ReplyWithFailure("down");
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 30000;
    options.retry_after_failure_ms = 600000;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 30000);
}

TEST_CASE("watch: jitters every scheduled delay by ±10%") {
    Harness low;
    low.env.random_fraction = 0.0;
    MIKOtaWatchOptions options;
    options.initial_delay_ms = 10000;
    low.client.Watch(options);
    CHECK(low.client.scheduled_delay_ms() == 9000);

    Harness high;
    high.env.random_fraction = 1.0;
    high.client.Watch(options);
    CHECK(high.client.scheduled_delay_ms() == 11000);
}

TEST_CASE("watch: uses the exact interval with jitter off") {
    Harness h;
    h.env.random_fraction = 1.0;
    h.env.ReplyWith(CheckinResponse{});
    MIKOtaWatchOptions options;
    options.initial_delay_ms = 10000;
    options.jitter = false;
    h.client.Watch(options);
    CHECK(h.client.scheduled_delay_ms() == 10000);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 30 * 60000);
}

TEST_CASE("watch: skips the round and retries sooner when beforeCheck fails") {
    Harness h;
    FakeRoundHooks hooks;
    hooks.before_check_fails = true;
    MIKOtaWatchOptions options = FastWatch();
    options.hooks = &hooks;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.env.requests.empty());
    CHECK(h.client.scheduled_delay_ms() == 60000);
    CHECK(h.env.LoggedContaining("beforeCheck failed"));
    // No teardown: unwinding a partial setup is the hook's own job.
    CHECK(hooks.order == std::vector<std::string>{"before"});
}

TEST_CASE("watch: runs the teardown after the round, even when the check failed") {
    Harness h;
    FakeRoundHooks hooks;
    h.env.ReplyWithFailure("boom");
    MIKOtaWatchOptions options = FastWatch();
    options.hooks = &hooks;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(hooks.order == std::vector<std::string>{"before", "teardown"});
    // The loop survived: the next round is scheduled at the retry interval.
    CHECK(h.client.scheduled_delay_ms() == 60000);
}

TEST_CASE("watch: waits for an asynchronous beforeCheck before checking in") {
    Harness h;
    FakeRoundHooks hooks;
    hooks.before_check_pending_polls = 2;
    h.env.ReplyWith(CheckinResponse{});
    MIKOtaWatchOptions options = FastWatch();
    options.hooks = &hooks;
    h.client.Watch(options);
    h.client.Poll();
    CHECK(h.client.state() == MIKOtaClientState::kBeforeCheck);
    CHECK(h.env.requests.empty());
    h.Run();
    CHECK(h.env.requests.size() == 1);
}

TEST_CASE("watch: restarts after staging, with the teardown run first") {
    Harness h;
    FakeRoundHooks hooks;
    // Hold the teardown open one poll, so the restart cannot slip in front.
    hooks.teardown_pending_polls = 1;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(2)});
    MIKOtaWatchOptions options = FastWatch();
    options.hooks = &hooks;
    h.client.Watch(options);

    for (int i = 0; i < 32 && h.client.state() != MIKOtaClientState::kTeardown; i++) {
        h.client.Poll();
        h.env.Tick();
    }
    REQUIRE(h.client.state() == MIKOtaClientState::kTeardown);
    CHECK(h.env.restart_calls == 0);

    h.client.Poll();
    CHECK(hooks.order == std::vector<std::string>{"before", "teardown"});
    CHECK(h.env.restart_calls == 1);
}

TEST_CASE("watch: reports each round to the caller as it settles") {
    // A watch loop is otherwise silent, so an app cannot tell that a round
    // delivered new config without polling for it.
    Harness h;
    std::vector<MIKOtaCheckResult> rounds;
    MIKOtaWatchOptions options = FastWatch();
    options.on_round = [&rounds](const MIKOtaCheckResult& result) { rounds.push_back(result); };

    CheckinResponse delivered;
    delivered.has_config = true;
    delivered.config_rev = "r2";
    delivered.config_doc = DocInterval(45);
    h.env.ReplyWith(delivered);
    h.client.Watch(options);
    RunScheduledRound(h);

    REQUIRE(rounds.size() == 1);
    CHECK(rounds[0].status == MIKOtaCheckStatus::kUpToDate);
    CHECK(rounds[0].config_updated == true);

    // A round that changes nothing still reports, saying so.
    h.env.ReplyWith(CheckinResponse{});
    RunScheduledRound(h);
    REQUIRE(rounds.size() == 2);
    CHECK(rounds[1].config_updated == false);
}

TEST_CASE("watch: reports a staged round before restarting on it") {
    // The restart is what ends the round, so a report afterwards would never
    // arrive.
    Harness h;
    std::vector<MIKOtaCheckStatus> seen;
    MIKOtaWatchOptions options = FastWatch();
    options.on_round = [&seen, &h](const MIKOtaCheckResult& result) {
        seen.push_back(result.status);
        CHECK(h.env.restart_calls == 0);
    };
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(2)});
    h.client.Watch(options);
    RunScheduledRound(h);

    REQUIRE(seen.size() == 1);
    CHECK(seen[0] == MIKOtaCheckStatus::kStaged);
    CHECK(h.env.restart_calls == 1);
}

TEST_CASE("watch: defers the restart when stop() was called during the round") {
    Harness h;
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(2)});
    h.client.Watch(FastWatch());
    h.client.Poll();
    REQUIRE(h.env.requests.size() == 1);

    h.client.StopWatch();
    h.Run();

    // The in-flight round still staged the build; it just stays armed for the
    // next natural reboot instead of restarting under the app.
    CHECK(h.env.stage_finish_calls == 1);
    CHECK(h.env.restart_calls == 0);
    CHECK(h.env.LoggedContaining("restart deferred"));
}

TEST_CASE("watch: the interval is measured from the end of a round, not its start") {
    // A round that takes two minutes does not eat two minutes of the next
    // interval: the cadence is end-of-round to start-of-next, so a slow
    // download cannot turn a 60s cadence into a back-to-back loop.
    Harness h;
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 60000;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch(options);

    h.client.Poll();
    REQUIRE(h.env.requests.size() == 1);
    h.env.now_ms += 120000;  // the round itself takes two minutes
    h.Run();
    CHECK(h.client.scheduled_delay_ms() == 60000);

    // Due 60s after the round ended, so nothing fires until then.
    h.env.ReplyWith(CheckinResponse{});
    h.env.now_ms += 59000;
    h.client.Poll();
    CHECK(h.env.requests.size() == 1);
    h.env.now_ms += 1000;
    h.Run();
    CHECK(h.env.requests.size() == 2);
}

TEST_CASE("watch: a new cadence brings a pending wait forward") {
    // The case this exists for: a check-in delivers a shorter interval, and the
    // device should not sit out the old one first.
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch(FastWatch());
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 30 * 60000);

    h.client.SetCheckinInterval(60000);
    CHECK(h.client.scheduled_delay_ms() == 60000);

    // And it is due 60s after the wait began, not 60s from now.
    h.env.now_ms += 59000;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Poll();
    CHECK(h.env.requests.size() == 1);
    h.env.now_ms += 1000;
    h.Run();
    CHECK(h.env.requests.size() == 2);
}

TEST_CASE("watch: a longer cadence pushes the pending wait back") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 60000;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 60000);

    h.client.SetCheckinInterval(600000);
    CHECK(h.client.scheduled_delay_ms() == 600000);
}

TEST_CASE("watch: a new cadence is floored like the original") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch(FastWatch());
    RunScheduledRound(h);
    h.client.SetCheckinInterval(5000);
    CHECK(h.client.scheduled_delay_ms() == 30000);
}

TEST_CASE("watch: a cadence below the retry interval pulls that down too") {
    // retryAfterFailureMs is capped at the check-in interval, so a cadence drop
    // must not leave a retry waiting longer than a clean round would.
    Harness h;
    h.env.ReplyWithFailure("down");
    MIKOtaWatchOptions options = FastWatch();
    options.checkin_interval_ms = 600000;
    options.retry_after_failure_ms = 300000;
    h.client.Watch(options);
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 300000);

    h.client.SetCheckinInterval(30000);
    CHECK(h.client.scheduled_delay_ms() == 30000);
}

TEST_CASE("watch: a new cadence leaves the initial delay alone") {
    // The initial delay is not the interval, and an app that sets both means
    // both.
    Harness h;
    MIKOtaWatchOptions options;
    options.initial_delay_ms = 10000;
    h.client.Watch(options);
    CHECK(h.client.scheduled_delay_ms() == 10000);
    h.client.SetCheckinInterval(60000);
    CHECK(h.client.scheduled_delay_ms() == 10000);

    // It takes effect at the first round that schedules on the interval.
    h.env.ReplyWith(CheckinResponse{});
    RunScheduledRound(h);
    CHECK(h.client.scheduled_delay_ms() == 60000);
}

TEST_CASE("watch: setting the cadence during a round takes effect after it") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch(FastWatch());
    h.client.Poll();
    REQUIRE(h.env.requests.size() == 1);

    h.client.SetCheckinInterval(45000);
    h.Run();
    CHECK(h.client.scheduled_delay_ms() == 45000);
}

TEST_CASE("watch: setting the cadence on a stopped watcher does nothing") {
    Harness h;
    h.client.Watch(FastWatch());
    h.client.StopWatch();
    h.client.SetCheckinInterval(60000);
    CHECK(h.client.scheduled_delay_ms() == -1);
    h.Run();
    CHECK(h.env.requests.empty());
}

TEST_CASE("watch: stop() cancels the pending round") {
    Harness h;
    h.client.Watch(FastWatch());
    h.client.StopWatch();
    h.Run();
    CHECK(h.env.requests.empty());
    CHECK(h.client.scheduled_delay_ms() == -1);
    CHECK(!h.client.watching());
}

TEST_CASE("watch: a check issued mid-round waits for the watch round") {
    Harness h;
    h.env.ReplyWith(CheckinResponse{});
    h.env.ReplyWith(CheckinResponse{});
    h.client.Watch(FastWatch());
    h.client.Poll();
    REQUIRE(h.env.requests.size() == 1);

    h.client.Check({}, h.sink());
    h.client.Poll();
    CHECK(h.env.requests.size() == 1);  // still the watch round's

    h.Run();
    CHECK(h.env.requests.size() == 2);
    REQUIRE(h.results.size() == 1);
    CHECK(h.results[0].status == MIKOtaCheckStatus::kUpToDate);
}

// ── config sync ──────────────────────────────────────────────────────────────

namespace {

/* The held document the config tests start from. */
void SeedHeld(Harness& h, const char* key = "ota.cfg") {
    h.env.SeedConfig(key, "r1", "1.0.0", DocInterval(30));
}

std::vector<uint8_t> HeldBytes() {
    FakeOtaEnv scratch;
    scratch.SeedConfig("x", "r1", "1.0.0", DocInterval(30));
    return scratch.Blob("x");
}

CheckinResponse ConfigResponse(const std::string& rev, const std::vector<uint8_t>& doc) {
    CheckinResponse response;
    response.has_config = true;
    response.config_rev = rev;
    response.config_version = "1.0.0";
    response.config_doc = doc;
    return response;
}

}  // namespace

TEST_CASE("config: reports the held token, omitted when nothing is held") {
    Harness held;
    SeedHeld(held);
    held.env.ReplyWith(CheckinResponse{});
    held.CheckAndRun();
    CHECK(CborStr(held.SentBody(), "configRev") == "r1");

    Harness bare;
    bare.env.ReplyWith(CheckinResponse{});
    bare.CheckAndRun();
    CHECK(!CborHas(bare.SentBody(), "configRev"));
}

TEST_CASE("config: stores a delivered document on trial, previous kept as the baseline") {
    Harness h;
    SeedHeld(h);
    h.env.ReplyWith(ConfigResponse("r2", DocInterval(45)));
    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == true);
    std::vector<uint8_t> current = h.env.Blob("ota.cfg");
    CHECK(CborStr(current, "rev") == "r2");
    CHECK(CborStr(current, "version") == "1.0.0");
    CHECK(CborRaw(current, "doc") == DocInterval(45));
    // On trial until a check-in completes AFTER the app has run with it: a
    // schema-valid value can still be fatal, and the crash it causes can fire
    // before any check-in runs.
    CHECK(h.env.Blob("ota.cfgPrev") == HeldBytes());
    std::vector<uint8_t> trial = h.env.Blob("ota.cfgTrial");
    CHECK(CborInt(trial, "left") == 1);
    CHECK(CborBool(trial, "read") == false);
}

TEST_CASE("config: a redelivered document that has not changed is not a change") {
    // A registry that sends the config every round rather than only when the
    // echoed rev differs would otherwise re-write NVS, re-arm the trial and
    // report a change on every single round — flash wear on a 60s cadence, and
    // an onConfig that fires forever.
    Harness h;
    SeedHeld(h);  // rev r1, version 1.0.0, {interval: 30}
    // Not yet read by the app, so a completed check-in does not adopt it and the
    // trial is still there to be disturbed.
    h.env.SeedConfigTrial(1, false);
    CheckinResponse same = ConfigResponse("r1", DocInterval(30));
    h.env.ReplyWith(same);

    std::vector<uint8_t> before = h.env.Blob("ota.cfg");
    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == false);
    CHECK(h.env.Blob("ota.cfg") == before);
    // The trial it was already on is untouched, not restarted.
    std::vector<uint8_t> trial = h.env.Blob("ota.cfgTrial");
    CHECK(CborInt(trial, "left") == 1);
    CHECK(CborBool(trial, "read") == false);
    // And nothing was pushed into the rollback baseline.
    CHECK(!h.env.HasBlob("ota.cfgPrev"));
}

TEST_CASE("config: stores a full-length registry rev intact") {
    // The registry rev is a sha256 hex digest: 64 characters. A device that
    // keeps 63 echoes a rev that never equals the current one, so the registry
    // re-sends the document every round, and after a rollback it re-sends the
    // document that just failed.
    Harness h;
    SeedHeld(h);
    const std::string rev(64, 'a');
    h.env.ReplyWith(ConfigResponse(rev, DocInterval(45)));

    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(CborStr(h.env.Blob("ota.cfg"), "rev") == rev);
    // And it survives the round trip back out to the registry.
    h.env.ReplyWith(CheckinResponse{});
    h.client.Check({}, h.sink());
    h.Run();
    CHECK(CborStr(h.SentBody(1), "configRev") == rev);
}

TEST_CASE("config: a trial that cannot be read is not adopted") {
    // A completed check-in adopts the running document only once the app has
    // read it. A read that fails is not proof it was read — and it fails
    // exactly under the post-handshake heap pressure a check-in creates. Taking
    // it as "no trial" adopts a document the app never saw, so the crash it
    // causes has nothing left to roll back to.
    Harness h;
    SeedHeld(h);
    h.env.SeedConfigTrial(1, false);
    SeedHeld(h, "ota.cfgPrev");
    h.env.fail_blob_keys.insert("ota.cfgTrial");
    h.env.ReplyWith(CheckinResponse{});

    h.CheckAndRun();

    CHECK(h.env.HasBlob("ota.cfgTrial"));
    CHECK(h.env.Blob("ota.cfgPrev") == HeldBytes());
}

TEST_CASE("config: a current slot that cannot be read defers the delivery") {
    // Without knowing the document being replaced there is no rollback baseline
    // to write, and clearing the baseline would leave a bad document with
    // nowhere to fall back to. The registry re-sends next round.
    Harness h;
    SeedHeld(h);  // rev r1
    SeedHeld(h, "ota.cfgPrev");
    // Still on trial, so the completed check-in does not retire the baseline
    // for its own reasons and the claim below is about the failed read alone.
    h.env.SeedConfigTrial(1, false);
    h.env.fail_blob_keys.insert("ota.cfg");
    h.env.ReplyWith(ConfigResponse("r2", DocInterval(45)));

    MIKOtaCheckResult result = h.CheckAndRun();

    CHECK(result.config_updated == false);
    CHECK(h.env.Blob("ota.cfgPrev") == HeldBytes());
}

TEST_CASE("config: the same document under a new rev is a change") {
    // The rev is what the device echoes, so the registry needs the new one back
    // to stop re-sending it.
    Harness h;
    SeedHeld(h);
    h.env.ReplyWith(ConfigResponse("r2", DocInterval(30)));
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(CborStr(h.env.Blob("ota.cfg"), "rev") == "r2");
}

TEST_CASE("config: a changed document under the same rev is still a change") {
    Harness h;
    SeedHeld(h);
    h.env.ReplyWith(ConfigResponse("r1", DocInterval(45)));
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(CborRaw(h.env.Blob("ota.cfg"), "doc") == DocInterval(45));
}

TEST_CASE("config: honours the caller's trialBoots for a delivered document") {
    Harness h;
    MIKOtaCheckOptions options;
    options.trial_boots = 3;
    h.env.ReplyWith(ConfigResponse("r2", DocInterval(45)));
    h.CheckAndRun(options);
    CHECK(CborInt(h.env.Blob("ota.cfgTrial"), "left") == 3);
}

TEST_CASE("config: adopts the trial at the next completed check-in") {
    Harness h;
    h.env.SeedConfig("ota.cfg", "r2", "1.0.0", DocInterval(45));
    SeedHeld(h, "ota.cfgPrev");
    h.env.SeedConfigTrial(1, true);
    h.env.ReplyWith(CheckinResponse{});

    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == false);
    CHECK(!h.env.HasBlob("ota.cfgTrial"));
    CHECK(!h.env.HasBlob("ota.cfgPrev"));
    CHECK(CborStr(h.env.Blob("ota.cfg"), "rev") == "r2");
}

TEST_CASE("config: does not adopt a trial the app has not read") {
    // A check-in that completes before the app ever READ the new document
    // proves nothing about it: adoption waits.
    Harness h;
    h.env.SeedConfig("ota.cfg", "r2", "1.0.0", DocInterval(45));
    SeedHeld(h, "ota.cfgPrev");
    h.env.SeedConfigTrial(1, false);
    h.env.ReplyWith(CheckinResponse{});

    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
    std::vector<uint8_t> trial = h.env.Blob("ota.cfgTrial");
    CHECK(CborInt(trial, "left") == 1);
    CHECK(CborBool(trial, "read") == false);
    CHECK(h.env.Blob("ota.cfgPrev") == HeldBytes());
}

TEST_CASE("config: echoes the failed rev and the report after a rollback") {
    // Echoed-equals-expected keeps the registry from re-serving the document
    // that just failed, until an operator changes the config.
    Harness h;
    SeedHeld(h);
    h.env.SeedConfigError("r-bad", "rolled back: no completed check-in");
    h.env.ReplyWith(CheckinResponse{});
    h.CheckAndRun();
    CHECK(CborStr(h.SentBody(), "configRev") == "r-bad");
    CHECK(CborStr(h.SentBody(), "configError.rev") == "r-bad");
    CHECK(CborStr(h.SentBody(), "configError.message") == "rolled back: no completed check-in");

    // A fresh delivery (the operator changed the config) clears the report and
    // goes on its own trial.
    Harness fixed;
    SeedHeld(fixed);
    fixed.env.SeedConfigError("r-bad", "rolled back");
    fixed.env.ReplyWith(ConfigResponse("r-fixed", DocInterval(30)));
    CHECK(fixed.CheckAndRun().config_updated == true);
    CHECK(!fixed.env.HasBlob("ota.cfgErr"));
    CHECK(CborInt(fixed.env.Blob("ota.cfgTrial"), "left") == 1);
}

TEST_CASE("config: a clear settles any trial and rollback report") {
    Harness h;
    SeedHeld(h);
    SeedHeld(h, "ota.cfgPrev");
    h.env.SeedConfigTrial(1, false);
    h.env.SeedConfigError("r-bad", "rolled back");
    CheckinResponse response;
    response.has_config = true;  // version only: the clear shape
    h.env.ReplyWith(response);

    MIKOtaCheckResult result = h.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == true);
    CHECK(!h.env.HasBlob("ota.cfg"));
    CHECK(!h.env.HasBlob("ota.cfgPrev"));
    CHECK(!h.env.HasBlob("ota.cfgTrial"));
    CHECK(!h.env.HasBlob("ota.cfgErr"));
}

TEST_CASE("config: clears the held document on a clear shape, quietly when nothing is held") {
    CheckinResponse clear;
    clear.has_config = true;

    Harness h;
    SeedHeld(h);
    h.env.ReplyWith(clear);
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(!h.env.HasBlob("ota.cfg"));

    Harness noop;
    noop.env.ReplyWith(clear);
    MIKOtaCheckResult result = noop.CheckAndRun();
    CHECK(result.status == MIKOtaCheckStatus::kUpToDate);
    CHECK(result.config_updated == false);
}

TEST_CASE("config: treats a null doc as the clear") {
    Harness h;
    SeedHeld(h);
    CheckinResponse response;
    response.has_config = true;
    response.config_doc_null = true;
    h.env.ReplyWith(response);
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(!h.env.HasBlob("ota.cfg"));
}

TEST_CASE("config: treats an absent doc as the clear even when a rev rides along") {
    Harness h;
    SeedHeld(h);
    CheckinResponse response;
    response.has_config = true;
    response.config_rev = "r7";
    h.env.ReplyWith(response);
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(!h.env.HasBlob("ota.cfg"));
}

TEST_CASE("config: warns on a config field it cannot read, silent when there is none") {
    // Malformed must not read as absent: a registry speaking a different config
    // dialect would otherwise look exactly like one sending none.
    Harness h;
    CheckinResponse response;
    response.has_config = true;
    response.config_omit_version = true;
    response.config_doc = DocInterval(5);
    h.env.ReplyWith(response);
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kUpToDate);
    CHECK(!h.env.HasBlob("ota.cfg"));
    CHECK(h.env.LoggedContaining("could not read"));

    Harness none;
    none.env.ReplyWith(CheckinResponse{});
    none.CheckAndRun();
    CHECK(!none.env.LoggedContaining("could not read"));
}

TEST_CASE("config: stages the offered release config in the next slot, current untouched") {
    Harness h;
    SeedHeld(h);
    CheckinResponse response = OfferResponse();
    response.has_config = true;
    response.config_rev = "r9";
    response.config_version = "2.0.0";
    response.config_doc = DocInterval(5);
    h.env.ReplyWith(response);
    h.env.ReplyWithChunks(200, {Bytes(3)});

    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
    std::vector<uint8_t> next = h.env.Blob("ota.cfgNext");
    CHECK(CborStr(next, "rev") == "r9");
    CHECK(CborStr(next, "version") == "2.0.0");
    CHECK(CborRaw(next, "doc") == DocInterval(5));
    CHECK(h.env.Blob("ota.cfg") == HeldBytes());
}

TEST_CASE("config: clears the next slot when a staged release carries no document") {
    Harness h;
    h.env.SeedConfig("ota.cfgNext", "stale", "1.0.0", DocInterval(99));
    h.env.ReplyWith(OfferResponse());
    h.env.ReplyWithChunks(200, {Bytes(3)});
    CHECK(h.CheckAndRun().status == MIKOtaCheckStatus::kStaged);
    CHECK(!h.env.HasBlob("ota.cfgNext"));
}

TEST_CASE("config: promotes the staged config on the install boot and adopts it at confirm") {
    Harness h;
    h.env.reconcile_outcome = {"newsum", false, false, {"", ""}};
    SeedHeld(h);
    h.env.SeedConfig("ota.cfgNext", "r9", "2.0.0", DocInterval(5));
    h.env.ReplyWith(CheckinResponse{});
    h.env.ReplyWith(CheckinResponse{});

    // The promote changed the effective config, so the first completed check-in
    // reports it: an app on the read → check() → re-read pattern must not run
    // its trial-boot cycle on stale values.
    h.client.Check({}, h.sink());
    h.Run();
    REQUIRE(h.results.size() == 1);
    CHECK(h.results[0].config_updated == true);
    CHECK(CborStr(h.env.Blob("ota.cfg"), "rev") == "r9");
    CHECK(CborRaw(h.env.Blob("ota.cfg"), "doc") == DocInterval(5));
    CHECK(!h.env.HasBlob("ota.cfgNext"));
    CHECK(!h.env.HasBlob("ota.cfgPrev"));

    // Delivered once: the next round has nothing new to report.
    h.client.Check({}, h.sink());
    h.Run();
    REQUIRE(h.results.size() == 2);
    CHECK(h.results[1].config_updated == false);
}

TEST_CASE("config: restores the previous document when the trial rolled back") {
    Harness h;
    h.env.reconcile_outcome = {"", true, false, {"", ""}};
    h.env.SeedConfig("ota.cfg", "r9", "2.0.0", DocInterval(5));
    SeedHeld(h, "ota.cfgPrev");
    h.env.ReplyWith(CheckinResponse{});

    // A restore is as new to the app as a delivery.
    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(h.env.Blob("ota.cfg") == HeldBytes());
    CHECK(!h.env.HasBlob("ota.cfgPrev"));
}

TEST_CASE("config: survives installed and reverted arriving on the same boot") {
    // The most common rollback: a trial that crashes before its first check-in
    // never reconciles, so the restored build's first reconcile reports the
    // install and the revert together. The promote has to run first — it writes
    // the prev baseline the restore reads back; the other order wipes every slot
    // and leaves the device on pure defaults.
    Harness h;
    h.env.reconcile_outcome = {"newsum", true, false, {"", ""}};
    SeedHeld(h);
    h.env.SeedConfig("ota.cfgNext", "r9", "2.0.0", DocInterval(5));
    h.env.ReplyWith(CheckinResponse{});

    h.CheckAndRun();
    CHECK(h.env.Blob("ota.cfg") == HeldBytes());
    CHECK(!h.env.HasBlob("ota.cfgNext"));
    CHECK(!h.env.HasBlob("ota.cfgPrev"));
}

// ── overlay-shaped documents ─────────────────────────────────────────────────

namespace {

/* A `{interval: n, name: s}` document: two keys, so a one-key delivery next to
 * it is visibly a subset rather than the whole thing. */
std::vector<uint8_t> DocPair(int interval, const char* name) {
    return BuildCbor([interval, name](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 2);
        nanocbor_put_tstr(enc, "interval");
        nanocbor_fmt_int(enc, interval);
        nanocbor_put_tstr(enc, "name");
        nanocbor_put_tstr(enc, name);
    });
}

/* The overlay of a document that deviates from the defaults in nothing. */
std::vector<uint8_t> DocEmpty() {
    return BuildCbor([](nanocbor_encoder_t* enc) { nanocbor_fmt_map(enc, 0); });
}

}  // namespace

TEST_CASE("config: stores a served overlay verbatim, and a redelivery of it is no change") {
    // The registry serves only the keys that deviate from the running build's
    // defaults, and the reader spreads what is stored over them. Nothing in the
    // client is doc-shaped: the bytes it was sent are the bytes it keeps, even
    // when they cover fewer keys than what they replace.
    Harness h;
    h.env.SeedConfig("ota.cfg", "r1", "1.0.0", DocPair(30, "shed"));
    std::vector<uint8_t> overlay = DocInterval(45);
    h.env.ReplyWith(ConfigResponse("r2", overlay));

    CHECK(h.CheckAndRun().config_updated == true);
    CHECK(CborRaw(h.env.Blob("ota.cfg"), "doc") == overlay);

    // The same overlay again under the same rev: the rev is the identity of the
    // effective document, so an unchanged redelivery rewrites nothing and
    // reports no change, exactly as a full document does.
    std::vector<uint8_t> before = h.env.Blob("ota.cfg");
    h.results.clear();
    h.env.ReplyWith(ConfigResponse("r2", overlay));
    CHECK(h.CheckAndRun().config_updated == false);
    CHECK(h.env.Blob("ota.cfg") == before);
}

TEST_CASE("config: echoes the failed rev after a rollback, whatever shape the overlay has") {
    // The restored document deviates from the defaults in nothing at all, which
    // is a document like any other: the echo stays the FAILED rev until an
    // operator changes the config, and the report rides with it.
    Harness h;
    h.env.SeedConfig("ota.cfg", "r-restored", "1.0.0", DocEmpty());
    h.env.SeedConfigError("r-bad", "rolled back: no completed check-in");
    h.env.ReplyWith(CheckinResponse{});

    h.CheckAndRun();
    CHECK(CborStr(h.SentBody(), "configRev") == "r-bad");
    CHECK(CborStr(h.SentBody(), "configError.rev") == "r-bad");
    CHECK(CborRaw(h.env.Blob("ota.cfg"), "doc") == DocEmpty());
}

// ── pure helpers ─────────────────────────────────────────────────────────────

TEST_CASE("sameOrigin compares scheme and authority literally") {
    CHECK(mik__ota_same_origin("https://reg.example/a.tgz", "https://reg.example"));
    CHECK(mik__ota_same_origin("https://REG.example/a.tgz", "https://reg.example"));
    // No URL parser here, so a spelled-out default port does not compare equal.
    CHECK(!mik__ota_same_origin("https://reg.example:443/a.tgz", "https://reg.example"));
    CHECK(!mik__ota_same_origin("http://reg.example/a.tgz", "https://reg.example"));
    CHECK(!mik__ota_same_origin("not-a-url", "https://reg.example"));
}

TEST_CASE("isPrivateHttp accepts only LAN/loopback/mDNS http") {
    CHECK(mik__ota_is_private_http("http://192.168.1.10:4873"));
    CHECK(mik__ota_is_private_http("http://10.0.0.1"));
    CHECK(mik__ota_is_private_http("http://172.16.0.1"));
    CHECK(mik__ota_is_private_http("http://127.0.0.1"));
    CHECK(mik__ota_is_private_http("http://169.254.1.1"));
    CHECK(mik__ota_is_private_http("http://localhost:3000"));
    CHECK(mik__ota_is_private_http("http://registry.local"));
    CHECK(!mik__ota_is_private_http("http://8.8.8.8"));
    CHECK(!mik__ota_is_private_http("http://172.32.0.1"));
    CHECK(!mik__ota_is_private_http("http://example.com"));
    CHECK(!mik__ota_is_private_http("https://192.168.1.10"));
}

// ── parseOffer over a decoded response ──────────────────────────────────────

namespace {

/* Evaluate a JS object literal and parse it as an offer. */
struct OfferParse {
    bool ok = false;
    MIKOtaOffer offer;
    bool warned = false;
};

OfferParse ParseOfferLiteral(const char* literal, bool allow_insecure = false) {
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    /* Capture console.warn so the quiet-vs-loud distinction is observable. */
    const char* setup = "globalThis.__warned = false;"
                        "console.warn = () => { globalThis.__warned = true };";
    JSValue prep = JS_Eval(ctx, setup, strlen(setup), "<setup>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, prep);

    JSValue raw = JS_Eval(ctx, literal, strlen(literal), "<offer>", JS_EVAL_TYPE_GLOBAL);
    OfferParse out;
    out.ok = mik__ota_parse_offer_js(ctx, raw, allow_insecure, &out.offer);
    JS_FreeValue(ctx, raw);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue warned = JS_GetPropertyStr(ctx, global, "__warned");
    out.warned = JS_ToBool(ctx, warned);
    JS_FreeValue(ctx, warned);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(rt);
    return out;
}

}  // namespace

TEST_CASE("parseOffer: accepts a well-formed offer from a decoded response") {
    OfferParse r = ParseOfferLiteral(
        "({url: 'https://reg.example/a.tgz', checksum: 'abc', size: 1024})");
    CHECK(r.ok);
    CHECK(r.offer.url == "https://reg.example/a.tgz");
    CHECK(r.offer.checksum == "abc");
    CHECK(r.offer.size == 1024);
    CHECK(!r.warned);
}

TEST_CASE("parseOffer: treats the no-update signals as quiet, not malformed") {
    // null/undefined is the registry saying there is nothing newer, and a body
    // with no url is a response that had something else to say — a name to
    // adopt. Warning on either would log on every device, every round.
    for (const char* literal : {"null", "undefined", "({})", "({name: [1, 'shed']})"}) {
        OfferParse r = ParseOfferLiteral(literal);
        CHECK(!r.ok);
        CHECK(!r.warned);
    }
}

TEST_CASE("parseOffer: warns on a value that is not an object") {
    OfferParse r = ParseOfferLiteral("'not-an-offer'");
    CHECK(!r.ok);
    CHECK(r.warned);
}

TEST_CASE("parseOffer: warns when a url is present but unusable") {
    // A url that is there but wrong is a registry misconfiguring itself.
    struct {
        const char* literal;
    } cases[] = {
        {"({url: 42, checksum: 'abc', size: 1})"},
        {"({url: 'http://reg.example/a.tgz', checksum: 'abc', size: 1})"},
        {"({url: 'https://reg.example/a.zip', checksum: 'abc', size: 1})"},
        {"({url: 'https://reg.example/a.tgz', size: 1})"},
        {"({url: 'https://reg.example/a.tgz', checksum: 'abc'})"},
        {"({url: 'https://reg.example/a.tgz', checksum: 'abc', size: 0})"},
        {"({url: 'https://reg.example/a.tgz', checksum: 'abc', size: 1.5})"},
    };
    for (const auto& c : cases) {
        OfferParse r = ParseOfferLiteral(c.literal);
        CHECK(!r.ok);
        CHECK(r.warned);
    }
}

TEST_CASE("parseOffer: accepts http only with allowInsecure") {
    const char* http = "({url: 'http://192.168.1.10/a.tgz', checksum: 'abc', size: 1})";
    CHECK(!ParseOfferLiteral(http).ok);
    CHECK(ParseOfferLiteral(http, /*allow_insecure=*/true).ok);
}

TEST_CASE("parseOffer: ignores compatibility fields a registry still sends") {
    OfferParse r = ParseOfferLiteral(
        "({url: 'https://reg.example/a.tgz', checksum: 'abc', size: 1024,"
        " firmware: '1.0.0', bytecode: 42, extra: {nested: true}})");
    CHECK(r.ok);
    CHECK(r.offer.size == 1024);
    CHECK(!r.warned);
}

TEST_CASE("buildCheckinReport: encodes the standard report map") {
    MIKDeviceIdentity identity = {"dev-1", "0.16.0", "fwhash", 42};
    MIKOtaRunningBuild running = {"oldsum", "1.0.0", false};
    MIKOtaCheckinFacts facts;
    facts.identity = &identity;
    facts.running = &running;
    facts.name_rev = 1;
    facts.name = "shed";
    facts.has_free = true;
    facts.free_bytes = 900000;
    std::vector<uint8_t> body = mik__ota_build_checkin_report(facts);

    CHECK(CborStr(body, "deviceId") == "dev-1");
    CHECK(CborStr(body, "running.checksum") == "oldsum");
    CHECK(CborInt(body, "name.0") == 1);
    CHECK(CborStr(body, "name.1") == "shed");
    CHECK(CborInt(body, "free") == 900000);
    CHECK(!CborHas(body, "lastInstall"));
    CHECK(!CborHas(body, "configRev"));
    CHECK(!CborHas(body, "configError"));
    CHECK(!CborHas(body, "lastDecline"));
}

TEST_CASE("buildCheckinReport: omits a running build's absent fields") {
    MIKDeviceIdentity identity = {"dev-1", "0.16.0", "fwhash", 42};
    MIKOtaRunningBuild running = {"", "", true};
    MIKOtaCheckinFacts facts;
    facts.identity = &identity;
    facts.running = &running;
    std::vector<uint8_t> body = mik__ota_build_checkin_report(facts);

    CHECK(CborBool(body, "running.trial") == true);
    CHECK(!CborHas(body, "running.checksum"));
    CHECK(!CborHas(body, "running.version"));
    CHECK(!CborHas(body, "free"));
    CHECK(CborInt(body, "name.0") == 0);
    CHECK(!CborHas(body, "name.1"));
}

}  // TEST_SUITE

/* The check-in wire, checked against the other implementation.
 *
 * Every fixture here is a response body the REAL reference registry
 * (packages/@mikrojs/registry) produced, captured by
 * scripts/gen-checkin-fixtures.js and regenerated on every test build. The
 * bodies are replayed through the same round logic a device runs, so a
 * response-shape change on either side breaks a test rather than a fleet.
 * ota_client_test.cpp covers the client's behaviour; this file covers only
 * whether the two implementations still agree on the bytes. */

#include <quickjs.h>

#include <fstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "mikrojs/ota_client.h"
#include "ota_fake_env.h"

using namespace mikrojs;
using namespace mikrojs::test;

namespace {

std::vector<uint8_t> ReadFile(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) FAIL("cannot read fixture: " << path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(file)),
                                std::istreambuf_iterator<char>());
}

std::string PropStr(JSContext* ctx, JSValueConst obj, const char* key) {
    JSValue value = JS_GetPropertyStr(ctx, obj, key);
    size_t len = 0;
    const char* str = JS_ToCStringLen(ctx, &len, value);
    std::string out = str ? std::string(str, len) : std::string();
    if (str) JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, value);
    return out;
}

int64_t PropInt(JSContext* ctx, JSValueConst obj, const char* key) {
    JSValue value = JS_GetPropertyStr(ctx, obj, key);
    int64_t out = 0;
    JS_ToInt64(ctx, &out, value);
    JS_FreeValue(ctx, value);
    return out;
}

bool PropBool(JSContext* ctx, JSValueConst obj, const char* key) {
    JSValue value = JS_GetPropertyStr(ctx, obj, key);
    bool out = JS_ToBool(ctx, value) > 0;
    JS_FreeValue(ctx, value);
    return out;
}

/* One check-in round against a fake env, driven to a standstill. */
struct Replay {
    FakeOtaEnv env;
    MIKOtaClient client{env.env()};
    std::vector<MIKOtaCheckResult> results;

    MIKOtaCheckResult Run() {
        client.Check({}, [this](const MIKOtaCheckResult& result) { results.push_back(result); });
        for (int i = 0; i < 32; i++) {
            client.Poll();
            if (!env.Tick()) break;
        }
        client.Poll();
        REQUIRE(results.size() == 1);
        return results.back();
    }
};

MIKOtaCheckStatus StatusFor(const std::string& result) {
    if (result == "up-to-date") return MIKOtaCheckStatus::kUpToDate;
    if (result == "staged") return MIKOtaCheckStatus::kStaged;
    if (result == "unauthorized") return MIKOtaCheckStatus::kUnauthorized;
    FAIL("unknown expected result: " << result);
    return MIKOtaCheckStatus::kFailed;
}

}  // namespace

TEST_SUITE("ota: check-in wire fixtures") {

TEST_CASE("every registry response replays to the outcome the device must reach") {
    const std::string dir = MIK_CHECKIN_FIXTURE_DIR;
    std::vector<uint8_t> manifest_bytes = ReadFile(dir + "/manifest.json");
    REQUIRE_MESSAGE(!manifest_bytes.empty(), "fixture manifest is empty: " << dir);
    // JS_ParseJSON reads the byte at buf[len] before it checks for the end.
    const size_t manifest_len = manifest_bytes.size();
    manifest_bytes.push_back('\0');

    JSRuntime* runtime = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(runtime);
    JSValue manifest =
        JS_ParseJSON(ctx, reinterpret_cast<const char*>(manifest_bytes.data()),
                     manifest_len, "manifest.json");
    REQUIRE_FALSE(JS_IsException(manifest));

    int64_t count = PropInt(ctx, manifest, "length");
    // A generator that silently produced nothing would otherwise pass here.
    REQUIRE_MESSAGE(count > 0, "no fixtures in " << dir);

    for (int64_t i = 0; i < count; i++) {
        JSValue entry = JS_GetPropertyUint32(ctx, manifest, static_cast<uint32_t>(i));
        JSValue expect = JS_GetPropertyStr(ctx, entry, "expect");
        std::string scenario = PropStr(ctx, entry, "scenario");
        CAPTURE(scenario);

        Replay replay;
        std::string seed_rev = PropStr(ctx, entry, "seedConfigRev");
        if (!seed_rev.empty()) {
            replay.env.SeedConfig("ota.cfg", seed_rev, "1.0.0", DocInterval(30));
        }
        replay.env.ReplyWith(static_cast<int>(PropInt(ctx, entry, "status")),
                             ReadFile(dir + "/" + PropStr(ctx, entry, "file")));

        std::string offer_checksum = PropStr(ctx, expect, "offerChecksum");
        // An offer is followed by the download the client goes on to make.
        if (!offer_checksum.empty()) replay.env.ReplyWithChunks(200, {{1, 2, 3}});

        MIKOtaCheckResult result = replay.Run();

        CHECK(result.status == StatusFor(PropStr(ctx, expect, "result")));
        CHECK(result.config_updated == PropBool(ctx, expect, "configUpdated"));
        if (result.status == MIKOtaCheckStatus::kUnauthorized) {
            CHECK(result.http_status == PropInt(ctx, entry, "status"));
        }
        if (offer_checksum.empty()) {
            CHECK(result.offer.checksum.empty());
        } else {
            CHECK(result.offer.checksum == offer_checksum);
            CHECK(result.offer.url == PropStr(ctx, expect, "offerUrl"));
            CHECK(result.offer.size == static_cast<size_t>(PropInt(ctx, expect, "offerSize")));
        }
        // A config that rides with an offer is held for the build being staged.
        CHECK(replay.env.HasBlob("ota.cfgNext") == PropBool(ctx, expect, "configStaged"));

        int64_t name_rev = PropInt(ctx, expect, "nameRev");
        if (name_rev < 0) {
            CHECK(replay.env.names_set.empty());
        } else {
            REQUIRE(replay.env.names_set.size() == 1);
            CHECK(replay.env.names_set[0].first == name_rev);
            CHECK(replay.env.names_set[0].second == PropStr(ctx, expect, "name"));
        }

        JS_FreeValue(ctx, expect);
        JS_FreeValue(ctx, entry);
    }

    JS_FreeValue(ctx, manifest);
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
}

}  // TEST_SUITE

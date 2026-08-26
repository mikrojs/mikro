/* The `ota.config()` read: the manifest defaults with the stored document
 * spread over them, top level only, and the running-release trial accounted on
 * the reads that actually serve that document. */

#include <memory>
#include <string>

#include "doctest.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_config.h"
#include "mikrojs/ota_policy.h"
#include "mikrojs/ota_slots.h"
#include "ota_fake_env.h"

using namespace mikrojs;
using namespace mikrojs::test;

namespace {

/* The stored slots survive across boots the way NVS does, while each boot gets
 * a fresh reader — module state resets on a real reboot the same way. */
struct Device {
    FakeOtaEnv env;
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    Device() { env.app_version = "1.0.0"; }
    ~Device() { MIK_FreeRuntime(rt); }

    std::unique_ptr<MIKOtaConfigReader> Boot() {
        return std::make_unique<MIKOtaConfigReader>(env.env());
    }

    /* The read, rendered as JSON so a whole document compares in one line. */
    std::string Read(MIKOtaConfigReader& reader) {
        JSValue value = reader.Read(ctx);
        std::string out = Render(value);
        JS_FreeValue(ctx, value);
        return out;
    }

    std::string ReadOnce() {
        auto reader = Boot();
        return Read(*reader);
    }

    /* The message the read threw, or "" when it returned a value. */
    std::string ReadError(MIKOtaConfigReader& reader) {
        JSValue value = reader.Read(ctx);
        if (!JS_IsException(value)) {
            JS_FreeValue(ctx, value);
            return "";
        }
        JSValue exception = JS_GetException(ctx);
        const char* text = JS_ToCString(ctx, exception);
        std::string out = text ? text : "";
        if (text) JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, exception);
        return out;
    }

    std::string ReadErrorOnce() {
        auto reader = Boot();
        return ReadError(*reader);
    }

    std::string Render(JSValue value) {
        if (JS_IsException(value)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return "<thrown>";
        }
        if (JS_IsUndefined(value)) return "undefined";
        JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
        const char* text = JS_ToCString(ctx, json);
        std::string out = text ? text : "<unstringifiable>";
        if (text) JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, json);
        return out;
    }

    void SetManifest(const std::string& json) {
        env.has_manifest = true;
        env.manifest = json;
    }

    /* A `{interval: n}` document, stamped for `version`. */
    void StoreDoc(const char* rev, const char* version, int interval) {
        env.SeedConfig("ota.cfg", rev, version, DocInterval(interval));
    }
};

/* The manifest pack writes: the materialized defaults under `configDefaults`. */
const char* kDefaultsManifest =
    "{\"app\":\"demo\",\"version\":\"1.0.0\","
    "\"configDefaults\":{\"interval\":60}}";

/* Two defaulted fields, so a document covering one shows what the spread does
 * with the other. */
const char* kSpreadManifest =
    "{\"app\":\"demo\",\"version\":\"1.0.0\","
    "\"configDefaults\":{\"interval\":60,\"name\":\"probe\"}}";

/* Well-formed CBOR that skips cleanly but cannot decode: the map key is an
 * integer, and the reader only builds objects from text keys. */
std::vector<uint8_t> DocUndecodable() {
    return BuildCbor([](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 1);
        nanocbor_fmt_int(enc, 1);
        nanocbor_fmt_int(enc, 2);
    });
}

}  // namespace

TEST_SUITE("ota: config") {

// ── resolution ──────────────────────────────────────────────────────────────

TEST_CASE("returns the manifest defaults when nothing is stored") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    CHECK(d.ReadOnce() == "{\"interval\":60}");
}

TEST_CASE("spreads a stored document over the defaults, top level only") {
    // The document wins on every key it carries; a defaulted key it says
    // nothing about survives. With a registry serving complete documents the
    // spread is identity, and it is what carries an overlay when the wire moves.
    Device d;
    d.SetManifest(kSpreadManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    CHECK(d.ReadOnce() == "{\"interval\":45,\"name\":\"probe\"}");
}

TEST_CASE("keeps a document key the defaults never mention") {
    Device d;
    d.SetManifest(kSpreadManifest);
    d.env.SeedConfig("ota.cfg", "r1", "1.0.0", BuildCbor([](nanocbor_encoder_t* enc) {
                         nanocbor_fmt_map(enc, 2);
                         nanocbor_put_tstr(enc, "interval");
                         nanocbor_fmt_int(enc, 45);
                         nanocbor_put_tstr(enc, "extra");
                         nanocbor_fmt_bool(enc, true);
                     }));
    CHECK(d.ReadOnce() == "{\"interval\":45,\"name\":\"probe\",\"extra\":true}");
}

TEST_CASE("ignores a document stamped for another version") {
    // It was computed against a different release's schema.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "0.9.0", 45);
    CHECK(d.ReadOnce() == "{\"interval\":60}");
}

TEST_CASE("falls back to the defaults when the stored bytes do not decode") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.env.SeedConfig("ota.cfg", "r1", "1.0.0", DocUndecodable());
    CHECK(d.ReadOnce() == "{\"interval\":60}");
}

TEST_CASE("serves the document alone when the build carries no manifest") {
    Device d;
    d.StoreDoc("r1", "1.0.0", 45);
    CHECK(d.ReadOnce() == "{\"interval\":45}");
}

TEST_CASE("reads an empty config for an app that declares no schema") {
    // Pack writes `value` (possibly {}) whenever a schema is declared, so a
    // manifest without it is an app with no config, not a failure.
    Device d;
    d.SetManifest("{\"app\":\"demo\",\"version\":\"1.0.0\"}");
    CHECK(d.ReadOnce() == "{}");
}

TEST_CASE("throws with no manifest and no stored document") {
    // Out of contract: this build never went through the tooling, and the read
    // says so rather than handing the app an empty config to crash on.
    Device d;
    std::string message = d.ReadErrorOnce();
    CHECK(message.find("no config to read") != std::string::npos);
    CHECK(message.find("mikro deploy") != std::string::npos);
}

TEST_CASE("hands out a fresh object every call") {
    // The defaults are cached for the runtime's lifetime, so an app mutating
    // what it got must not be able to reach them.
    Device d;
    d.SetManifest(kDefaultsManifest);
    auto reader = d.Boot();

    JSValue first = reader->Read(d.ctx);
    JS_SetPropertyStr(d.ctx, first, "interval", JS_NewInt32(d.ctx, 1));
    JS_FreeValue(d.ctx, first);
    CHECK(d.Read(*reader) == "{\"interval\":60}");
}

TEST_CASE("returns a nested value verbatim") {
    // The reader never walks into a value: whatever the registry stored under a
    // key is handed back whole, nested maps included.
    Device d;
    std::vector<uint8_t> doc = BuildCbor([](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 1);
        nanocbor_put_tstr(enc, "mqtt");
        nanocbor_fmt_map(enc, 2);
        nanocbor_put_tstr(enc, "host");
        nanocbor_put_tstr(enc, "broker.local");
        nanocbor_put_tstr(enc, "port");
        nanocbor_fmt_uint(enc, 1883);
    });
    d.env.SeedConfig("ota.cfg", "r1", "1.0.0", doc);
    CHECK(d.ReadOnce() == "{\"mqtt\":{\"host\":\"broker.local\",\"port\":1883}}");
}

// ── the cached manifest ─────────────────────────────────────────────────────

TEST_CASE("parses the manifest once and holds it") {
    // Re-reading and re-parsing on every call is an fopen, a malloc and a JSON
    // parse each able to fail under heap pressure.
    Device d;
    d.SetManifest(kDefaultsManifest);
    auto reader = d.Boot();
    d.Read(*reader);
    d.Read(*reader);
    d.Read(*reader);
    CHECK(d.env.manifest_reads == 1);
}

TEST_CASE("retries a manifest that could not be parsed") {
    // Cached on success only: a parse starved of heap must not be remembered as
    // "this build has no defaults" for the rest of the runtime's life.
    Device d;
    d.SetManifest("{not json");
    d.StoreDoc("r1", "1.0.0", 45);

    auto reader = d.Boot();
    CHECK(d.Read(*reader) == "{\"interval\":45}");  // the document, no defaults
    CHECK(d.env.manifest_reads == 1);

    d.SetManifest(kSpreadManifest);
    CHECK(d.Read(*reader) == "{\"interval\":45,\"name\":\"probe\"}");
    CHECK(d.env.manifest_reads == 2);
}

// ── trial accounting ────────────────────────────────────────────────────────

TEST_CASE("burns a trial boot per boot and rolls back when the budget is spent") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    d.env.SeedConfig("ota.cfgPrev", "r1", "1.0.0", DocInterval(30));
    d.env.SeedConfigTrial(1, false);

    // First boot: burns the boot, still serves the document on trial.
    CHECK(d.ReadOnce() == "{\"interval\":45}");
    std::vector<uint8_t> trial = d.env.Blob("ota.cfgTrial");
    CHECK(CborInt(trial, "left") == 0);
    CHECK(CborBool(trial, "read") == true);

    // Second boot: the budget is spent, so the previous document is restored and
    // this very read returns the restored values — which is what breaks a loop.
    CHECK(d.ReadOnce() == "{\"interval\":30}");
    CHECK(!d.env.HasBlob("ota.cfgTrial"));
    CHECK(!d.env.HasBlob("ota.cfgPrev"));
    CHECK(CborRaw(d.env.Blob("ota.cfg"), "doc") == DocInterval(30));

    // And the failure is recorded for the next check-in to report.
    std::vector<uint8_t> error = d.env.Blob("ota.cfgErr");
    CHECK(CborStr(error, "rev") == "r2");
    CHECK(CborStr(error, "message").find("rolled back") == 0);
}

TEST_CASE("accounts once per boot, not once per read") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    d.env.SeedConfigTrial(2, false);

    auto reader = d.Boot();
    d.Read(*reader);
    d.Read(*reader);
    d.Read(*reader);
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 1);
}

TEST_CASE("marks a mid-boot delivery read without burning a boot") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);

    auto reader = d.Boot();
    d.Read(*reader);  // no trial yet
    // A check-in delivers a document after the boot was accounted.
    d.env.SeedConfigTrial(1, false);
    d.Read(*reader);

    std::vector<uint8_t> trial = d.env.Blob("ota.cfgTrial");
    CHECK(CborInt(trial, "left") == 1);  // not burned
    CHECK(CborBool(trial, "read") == true);
}

TEST_CASE("leaves the trial alone when the read does not serve the document") {
    // Recording that the app read a document it never saw is the whole defect
    // the accounting condition exists to prevent.
    SUBCASE("stamped for another version") {
        Device d;
        d.SetManifest(kDefaultsManifest);
        d.StoreDoc("r2", "0.9.0", 45);
        d.env.SeedConfigTrial(2, false);
        CHECK(d.ReadOnce() == "{\"interval\":60}");
        CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 2);
        CHECK(CborBool(d.env.Blob("ota.cfgTrial"), "read") == false);
    }

    SUBCASE("bytes that will not decode") {
        Device d;
        d.SetManifest(kDefaultsManifest);
        d.env.SeedConfig("ota.cfg", "r2", "1.0.0", DocUndecodable());
        d.env.SeedConfigTrial(2, false);
        CHECK(d.ReadOnce() == "{\"interval\":60}");
        CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 2);
        CHECK(CborBool(d.env.Blob("ota.cfgTrial"), "read") == false);
    }
}

TEST_CASE("rolls back to the manifest defaults when nothing preceded the document") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    d.env.SeedConfigTrial(0, true);
    CHECK(d.ReadOnce() == "{\"interval\":60}");
    CHECK(!d.env.HasBlob("ota.cfg"));
}

TEST_CASE("leaves an adopted document alone") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    // No trial: the client adopted it at a completed check-in.
    CHECK(d.ReadOnce() == "{\"interval\":45}");
    CHECK(CborRaw(d.env.Blob("ota.cfg"), "doc") == DocInterval(45));
    CHECK(!d.env.HasBlob("ota.cfgErr"));
}

// ── failed store reads ──────────────────────────────────────────────────────

TEST_CASE("holds the last good document while reads fail") {
    // Treating a starved read as absence flips a live device onto the defaults
    // for a beat, re-configuring its GPIO mid-handshake.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);

    auto reader = d.Boot();
    CHECK(d.Read(*reader) == "{\"interval\":45}");
    d.env.fail_blob_reads = true;
    CHECK(d.Read(*reader) == "{\"interval\":45}");
    CHECK(d.Read(*reader) == "{\"interval\":45}");
    d.env.fail_blob_reads = false;
    CHECK(d.Read(*reader) == "{\"interval\":45}");
}

TEST_CASE("serves the defaults when the first read of a boot fails") {
    // Before the first successful read there is nothing to hold, and the flap
    // the held value exists to prevent cannot have happened yet.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    d.env.fail_blob_reads = true;
    CHECK(d.ReadOnce() == "{\"interval\":60}");
}

TEST_CASE("throws when a failed read meets a build with no manifest") {
    Device d;
    d.StoreDoc("r1", "1.0.0", 45);
    d.env.fail_blob_reads = true;
    CHECK(d.ReadErrorOnce().find("no config to read") != std::string::npos);
}

TEST_CASE("applies a genuine clear immediately despite the held value") {
    // A clear removes the key, so it reads back as an honest absence: the two
    // cases travel different channels and cannot be confused.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);

    auto reader = d.Boot();
    CHECK(d.Read(*reader) == "{\"interval\":45}");
    d.env.KvRemove("ota.cfg");
    CHECK(d.Read(*reader) == "{\"interval\":60}");
}

TEST_CASE("never burns a second trial boot when a failed read retries accounting") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    d.env.SeedConfigTrial(2, false);
    d.env.fail_blob_reads = true;

    auto reader = d.Boot();
    CHECK(d.Read(*reader) == "{\"interval\":60}");
    // The trial is untouched: the read never happened.
    d.env.fail_blob_reads = false;
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 2);

    CHECK(d.Read(*reader) == "{\"interval\":45}");
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 1);
    // A retry must not burn a second boot for the same power cycle.
    d.Read(*reader);
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 1);
}

TEST_CASE("retries a rollback whose reads failed, without losing it") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r2", "1.0.0", 45);
    d.env.SeedConfig("ota.cfgPrev", "r1", "1.0.0", DocInterval(30));
    d.env.SeedConfigTrial(0, true);
    d.env.fail_blob_reads = true;

    auto reader = d.Boot();
    CHECK(d.Read(*reader) == "{\"interval\":60}");
    // Nothing was written: the rollback is still owed.
    d.env.fail_blob_reads = false;
    CHECK(d.env.HasBlob("ota.cfgPrev"));
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 0);

    CHECK(d.Read(*reader) == "{\"interval\":30}");
    CHECK(!d.env.HasBlob("ota.cfgPrev"));
    CHECK(!d.env.HasBlob("ota.cfgTrial"));
    CHECK(CborStr(d.env.Blob("ota.cfgErr"), "rev") == "r2");
}

// ── the writes ──────────────────────────────────────────────────────────────

/* A delivery, as a client hands one over. The bytes back the doc span, so the
 * delivery has to outlive the call that stores it. */
struct Delivery {
    std::vector<uint8_t> bytes;
    MIKOtaStoredConfig cfg = {};

    Delivery(const char* rev, const char* version, std::vector<uint8_t> doc)
        : bytes(std::move(doc)) {
        snprintf(cfg.rev, sizeof(cfg.rev), "%s", rev);
        snprintf(cfg.version, sizeof(cfg.version), "%s", version);
        if (!bytes.empty()) {
            cfg.doc_cbor = bytes.data();
            cfg.doc_cbor_len = bytes.size();
        }
    }
};

TEST_CASE("applies a document stamped for the running release") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    Delivery delivered("r1", "1.0.0", DocInterval(45));

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 2) == MIKOtaConfigWrite::kApplied);
    CHECK(CborStr(d.env.Blob("ota.cfg"), "rev") == "r1");
    CHECK(CborInt(d.env.Blob("ota.cfgTrial"), "left") == 2);
    CHECK(d.ReadOnce() == "{\"interval\":45}");
}

TEST_CASE("keeps the document it replaced as the rollback baseline") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    Delivery delivered("r2", "1.0.0", DocInterval(30));

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1) == MIKOtaConfigWrite::kApplied);
    CHECK(CborStr(d.env.Blob("ota.cfgPrev"), "rev") == "r1");
    CHECK(CborStr(d.env.Blob("ota.cfg"), "rev") == "r2");
}

TEST_CASE("stages a document stamped for another release") {
    // It was computed for a build this device is not running, so it applies
    // when that build does, and the running app must not see it.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    Delivery delivered("r2", "2.0.0", DocInterval(30));

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1) == MIKOtaConfigWrite::kStaged);
    CHECK(CborStr(d.env.Blob("ota.cfgNext"), "rev") == "r2");
    CHECK(CborStr(d.env.Blob("ota.cfg"), "rev") == "r1");
    CHECK(!d.env.HasBlob("ota.cfgTrial"));
    CHECK(d.ReadOnce() == "{\"interval\":45}");
}

TEST_CASE("stages the clear for another release") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.env.SeedConfig("ota.cfgNext", "r1", "2.0.0", DocInterval(30));
    Delivery delivered("r2", "2.0.0", {});

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1) == MIKOtaConfigWrite::kStaged);
    CHECK(!d.env.HasBlob("ota.cfgNext"));
}

TEST_CASE("clears the stored document when the delivery carries none") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    Delivery cleared("r2", "1.0.0", {});

    CHECK(mik__ota_deliver_config(d.env.env(), &cleared.cfg, 1) == MIKOtaConfigWrite::kCleared);
    CHECK(!d.env.HasBlob("ota.cfg"));
    CHECK(d.ReadOnce() == "{\"interval\":60}");
}

TEST_CASE("reports a clear with nothing to clear as unchanged") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    Delivery cleared("r2", "1.0.0", {});

    CHECK(mik__ota_deliver_config(d.env.env(), &cleared.cfg, 1) == MIKOtaConfigWrite::kUnchanged);
}

TEST_CASE("an identical document costs nothing") {
    // A writer that sends the same document every round must not put a document
    // that already passed its trial back on trial, or re-write NVS for nothing.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    Delivery same("r1", "1.0.0", DocInterval(45));

    CHECK(mik__ota_deliver_config(d.env.env(), &same.cfg, 1) == MIKOtaConfigWrite::kUnchanged);
    CHECK(!d.env.HasBlob("ota.cfgTrial"));
    CHECK(!d.env.HasBlob("ota.cfgPrev"));
}

TEST_CASE("a new rev on the same values is a new document") {
    // The rev is what the device echoes, so it has to be stored and echoed back
    // even when nothing else about the document moved.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 45);
    Delivery rekeyed("r2", "1.0.0", DocInterval(45));

    CHECK(mik__ota_deliver_config(d.env.env(), &rekeyed.cfg, 1) == MIKOtaConfigWrite::kApplied);
    CHECK(CborStr(d.env.Blob("ota.cfg"), "rev") == "r2");
}

TEST_CASE("a store that cannot answer is a failed write, not an unchanged one") {
    // Nothing was written, so the writer must send the document again rather
    // than echo a rev the device does not hold.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.env.fail_blob_reads = true;
    Delivery delivered("r1", "1.0.0", DocInterval(45));

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1) == MIKOtaConfigWrite::kFailed);
    d.env.fail_blob_reads = false;
    CHECK(!d.env.HasBlob("ota.cfg"));
}

TEST_CASE("cannot place a document without the running version") {
    // Which slot it belongs in is exactly what the stamp answers, and the
    // reader drops a document stamped for another release without a sound.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.env.app_version.clear();
    Delivery delivered("r1", "1.0.0", DocInterval(45));

    CHECK(mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1) == MIKOtaConfigWrite::kFailed);
    CHECK(!d.env.HasBlob("ota.cfg"));
}

TEST_CASE("a confirm keeps a document the app has read") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 30);
    Delivery delivered("r2", "1.0.0", DocInterval(45));
    mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1);

    CHECK(d.ReadOnce() == "{\"interval\":45}");
    mik__ota_policy_confirm(d.env.env());

    CHECK(!d.env.HasBlob("ota.cfgTrial"));
    CHECK(!d.env.HasBlob("ota.cfgPrev"));
    CHECK(d.ReadOnce() == "{\"interval\":45}");
}

TEST_CASE("a confirm keeps nothing the app has not read") {
    // A check-in completing before the app ever ran with the new values proves
    // nothing about them.
    Device d;
    d.SetManifest(kDefaultsManifest);
    Delivery delivered("r2", "1.0.0", DocInterval(45));
    mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1);

    mik__ota_policy_confirm(d.env.env());
    CHECK(d.env.HasBlob("ota.cfgTrial"));
}

TEST_CASE("settling reports whether a trial was actually adopted") {
    Device d;
    d.SetManifest(kDefaultsManifest);
    // No trial in progress: nothing to settle.
    CHECK(!mik__ota_adopt_config_trial(d.env.env()));

    Delivery delivered("r1", "1.0.0", DocInterval(45));
    mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1);
    // Armed but unread: still nothing.
    CHECK(!mik__ota_adopt_config_trial(d.env.env()));

    CHECK(d.ReadOnce() == "{\"interval\":45}");
    CHECK(mik__ota_adopt_config_trial(d.env.env()));
}

TEST_CASE("rolls a delivered document back when no confirm arrives") {
    // The whole point of the trial, driven end to end through the write: a
    // document delivered by an app's own client is no more trusted than one the
    // built-in client delivered.
    Device d;
    d.SetManifest(kDefaultsManifest);
    d.StoreDoc("r1", "1.0.0", 30);
    Delivery delivered("r2", "1.0.0", DocInterval(45));
    mik__ota_deliver_config(d.env.env(), &delivered.cfg, 1);

    // One boot runs on the new values, and nothing confirms them.
    CHECK(d.ReadOnce() == "{\"interval\":45}");
    // The next restores what the app was running before, and records why.
    CHECK(d.ReadOnce() == "{\"interval\":30}");
    CHECK(CborStr(d.env.Blob("ota.cfgErr"), "rev") == "r2");
}

}  // TEST_SUITE

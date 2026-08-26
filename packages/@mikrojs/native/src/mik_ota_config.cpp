#include "mikrojs/ota_config.h"

#include <nanocbor/nanocbor.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/ota_slots.h"
#include "mikrojs/platform.h"

namespace mikrojs {

namespace {

/* Copy `source`'s own enumerable string keys onto `target`, TOP LEVEL ONLY.
 * This is the `{...defaults, ...doc}` spread and nothing more: a deviating
 * value inside a nested unit ships the whole unit, so recursing here would
 * merge across schema branches that have no common meaning. Returns false with
 * the exception left pending. */
bool CopyOwnProps(JSContext* ctx, JSValue target, JSValue source) {
    if (!JS_IsObject(source)) return true;
    JSPropertyEnum* props = nullptr;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(ctx, &props, &count, source,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) != 0) {
        return false;
    }
    bool ok = true;
    for (uint32_t i = 0; i < count; i++) {
        JSValue value = JS_GetProperty(ctx, source, props[i].atom);
        if (JS_IsException(value)) {
            ok = false;
            break;
        }
        /* Consumes `value`; the atom stays owned by the enum. */
        if (JS_DefinePropertyValue(ctx, target, props[i].atom, value, JS_PROP_C_W_E) < 0) {
            ok = false;
            break;
        }
    }
    JS_FreePropertyEnum(ctx, props, count);
    return ok;
}

/* A fresh object carrying `source`'s top-level properties. Every read hands out
 * one of these rather than the cached defaults themselves: an app is free to
 * mutate what it got, and a mutation reaching the cache would poison every
 * later read for the runtime's lifetime. */
JSValue ShallowCopy(JSContext* ctx, JSValue source) {
    JSValue out = JS_NewObject(ctx);
    if (JS_IsException(out)) return out;
    if (!CopyOwnProps(ctx, out, source)) {
        JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    return out;
}

}  // namespace

MIKOtaConfigReader::~MIKOtaConfigReader() {
    if (has_last_good_ && last_good_ctx_) JS_FreeValue(last_good_ctx_, last_good_);
    if (has_defaults_ && defaults_ctx_) JS_FreeValue(defaults_ctx_, defaults_);
}

JSValue MIKOtaConfigReader::ServeLastGood(JSContext* ctx) const {
    if (!has_last_good_) return JS_UNDEFINED;
    return JS_DupValue(ctx, last_good_);
}

void MIKOtaConfigReader::KeepLastGood(JSContext* ctx, JSValue value) {
    if (has_last_good_ && last_good_ctx_) JS_FreeValue(last_good_ctx_, last_good_);
    last_good_ = JS_DupValue(ctx, value);
    last_good_ctx_ = ctx;
    has_last_good_ = true;
}

JSValue MIKOtaConfigReader::ServeFallback(JSContext* ctx) {
    JSValue held = ServeLastGood(ctx);
    if (!JS_IsUndefined(held)) return held;
    /* Nothing has read successfully yet this runtime, so there is nothing to
     * hold on to: the defaults are the honest answer, and the flap the held
     * value exists to prevent cannot happen before the first success. */
    JSValue defaults = Defaults(ctx);
    if (JS_IsUndefined(defaults)) {
        return JS_ThrowPlainError(
            ctx, "ota.config(): no config to read: the stored document could not be read and "
                 "this build carries no readable app manifest to take defaults from");
    }
    // Not kept as the last good value: only a read the store answered records
    // one, so a recovered store still replaces the defaults with the document.
    return ShallowCopy(ctx, defaults);
}

JSValue MIKOtaConfigReader::Read(JSContext* ctx) {
    bool store_failed = false;
    JSValue doc = LoadDoc(ctx, &store_failed);
    bool serving_doc = !JS_IsUndefined(doc);

    if (!store_failed) {
        bool rolled_back = false;
        if (!Account(serving_doc, &rolled_back) && serving_doc) {
            /* The trial store could not answer, so nothing was written and the
             * whole block retries on the next read. Serving the document
             * meanwhile would run the app on values whose crash budget could
             * not be charged, which is the one thing the accounting is for. */
            JS_FreeValue(ctx, doc);
            return ServeFallback(ctx);
        }
        if (rolled_back) {
            /* The rollback replaced the stored document under us, and this very
             * read returning the restored values is what breaks a crash loop. */
            JS_FreeValue(ctx, doc);
            doc = LoadDoc(ctx, &store_failed);
        }
    }
    if (store_failed) {
        JS_FreeValue(ctx, doc);
        return ServeFallback(ctx);
    }

    JSValue defaults = Defaults(ctx); /* borrowed */
    JSValue result;
    if (JS_IsUndefined(defaults)) {
        if (JS_IsUndefined(doc)) {
            return JS_ThrowPlainError(
                ctx, "ota.config(): no config to read: this build carries no readable app "
                     "manifest, so it has no config defaults. Deploy it with `mikro deploy`, "
                     "or run `mikro dev`");
        }
        /* No defaults to spread under it: the document stands alone, and it is
         * decoded fresh on every read so the caller may mutate it. */
        result = doc;
    } else if (JS_IsUndefined(doc)) {
        result = ShallowCopy(ctx, defaults);
    } else {
        result = JS_NewObject(ctx);
        if (!JS_IsException(result) &&
            !(CopyOwnProps(ctx, result, defaults) && CopyOwnProps(ctx, result, doc))) {
            JS_FreeValue(ctx, result);
            result = JS_EXCEPTION;
        }
        JS_FreeValue(ctx, doc);
    }
    if (JS_IsException(result)) return result;

    KeepLastGood(ctx, result);
    return result;
}

bool MIKOtaConfigReader::Account(bool serving_doc, bool* out_rolled_back) {
    *out_rolled_back = false;

    if (accounted_) {
        if (!serving_doc) return true;
        MIKOtaConfigTrial trial = {};
        if (mik__ota_load_trial(env_, &trial) == MIK_OTA_KV_OK && !trial.read) {
            /* A document delivered mid-boot: the boot was already accounted, but
             * this read is what makes the trial adoptable. */
            MIKOtaConfigTrial next = {trial.left, true};
            mik__ota_store_trial(env_, next);
        }
        return true;
    }

    MIKOtaConfigTrial trial = {};
    MIKOtaKvStatus status = mik__ota_load_trial(env_, &trial);
    // A read that never happened must leave the trial untouched and retry on
    // the next read, or a starved store silently burns the budget.
    if (status == MIK_OTA_KV_ERROR) return false;

    // Only a document this read actually serves is charged. A boot that fell
    // back to the defaults (nothing stored, stamped for another version, bytes
    // that would not decode) never ran the app on the document, and recording
    // that it did is the defect this condition exists to prevent.
    if (status == MIK_OTA_KV_OK && serving_doc) {
        if (trial.left <= 0) {
            // Reads come before the writes, so a failure here leaves the
            // trial untouched and the whole block retries on the next read.
            MIKOtaLoadedConfig failed = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT);
            if (failed.failed) return false;
            MIKOtaLoadedConfig previous = mik__ota_load_slot(env_, MIK_OTA_CFG_PREV);
            if (previous.failed) return false;

            if (previous.present) {
                mik__ota_store_slot(env_, MIK_OTA_CFG_CURRENT, previous.cfg);
            } else {
                mik__ota_clear_slot(env_, MIK_OTA_CFG_CURRENT);
            }
            mik__ota_clear_slot(env_, MIK_OTA_CFG_PREV);
            mik__ota_clear_trial(env_);
            *out_rolled_back = true;

            if (failed.present && failed.cfg.rev[0]) {
                MIKOtaConfigErrorReport report = {};
                snprintf(report.rev, sizeof(report.rev), "%s", failed.cfg.rev);
                snprintf(report.message, sizeof(report.message), "%s",
                         "rolled back: no completed check-in while the config was on trial");
                mik__ota_store_config_error(env_, report);
            }
        } else {
            // Burn one boot, and record that the app has read the document:
            // adoption (in the client) waits for that, or an app reading
            // config only at boot could have a never-executed document
            // adopted under it, crash-looping at some later power cycle.
            MIKOtaConfigTrial next = {trial.left - 1, true};
            mik__ota_store_trial(env_, next);
        }
    }
    // Only after the trial work fully succeeded: a retried read must never
    // burn a second boot for the same power cycle. The boot has used its
    // accounting slot even when there was no document to charge it against, so
    // one delivered later in the same boot is marked read, not burned again.
    accounted_ = true;
    return true;
}

JSValue MIKOtaConfigReader::LoadDoc(JSContext* ctx, bool* out_failed) {
    *out_failed = false;

    MIKOtaLoadedConfig stored = mik__ota_load_slot(env_, MIK_OTA_CFG_CURRENT);
    if (stored.failed) {
        *out_failed = true;
        return JS_UNDEFINED;
    }
    if (!stored.present || !stored.cfg.doc_cbor || stored.cfg.doc_cbor_len == 0) {
        return JS_UNDEFINED;
    }

    char version[32] = {};
    if (!env_ || !env_->read_app_version ||
        !env_->read_app_version(env_->opaque, version, sizeof(version))) {
        return JS_UNDEFINED;
    }
    // Stamped for another release: it was computed against that release's
    // schema, so it says nothing about this one.
    if (strcmp(stored.cfg.version, version) != 0) return JS_UNDEFINED;

    // Decoded verbatim: the reader never walks into a value.
    nanocbor_value_t it;
    nanocbor_decoder_init(&it, stored.cfg.doc_cbor, stored.cfg.doc_cbor_len);
    JSValue doc = mik__cbor_decode_value(ctx, &it, 0);
    if (JS_IsException(doc)) {
        // Bytes that will not decode are no more readable than none at all, and
        // the defaults are a working config. Nothing is rewritten: the rev the
        // device echoes is unchanged, so the registry re-serves the document.
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    return doc;
}

JSValue MIKOtaConfigReader::Defaults(JSContext* ctx) {
    if (has_defaults_) return defaults_;

    char* manifest = (env_ && env_->read_manifest) ? env_->read_manifest(env_->opaque) : nullptr;
    if (!manifest) return JS_UNDEFINED;
    JSValue parsed = JS_ParseJSON(ctx, manifest, strlen(manifest), "mikro.app.json");
    free(manifest);
    if (JS_IsException(parsed)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }

    JSValue value = JS_GetPropertyStr(ctx, parsed, "configDefaults");
    if (!JS_IsObject(value)) {
        JS_FreeValue(ctx, value);
        value = JS_UNDEFINED;
    }
    JS_FreeValue(ctx, parsed);
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));

    if (JS_IsUndefined(value)) {
        // A manifest without materialized defaults: the app declares no config
        // schema, so an empty object is its config, not a failure. Pack writes
        // `configDefaults` (possibly {}) whenever a schema is declared.
        value = JS_NewObject(ctx);
        if (JS_IsException(value)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return JS_UNDEFINED;
        }
    }

    // Cached on success only. A manifest that could not be read or parsed under
    // heap pressure is retried on the next call rather than remembered as "this
    // build has no defaults".
    defaults_ = value;
    defaults_ctx_ = ctx;
    has_defaults_ = true;
    return defaults_;
}

/* ── the writes ──────────────────────────────────────────────────────────── */

namespace {

/* `arg` fills the one %s a config log line ever carries. */
void LogConfig(const MIKOtaEnv* env, int level, const char* fmt, const char* arg = nullptr) {
    if (!env || !env->log) return;
    if (arg) {
        env->log(env->opaque, level, fmt, arg);
    } else {
        env->log(env->opaque, level, "%s", fmt);
    }
}

}  // namespace

const char* mik__ota_config_write_to_str(MIKOtaConfigWrite write) {
    switch (write) {
        case MIKOtaConfigWrite::kUnchanged:
            return "unchanged";
        case MIKOtaConfigWrite::kApplied:
            return "applied";
        case MIKOtaConfigWrite::kCleared:
            return "cleared";
        case MIKOtaConfigWrite::kStaged:
            return "staged";
        case MIKOtaConfigWrite::kFailed:
            return "failed";
    }
    return "unknown";
}

MIKOtaConfigWrite mik__ota_apply_running_config(const MIKOtaEnv* env,
                                                const MIKOtaStoredConfig* config,
                                                int trial_boots) {
    if (!config) return MIKOtaConfigWrite::kUnchanged;

    if (!config->doc_cbor || config->doc_cbor_len == 0) {
        // A rev riding along does not turn a clear into a document.
        mik__ota_clear_trial(env);
        mik__ota_clear_config_error(env);
        mik__ota_clear_slot(env, MIK_OTA_CFG_PREV);
        MIKOtaLoadedConfig held = mik__ota_load_slot(env, MIK_OTA_CFG_CURRENT);
        if (held.failed) return MIKOtaConfigWrite::kFailed;
        if (!held.present) return MIKOtaConfigWrite::kUnchanged;
        mik__ota_clear_slot(env, MIK_OTA_CFG_CURRENT);
        LogConfig(env, MIK_LOG_INFO, "ota: config cleared");
        return MIKOtaConfigWrite::kCleared;
    }

    MIKOtaLoadedConfig previous = mik__ota_load_slot(env, MIK_OTA_CFG_CURRENT);

    // Without the document being replaced there is no baseline to roll back to,
    // and clearing the one already stored would strand a bad document with
    // nowhere to fall back to. Leave everything alone; the rev the device
    // echoes is unchanged, so the writer sends this again.
    if (previous.failed) return MIKOtaConfigWrite::kFailed;

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
        return MIKOtaConfigWrite::kUnchanged;
    }

    // The old document is kept as the rollback baseline: a schema-valid value
    // can still be fatal to the app (a GPIO this board does not have), and the
    // crash it causes can fire before any check-in runs.
    if (previous.present) {
        mik__ota_store_slot(env, MIK_OTA_CFG_PREV, previous.cfg);
    } else {
        mik__ota_clear_slot(env, MIK_OTA_CFG_PREV);
    }
    mik__ota_store_slot(env, MIK_OTA_CFG_CURRENT, *config);
    MIKOtaConfigTrial trial = {trial_boots, false};
    mik__ota_store_trial(env, trial);
    mik__ota_clear_config_error(env);
    LogConfig(env, MIK_LOG_INFO, "ota: config updated for %s", config->version);
    return MIKOtaConfigWrite::kApplied;
}

void mik__ota_stage_next_config(const MIKOtaEnv* env, const MIKOtaStoredConfig* config) {
    if (config && config->doc_cbor && config->doc_cbor_len > 0) {
        mik__ota_store_slot(env, MIK_OTA_CFG_NEXT, *config);
        LogConfig(env, MIK_LOG_INFO, "ota: config staged for %s", config->version);
        return;
    }
    // The clear is staged too: the offered release holds no document, and its
    // manifest defaults stand in once it runs.
    mik__ota_clear_slot(env, MIK_OTA_CFG_NEXT);
}

MIKOtaConfigWrite mik__ota_deliver_config(const MIKOtaEnv* env, const MIKOtaStoredConfig* config,
                                          int trial_boots) {
    if (!config) return MIKOtaConfigWrite::kUnchanged;

    char running[32] = {};
    if (!env || !env->read_app_version ||
        !env->read_app_version(env->opaque, running, sizeof(running))) {
        // The version the document has to be matched against could not be read,
        // so which slot it belongs in is unknown. Storing it in either would be
        // a guess, and the reader drops a document stamped for another release
        // without a sound, so the guess would fail silently.
        return MIKOtaConfigWrite::kFailed;
    }

    if (strcmp(config->version, running) == 0) {
        return mik__ota_apply_running_config(env, config, trial_boots);
    }
    // Stamped for another release: it is the document that release will read,
    // and it applies with the build, not before it.
    mik__ota_stage_next_config(env, config);
    return MIKOtaConfigWrite::kStaged;
}

bool mik__ota_adopt_config_trial(const MIKOtaEnv* env) {
    // A read that FAILED is not a read that found nothing: it fails under heap
    // pressure, and adopting on it would keep a document the app never read.
    MIKOtaConfigTrial trial = {};
    MIKOtaKvStatus status = mik__ota_load_trial(env, &trial);
    // With no trial in progress the clears are housekeeping, not a settlement.
    bool settled = status == MIK_OTA_KV_OK && trial.read;
    if (status != MIK_OTA_KV_ABSENT && !settled) return false;
    mik__ota_clear_slot(env, MIK_OTA_CFG_PREV);
    mik__ota_clear_trial(env);
    return settled;
}

}  // namespace mikrojs

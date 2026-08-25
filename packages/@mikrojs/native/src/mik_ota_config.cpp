#include "mikrojs/ota_config.h"

#include <nanocbor/nanocbor.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/ota_slots.h"

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

}  // namespace mikrojs

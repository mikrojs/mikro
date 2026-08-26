/**
 * native:mikro/ota_client — the JS surface of the native OTA client.
 *
 * Thin by design: the state machine lives in the portable library
 * (mikrojs/ota_client.h) where host tests drive it. This file does three things
 * the machine cannot do for itself — marshal options and results across the JS
 * boundary, settle a promise when a round finishes, and re-enter JS for the
 * app's `beforeCheck` hook, which is the one place JS runs inside a round.
 */

#include <memory>
#include <vector>

#include "esp_log.h"
#include "mik_http_internal.h"
#include "mik_ota_native.h"
#include "mikrojs/cbor_helpers.h"
#include "mikrojs/ota_client.h"
#include "mikrojs/ota_config.h"
#include "mikrojs/ota_js_hooks.h"
#include "mikrojs/ota_policy.h"
#include "mikrojs/ota_slots.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

using mikrojs::MIKOtaCheckOptions;
using mikrojs::MIKOtaCheckResult;
using mikrojs::MIKOtaCheckStatus;
using mikrojs::MIKOtaClient;
using mikrojs::MIKOtaConfigReader;
using mikrojs::MIKOtaConfigWrite;
using mikrojs::MIKOtaJsHooks;
using mikrojs::MIKOtaApplyOutcome;
using mikrojs::MIKOtaApplySession;
using mikrojs::MIKOtaError;
using mikrojs::MIKOtaInstallOptions;
using mikrojs::MIKOtaOffer;
using mikrojs::MIKOtaHookState;
using mikrojs::MIKOtaRoundHooks;
using mikrojs::MIKOtaWatchOptions;

#define MIK_OTA_CLIENT_TAG "native:mikro/ota_client"

namespace {

/* One in-flight check() and the promise waiting on it. */
struct PendingCheck {
    MIKPromise promise;
    bool settled = false;
};

/* One apply attempt, held open while the app's download callback runs. Staging
 * is a single native session, so there is at most one. */
struct PendingApply {
    MIKOtaApplySession session;
    MIKPromise promise;
    MIKOtaInstallOptions options;
    bool active = false;
};

struct MIKOtaClientState {
    JSContext* ctx = nullptr;
    const MIKOtaEnv* env = nullptr;
    PendingApply apply;
    std::unique_ptr<MIKOtaConfigReader> config;
    std::unique_ptr<MIKOtaClient> client;
    std::unique_ptr<MIKOtaJsHooks> hooks;
    /* The watcher's onConfig, held for the life of the watch. */
    JSValue on_config = JS_UNDEFINED;
    std::vector<std::unique_ptr<PendingCheck>> pending;
    bool watching = false;
};

int mik__ota_client_slot = -1;

inline MIKOtaClientState*& mik__ota_client_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKOtaClientState*&>(rt->module_data[mik__ota_client_slot]);
}

// ── result marshalling ───────────────────────────────────────────────────────

void set_error(JSContext* ctx, JSValue target, const mikrojs::MIKOtaError& error,
               int http_status) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "name",
                      JS_NewString(ctx, error.name.empty() ? "Network" : error.name.c_str()));
    if (!error.kind.empty()) {
        JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, error.kind.c_str()));
    }
    if (!error.message.empty()) {
        JS_SetPropertyStr(ctx, obj, "message", JS_NewString(ctx, error.message.c_str()));
    }
    if (error.name == "Status" && http_status != 0) {
        JS_SetPropertyStr(ctx, obj, "status", JS_NewInt32(ctx, http_status));
    }
    JS_SetPropertyStr(ctx, target, "error", obj);
}

JSValue result_to_js(JSContext* ctx, const MIKOtaCheckResult& result) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "status",
                      JS_NewString(ctx, mikrojs::mik__ota_check_status_to_str(result.status)));
    switch (result.status) {
        case MIKOtaCheckStatus::kStaged: {
            JSValue offer = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, offer, "url", JS_NewString(ctx, result.offer.url.c_str()));
            JS_SetPropertyStr(ctx, offer, "checksum",
                              JS_NewString(ctx, result.offer.checksum.c_str()));
            JS_SetPropertyStr(ctx, offer, "size", JS_NewInt64(ctx, (int64_t)result.offer.size));
            JS_SetPropertyStr(ctx, obj, "offer", offer);
            break;
        }
        case MIKOtaCheckStatus::kUpToDate:
            /* Omitted rather than false when nothing changed, matching the JS
             * client: the key's presence is the signal. */
            if (result.config_updated) {
                JS_SetPropertyStr(ctx, obj, "configUpdated", JS_TRUE);
            }
            break;
        case MIKOtaCheckStatus::kNotStaged:
            JS_SetPropertyStr(
                ctx, obj, "reason",
                JS_NewString(ctx, mikrojs::mik__ota_decline_reason_to_str(result.decline_reason)));
            if (!result.error.name.empty()) set_error(ctx, obj, result.error, result.http_status);
            break;
        case MIKOtaCheckStatus::kFailed:
            set_error(ctx, obj, result.error, result.http_status);
            break;
        case MIKOtaCheckStatus::kUnauthorized:
        case MIKOtaCheckStatus::kNotEnrolled:
            break;
    }
    return obj;
}

// ── option marshalling ───────────────────────────────────────────────────────

uint32_t opt_u32(JSContext* ctx, JSValue options, const char* key, uint32_t fallback) {
    JSValue value = JS_GetPropertyStr(ctx, options, key);
    uint32_t out = fallback;
    if (JS_IsNumber(value)) {
        int64_t raw = 0;
        if (JS_ToInt64(ctx, &raw, value) == 0 && raw >= 0) out = (uint32_t)raw;
    }
    JS_FreeValue(ctx, value);
    return out;
}

bool opt_bool(JSContext* ctx, JSValue options, const char* key, bool fallback) {
    JSValue value = JS_GetPropertyStr(ctx, options, key);
    bool out = JS_IsUndefined(value) ? fallback : JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);
    return out;
}

void read_check_options(JSContext* ctx, JSValue options, MIKOtaCheckOptions* out) {
    if (!JS_IsObject(options)) return;
    out->checkin_timeout_ms = opt_u32(ctx, options, "checkinTimeoutMs", out->checkin_timeout_ms);
    out->download_timeout_ms = opt_u32(ctx, options, "downloadTimeoutMs", out->download_timeout_ms);
    out->require_confirm = opt_bool(ctx, options, "requireConfirm", out->require_confirm);
    out->trial_boots = (int)opt_u32(ctx, options, "trialBoots", (uint32_t)out->trial_boots);
}

// ── JS functions ─────────────────────────────────────────────────────────────

JSValue mik__ota_client_check(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    CHECK_NOT_NULL(state);

    MIKOtaCheckOptions options;
    if (argc > 0) read_check_options(ctx, argv[0], &options);

    auto pending = std::make_unique<PendingCheck>();
    JSValue promise = MIK_InitPromise(ctx, &pending->promise);
    if (JS_IsException(promise)) return JS_EXCEPTION;

    PendingCheck* slot = pending.get();
    state->pending.push_back(std::move(pending));

    state->client->Check(options, [state, slot](const MIKOtaCheckResult& result) {
        JSValue value = result_to_js(state->ctx, result);
        MIK_ResolvePromise(state->ctx, &slot->promise, 1, &value);
        slot->settled = true;
    });

    /* A not-enrolled device settles inline, before Check() returns. Reap it here
     * so the vector does not grow with every call on such a device. */
    for (size_t i = state->pending.size(); i > 0; i--) {
        if (state->pending[i - 1]->settled) state->pending.erase(state->pending.begin() + (i - 1));
    }
    return promise;
}

/* config() -> the effective config, or undefined. */
JSValue mik__ota_client_config(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    CHECK_NOT_NULL(state);
    return state->config->Read(ctx);
}

JSValue mik__ota_client_stop(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    if (state && state->client) state->client->StopWatch();
    return JS_UNDEFINED;
}

JSValue mik__ota_client_set_interval(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    if (!state || !state->client) return JS_UNDEFINED;
    int64_t interval = 0;
    if (argc < 1 || JS_ToInt64(ctx, &interval, argv[0]) < 0 || interval < 0) {
        return JS_ThrowTypeError(ctx, "setCheckinInterval(ms) needs a non-negative number");
    }
    state->client->SetCheckinInterval(static_cast<uint32_t>(interval));
    return JS_UNDEFINED;
}

JSValue mik__ota_client_watch(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    (void)this_val;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    CHECK_NOT_NULL(state);

    /* One watcher per runtime, and never a swap mid-round: replacing the hooks
     * would pull them out from under the round that is still running them, and
     * stop() only takes effect once that round finishes. */
    if (state->client && state->client->watching()) {
        return JS_ThrowTypeError(
            ctx, "ota.watch() is already running; call stop() on its watcher first");
    }
    if (state->client && state->client->state() != mikrojs::MIKOtaClientState::kIdle) {
        return JS_ThrowTypeError(
            ctx, "ota.watch(): the previous round is still finishing; try again shortly");
    }

    MIKOtaWatchOptions options;
    if (argc > 0 && JS_IsObject(argv[0])) {
        read_check_options(ctx, argv[0], &options);
        options.checkin_interval_ms =
            opt_u32(ctx, argv[0], "checkinIntervalMs", options.checkin_interval_ms);
        options.initial_delay_ms =
            opt_u32(ctx, argv[0], "initialDelayMs", options.initial_delay_ms);
        options.retry_after_failure_ms =
            opt_u32(ctx, argv[0], "retryAfterFailureMs", options.retry_after_failure_ms);
        options.jitter = opt_bool(ctx, argv[0], "jitter", options.jitter);

        JSValue before_check = JS_GetPropertyStr(ctx, argv[0], "beforeCheck");
        if (JS_IsFunction(ctx, before_check)) {
            state->hooks = std::make_unique<MIKOtaJsHooks>(ctx, before_check);
            options.hooks = state->hooks.get();
        } else {
            JS_FreeValue(ctx, before_check);
        }

        JS_FreeValue(ctx, state->on_config);
        state->on_config = JS_GetPropertyStr(ctx, argv[0], "onConfig");
        if (JS_IsFunction(ctx, state->on_config)) {
            /* Only when a round actually changed the stored document. A staged
             * release's config applies at its trial boot, not now, so it is not
             * a change the running app can read yet. */
            options.on_round = [state](const MIKOtaCheckResult& result) {
                if (!result.config_updated) return;
                JSValue config = state->config->Read(state->ctx);
                if (JS_IsException(config)) {
                    /* Nothing to hand over: a build with no readable manifest
                     * and no stored document has no config to report. */
                    JS_FreeValue(state->ctx, JS_GetException(state->ctx));
                    return;
                }
                JSValue ignored =
                    JS_Call(state->ctx, state->on_config, JS_UNDEFINED, 1, &config);
                if (JS_IsException(ignored)) mik_dump_error(state->ctx);
                JS_FreeValue(state->ctx, ignored);
                JS_FreeValue(state->ctx, config);
            };
        } else {
            JS_FreeValue(ctx, state->on_config);
            state->on_config = JS_UNDEFINED;
        }
    }

    state->client->Watch(options);
    state->watching = true;

    JSValue handle = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, handle, "stop",
                      JS_NewCFunction(ctx, mik__ota_client_stop, "stop", 0));
    JS_SetPropertyStr(
        ctx, handle, "setCheckinInterval",
        JS_NewCFunction(ctx, mik__ota_client_set_interval, "setCheckinInterval", 1));
    return handle;
}

// ── the policy surface (mikro/ota) ──────────────────────────────────────────
// Everything below marshals for functions that already exist in the portable
// policy. The only one with any machinery of its own is applyOffer, which has to
// hand the app's download callback a staging session and wait for it.

JSValue error_to_js(JSContext* ctx, const MIKOtaError& error) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "name",
                      JS_NewString(ctx, error.name.empty() ? "InstallFailed" : error.name.c_str()));
    if (!error.kind.empty()) {
        JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, error.kind.c_str()));
    }
    JS_SetPropertyStr(ctx, obj, "message", JS_NewString(ctx, error.message.c_str()));
    return obj;
}

MIKOtaClientState* state_of(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik_rt) return nullptr;
    return mik__ota_client_st(mik_rt);
}

JSValue kv_string_or_undefined(JSContext* ctx, const char* key) {
    MIKOtaClientState* state = state_of(ctx);
    if (!state || !state->env || !state->env->kv_get_str) return JS_UNDEFINED;
    char buf[256] = {};
    if (!state->env->kv_get_str(state->env->opaque, key, buf, sizeof(buf)) || buf[0] == '\0') {
        return JS_UNDEFINED;
    }
    return JS_NewString(ctx, buf);
}

/* reconcile() -> { installed?, reverted, lastInstall? } */
JSValue ota_reconcile(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);
    MIKOtaReconcileOutcome outcome = mikrojs::mik__ota_policy_reconcile(state->env);

    JSValue obj = JS_NewObject(ctx);
    if (outcome.installed[0]) {
        JS_SetPropertyStr(ctx, obj, "installed", JS_NewString(ctx, outcome.installed));
    }
    JS_SetPropertyStr(ctx, obj, "reverted", JS_NewBool(ctx, outcome.reverted));
    if (outcome.has_diagnostic) {
        JSValue diag = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, diag, "reason", JS_NewString(ctx, outcome.diagnostic.reason));
        if (outcome.diagnostic.detail[0]) {
            JS_SetPropertyStr(ctx, diag, "detail", JS_NewString(ctx, outcome.diagnostic.detail));
        }
        JS_SetPropertyStr(ctx, obj, "lastInstall", diag);
    }
    return obj;
}

/* running() -> { checksum?, version?, trial } */
JSValue ota_running(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);
    MIKOtaRunningBuild running = mikrojs::mik__ota_policy_running(state->env);

    JSValue obj = JS_NewObject(ctx);
    if (running.checksum[0]) {
        JS_SetPropertyStr(ctx, obj, "checksum", JS_NewString(ctx, running.checksum));
    }
    if (running.version[0]) {
        JS_SetPropertyStr(ctx, obj, "version", JS_NewString(ctx, running.version));
    }
    JS_SetPropertyStr(ctx, obj, "trial", JS_NewBool(ctx, running.trial));
    return obj;
}

JSValue ota_confirm(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);
    mikrojs::mik__ota_policy_confirm(state->env);
    return JS_UNDEFINED;
}

JSValue ota_revert(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);
    MIKOtaError error;
    if (!mikrojs::mik__ota_policy_revert(state->env, &error)) {
        return mik__result_err_obj(ctx, error_to_js(ctx, error));
    }
    return mik__result_ok_void(ctx);
}

JSValue ota_bearer(JSContext* ctx, JSValue, int, JSValue*) {
    return kv_string_or_undefined(ctx, "ota.updateKey");
}

JSValue ota_registry(JSContext* ctx, JSValue, int, JSValue*) {
    return kv_string_or_undefined(ctx, "ota.registry");
}

JSValue offer_to_js(JSContext* ctx, const MIKOtaOffer& offer) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "url", JS_NewString(ctx, offer.url.c_str()));
    JS_SetPropertyStr(ctx, obj, "checksum", JS_NewString(ctx, offer.checksum.c_str()));
    JS_SetPropertyStr(ctx, obj, "size", JS_NewInt64(ctx, static_cast<int64_t>(offer.size)));
    return obj;
}

/* parseOffer(raw, {allowInsecure}) -> Offer | undefined */
JSValue ota_parse_offer(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    bool allow_insecure = false;
    if (argc > 1 && JS_IsObject(argv[1])) {
        allow_insecure = opt_bool(ctx, argv[1], "allowInsecure", false);
    }
    MIKOtaOffer offer;
    if (!mikrojs::mik__ota_parse_offer_js(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, allow_insecure,
                                          &offer)) {
        return JS_UNDEFINED;
    }
    return offer_to_js(ctx, offer);
}

// ── applyOffer ──────────────────────────────────────────────────────────────

/* The staging session, as the download callback sees it. Recovered from the
 * module state rather than carried on the object: staging is a single native
 * session, so there is only ever one to find. */
JSValue update_write(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    MIKOtaClientState* state = state_of(ctx);
    if (!state || !state->apply.active || !state->apply.session.update) {
        return mik__result_err_named(ctx, "StagingFailed", "no staging session");
    }
    size_t len = 0;
    const uint8_t* data = argc > 0 ? JS_GetUint8Array(ctx, &len, argv[0]) : nullptr;
    if (!data) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return mik__result_err_named(ctx, "StagingFull", "bytes not a Uint8Array");
    }
    MIKOtaError error;
    if (!state->apply.session.update->write(data, len, &error)) {
        return mik__result_err_obj(ctx, error_to_js(ctx, error));
    }
    return mik__result_ok_void(ctx);
}

JSValue update_finish(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    MIKOtaClientState* state = state_of(ctx);
    if (!state || !state->apply.active || !state->apply.session.update) {
        return mik__result_err_named(ctx, "StagingFailed", "no staging session");
    }
    MIKOtaInstallOptions options = state->apply.options;
    if (argc > 0 && JS_IsObject(argv[0])) {
        options.trial_boots =
            (int)opt_u32(ctx, argv[0], "trialBoots", (uint32_t)options.trial_boots);
        options.require_confirm = opt_bool(ctx, argv[0], "requireConfirm", options.require_confirm);
    }
    MIKOtaError error;
    if (!state->apply.session.update->finish(options, &error)) {
        return mik__result_err_obj(ctx, error_to_js(ctx, error));
    }
    return mik__result_ok_void(ctx);
}

JSValue update_abort(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    if (state && state->apply.active && state->apply.session.update) {
        state->apply.session.update->abort();
    }
    return JS_UNDEFINED;
}

JSValue make_update_object(JSContext* ctx, size_t resume_offset) {
    JSValue update = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, update, "resumeOffset",
                      JS_NewInt64(ctx, static_cast<int64_t>(resume_offset)));
    JS_SetPropertyStr(ctx, update, "write", JS_NewCFunction(ctx, update_write, "write", 1));
    JS_SetPropertyStr(ctx, update, "finish", JS_NewCFunction(ctx, update_finish, "finish", 1));
    JS_SetPropertyStr(ctx, update, "abort", JS_NewCFunction(ctx, update_abort, "abort", 0));
    return update;
}

/* Close the attempt and settle applyOffer's promise. */
void settle_apply(JSContext* ctx, bool downloaded, const std::string& message) {
    MIKOtaClientState* state = state_of(ctx);
    if (!state || !state->apply.active) return;

    MIKOtaApplyOutcome outcome = MIKOtaApplyOutcome::kStaged;
    MIKOtaError error;
    bool ok = mikrojs::mik__ota_policy_apply_end(&state->apply.session, downloaded, message,
                                                 state->apply.options, &outcome, &error);
    JSValue result = ok ? mik__result_ok(ctx, JS_NewString(ctx, mikrojs::mik__ota_outcome_to_str(
                                                                    outcome)))
                        : mik__result_err_obj(ctx, error_to_js(ctx, error));
    state->apply.active = false;
    MIK_ResolvePromise(ctx, &state->apply.promise, 1, &result);
}

JSValue download_fulfilled(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    /* The callback's contract is Result<void, {message}>: a rejected download is
     * transient, so the message is all that survives into DownloadFailed. */
    bool downloaded = false;
    std::string message = "download failed";
    if (argc > 0 && JS_IsObject(argv[0])) {
        JSValue ok = JS_GetPropertyStr(ctx, argv[0], "ok");
        downloaded = JS_ToBool(ctx, ok);
        JS_FreeValue(ctx, ok);
        if (!downloaded) {
            JSValue error = JS_GetPropertyStr(ctx, argv[0], "error");
            JSValue msg = JS_GetPropertyStr(ctx, error, "message");
            const char* text = JS_ToCString(ctx, msg);
            if (text) {
                message = text;
                JS_FreeCString(ctx, text);
            }
            JS_FreeValue(ctx, msg);
            JS_FreeValue(ctx, error);
        }
    }
    settle_apply(ctx, downloaded, message);
    return JS_UNDEFINED;
}

JSValue download_rejected(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    std::string message = "download threw";
    if (argc > 0) {
        const char* text = JS_ToCString(ctx, argv[0]);
        if (text) {
            message = text;
            JS_FreeCString(ctx, text);
        }
    }
    settle_apply(ctx, false, message);
    return JS_UNDEFINED;
}

/* applyOffer(offer, download, options?) -> Promise<Result<ApplyOutcome, OtaError>> */
JSValue ota_apply_offer(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);
    if (argc < 2 || !JS_IsFunction(ctx, argv[1])) {
        return JS_ThrowTypeError(ctx, "applyOffer(offer, download) needs a download function");
    }
    if (state->apply.active) {
        JSValue busy = mik__result_err_named(ctx, "StagingFailed", "an update is already staging");
        return MIK_NewResolvedPromise(ctx, 1, &busy);
    }

    MIKOtaOffer offer;
    if (!mikrojs::mik__ota_parse_offer_js(ctx, argv[0], /*allow_insecure=*/true, &offer)) {
        JSValue bad = mik__result_err_named(ctx, "StagingFailed", "offer is not usable");
        return MIK_NewResolvedPromise(ctx, 1, &bad);
    }

    MIKOtaInstallOptions options;
    if (argc > 2 && JS_IsObject(argv[2])) {
        options.trial_boots =
            (int)opt_u32(ctx, argv[2], "trialBoots", (uint32_t)options.trial_boots);
        options.require_confirm = opt_bool(ctx, argv[2], "requireConfirm", options.require_confirm);
        JSValue install = JS_GetPropertyStr(ctx, argv[2], "install");
        const char* mode = JS_IsString(install) ? JS_ToCString(ctx, install) : nullptr;
        options.install_now = mode && strcmp(mode, "now") == 0;
        if (mode) JS_FreeCString(ctx, mode);
        JS_FreeValue(ctx, install);
    }

    MIKOtaApplyOutcome outcome = MIKOtaApplyOutcome::kStaged;
    MIKOtaError error;
    if (!mikrojs::mik__ota_policy_apply_begin(state->env, offer, &state->apply.session, &outcome,
                                              &error)) {
        JSValue failed = mik__result_err_obj(ctx, error_to_js(ctx, error));
        return MIK_NewResolvedPromise(ctx, 1, &failed);
    }
    if (!state->apply.session.update) {
        /* Declined before staging: trial pending, current, abandoned, exhausted. */
        JSValue declined =
            mik__result_ok(ctx, JS_NewString(ctx, mikrojs::mik__ota_outcome_to_str(outcome)));
        return MIK_NewResolvedPromise(ctx, 1, &declined);
    }

    state->apply.options = options;
    state->apply.active = true;
    JSValue promise = MIK_InitPromise(ctx, &state->apply.promise);
    if (JS_IsException(promise)) {
        state->apply.active = false;
        state->apply.session.update.reset();
        return JS_EXCEPTION;
    }

    JSValue update = make_update_object(ctx, state->apply.session.update->resume_offset());
    JSValue returned = JS_Call(ctx, argv[1], JS_UNDEFINED, 1, &update);
    JS_FreeValue(ctx, update);

    if (JS_IsException(returned)) {
        JSValue exc = JS_GetException(ctx);
        const char* text = JS_ToCString(ctx, exc);
        std::string message = text ? text : "download threw";
        if (text) JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, returned);
        settle_apply(ctx, false, message);
        return promise;
    }

    /* The callback may hand back a plain Result rather than a promise — or
     * nothing, which is not a Result but must not throw on the way to being
     * reported as a failed download. */
    JSValue then = JS_IsObject(returned) ? JS_GetPropertyStr(ctx, returned, "then") : JS_UNDEFINED;
    if (!JS_IsFunction(ctx, then)) {
        JS_FreeValue(ctx, then);
        JSValue args[1] = {returned};
        JSValue ignored = download_fulfilled(ctx, JS_UNDEFINED, 1, args);
        JS_FreeValue(ctx, ignored);
        JS_FreeValue(ctx, returned);
        return promise;
    }
    JSValue on_ok = JS_NewCFunction(ctx, download_fulfilled, "onFulfilled", 1);
    JSValue on_err = JS_NewCFunction(ctx, download_rejected, "onRejected", 1);
    JSValue chain_args[2] = {on_ok, on_err};
    JSValue chained = JS_Call(ctx, then, returned, 2, chain_args);
    JS_FreeValue(ctx, chained);
    JS_FreeValue(ctx, on_ok);
    JS_FreeValue(ctx, on_err);
    JS_FreeValue(ctx, then);
    JS_FreeValue(ctx, returned);
    return promise;
}

// ── config delivery ─────────────────────────────────────────────────────────
//
// The write side of config sync, for a client that received a document over its
// own transport. Where the slot policy lives is src/mik_ota_config.cpp, shared
// with the built-in client, so the two cannot disagree about the trial or the
// rollback baseline. What is here is the marshalling.

/* Copy a string field into a fixed buffer. False when it is the wrong type or
 * too long to hold: a truncated rev never matches the one the registry issued,
 * so the device would be served the same document forever. */
bool take_config_field(JSContext* ctx, JSValue obj, const char* key, char* out, size_t out_len,
                       bool* out_present) {
    *out_present = false;
    JSValue value = JS_GetPropertyStr(ctx, obj, key);
    if (JS_IsUndefined(value) || JS_IsNull(value)) {
        JS_FreeValue(ctx, value);
        return true;
    }
    if (!JS_IsString(value)) {
        JS_FreeValue(ctx, value);
        return false;
    }
    const char* text = JS_ToCString(ctx, value);
    JS_FreeValue(ctx, value);
    if (!text) return false;
    bool fits = strlen(text) < out_len;
    if (fits) {
        snprintf(out, out_len, "%s", text);
        *out_present = text[0] != '\0';
    }
    JS_FreeCString(ctx, text);
    return fits;
}

/* Validate a raw value into the fields a stored config carries. `*out_doc` is
 * the document to store, or JS_UNDEFINED for the clear; the caller owns it. */
bool config_from_js(JSContext* ctx, JSValue raw, MIKOtaStoredConfig* out, JSValue* out_doc) {
    *out_doc = JS_UNDEFINED;
    if (!JS_IsObject(raw) || JS_IsArray(raw) || JS_IsFunction(ctx, raw)) return false;

    /* The stamp is what says which release the document was computed for, and
     * every read is decided by it. A document without one cannot be placed. */
    bool has_version = false;
    if (!take_config_field(ctx, raw, "version", out->version, sizeof(out->version),
                           &has_version)) {
        return false;
    }
    if (!has_version) return false;

    bool has_rev = false;
    if (!take_config_field(ctx, raw, "rev", out->rev, sizeof(out->rev), &has_rev)) return false;

    JSValue doc = JS_GetPropertyStr(ctx, raw, "doc");
    if (JS_IsUndefined(doc) || JS_IsNull(doc)) {
        /* An absent document is the clear, not a malformed config. */
        JS_FreeValue(ctx, doc);
        return true;
    }
    /* The document is spread over the manifest defaults, top level only.
     * Anything that is not a plain object has no keys to spread, so storing one
     * would read back as an empty overlay rather than as the error it is. */
    if (!JS_IsObject(doc) || JS_IsArray(doc) || JS_IsFunction(ctx, doc)) {
        JS_FreeValue(ctx, doc);
        return false;
    }
    *out_doc = doc;
    return true;
}

/* Encode a document to the CBOR the slots store. False for a value CBOR cannot
 * carry (a function, a cycle, past the depth limit). */
bool encode_config_doc(JSContext* ctx, JSValue doc, std::vector<uint8_t>* out) {
    /* Pass 1 sizes it against a zero-capacity buffer; the base pointer must be
     * non-null because a zero-length append still reaches memcpy. */
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    bool ok = mik__cbor_encode_value(ctx, &enc, doc, 0) >= 0;
    size_t needed = nanocbor_encoded_len(&enc);
    if (ok && needed > 0) {
        out->resize(needed);
        nanocbor_encoder_init(&enc, out->data(), needed);
        ok = mik__cbor_encode_value(ctx, &enc, doc, 0) >= 0;
    } else {
        ok = false;
    }
    /* Property enumeration can throw on the way out, and an exception left on
     * the context would surface at whatever ran next. */
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
    return ok;
}

/* parseConfig(raw) -> StoredConfig | undefined */
JSValue ota_parse_config(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    MIKOtaStoredConfig cfg = {};
    JSValue doc = JS_UNDEFINED;
    if (argc < 1 || !config_from_js(ctx, argv[0], &cfg, &doc)) {
        JS_FreeValue(ctx, doc);
        return JS_UNDEFINED;
    }
    JSValue obj = JS_NewObject(ctx);
    if (cfg.rev[0]) JS_SetPropertyStr(ctx, obj, "rev", JS_NewString(ctx, cfg.rev));
    JS_SetPropertyStr(ctx, obj, "version", JS_NewString(ctx, cfg.version));
    if (JS_IsUndefined(doc)) return obj;
    /* The document travels on as it arrived: whether it survives CBOR is
     * settled by applyConfig, which is where the bytes are actually made. */
    JS_SetPropertyStr(ctx, obj, "doc", doc);
    return obj;
}

/* applyConfig(cfg, {trialBoots}) -> ConfigWrite */
JSValue ota_apply_config(JSContext* ctx, JSValue, int argc, JSValue* argv) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);

    MIKOtaStoredConfig cfg = {};
    JSValue doc = JS_UNDEFINED;
    if (argc < 1 || !config_from_js(ctx, argv[0], &cfg, &doc)) {
        JS_FreeValue(ctx, doc);
        return JS_NewString(ctx, "invalid");
    }

    /* Held until the write is done: the stored config's span points into it. */
    std::vector<uint8_t> bytes;
    if (!JS_IsUndefined(doc)) {
        bool encoded = encode_config_doc(ctx, doc, &bytes);
        JS_FreeValue(ctx, doc);
        if (!encoded) return JS_NewString(ctx, "invalid");
        cfg.doc_cbor = bytes.data();
        cfg.doc_cbor_len = bytes.size();
    }

    MIKOtaCheckOptions defaults;
    int trial_boots = defaults.trial_boots;
    if (argc > 1 && JS_IsObject(argv[1])) {
        trial_boots = (int)opt_u32(ctx, argv[1], "trialBoots", (uint32_t)trial_boots);
    }
    /* A budget of zero would roll the document back on the first read that
     * serves it, which is never what an app meant by delivering one. */
    if (trial_boots < 1) trial_boots = 1;

    MIKOtaConfigWrite write = mikrojs::mik__ota_deliver_config(state->env, &cfg, trial_boots);
    return JS_NewString(ctx, mikrojs::mik__ota_config_write_to_str(write));
}

/* configState() -> {rev?, error?} */
JSValue ota_config_state(JSContext* ctx, JSValue, int, JSValue*) {
    MIKOtaClientState* state = state_of(ctx);
    CHECK_NOT_NULL(state);

    JSValue obj = JS_NewObject(ctx);
    MIKOtaConfigErrorReport report = {};
    bool has_error = mikrojs::mik__ota_load_config_error(state->env, &report);
    if (has_error) {
        JSValue error = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, error, "rev", JS_NewString(ctx, report.rev));
        JS_SetPropertyStr(ctx, error, "message", JS_NewString(ctx, report.message));
        JS_SetPropertyStr(ctx, obj, "error", error);
    }
    /* After a rollback the FAILED document's rev is the one to echo, not the
     * restored one's: echoed-equals-held is what stops the registry serving the
     * document that just failed, until an operator changes it. */
    mikrojs::MIKOtaLoadedConfig held = mikrojs::mik__ota_load_slot(state->env, MIK_OTA_CFG_CURRENT);
    const char* rev = has_error ? report.rev : (held.present ? held.cfg.rev : "");
    if (rev[0]) JS_SetPropertyStr(ctx, obj, "rev", JS_NewString(ctx, rev));
    return obj;
}

int mik__ota_client_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "check", JS_NewCFunction(ctx, mik__ota_client_check, "check", 1));
    JS_SetModuleExport(ctx, m, "watch", JS_NewCFunction(ctx, mik__ota_client_watch, "watch", 1));
    JS_SetModuleExport(ctx, m, "config", JS_NewCFunction(ctx, mik__ota_client_config, "config", 0));
    JS_SetModuleExport(ctx, m, "reconcile", JS_NewCFunction(ctx, ota_reconcile, "reconcile", 0));
    JS_SetModuleExport(ctx, m, "running", JS_NewCFunction(ctx, ota_running, "running", 0));
    JS_SetModuleExport(ctx, m, "confirm", JS_NewCFunction(ctx, ota_confirm, "confirm", 0));
    JS_SetModuleExport(ctx, m, "revert", JS_NewCFunction(ctx, ota_revert, "revert", 0));
    JS_SetModuleExport(ctx, m, "bearer", JS_NewCFunction(ctx, ota_bearer, "bearer", 0));
    JS_SetModuleExport(ctx, m, "registry", JS_NewCFunction(ctx, ota_registry, "registry", 0));
    JS_SetModuleExport(ctx, m, "parseOffer",
                       JS_NewCFunction(ctx, ota_parse_offer, "parseOffer", 2));
    JS_SetModuleExport(ctx, m, "applyOffer",
                       JS_NewCFunction(ctx, ota_apply_offer, "applyOffer", 3));
    JS_SetModuleExport(ctx, m, "parseConfig",
                       JS_NewCFunction(ctx, ota_parse_config, "parseConfig", 1));
    JS_SetModuleExport(ctx, m, "applyConfig",
                       JS_NewCFunction(ctx, ota_apply_config, "applyConfig", 2));
    JS_SetModuleExport(ctx, m, "configState",
                       JS_NewCFunction(ctx, ota_config_state, "configState", 0));
    return 0;
}

}  // namespace

JSModuleDef* mik__ota_client_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (mik__ota_client_slot < 0) mik__ota_client_slot = MIK_ReserveModuleSlot();

    /* The bytecode version needs a context to derive (JS_WriteObject's first
     * byte), so it is read here and handed to the env, which has none. */
    size_t bc_len = 0;
    uint8_t* bc_buf = JS_WriteObject(ctx, &bc_len, JS_NULL, JS_WRITE_OBJ_BYTECODE);
    int bytecode_version = (bc_buf && bc_len > 0) ? bc_buf[0] : 0;
    if (bc_buf) js_free(ctx, bc_buf);

    auto* state = new MIKOtaClientState();
    state->ctx = ctx;
    /* The client drives HTTP from C and never imports native:mikro/http, so
     * nothing else would bring the transport up. */
    mik__http_ensure_native(ctx);

    const MIKOtaEnv* env = mik__ota_env_for(mik_rt, bytecode_version);
    state->env = env;
    state->config = std::make_unique<MIKOtaConfigReader>(env);
    state->client = std::make_unique<MIKOtaClient>(env);
    mik__ota_client_st(mik_rt) = state;

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/ota_client", mik__ota_client_module_init);
    if (!m) {
        /* The loop consumer is only registered when init returns a module. */
        delete state;
        mik__ota_client_st(mik_rt) = nullptr;
        return nullptr;
    }
    JS_AddModuleExport(ctx, m, "check");
    JS_AddModuleExport(ctx, m, "watch");
    JS_AddModuleExport(ctx, m, "config");
    JS_AddModuleExport(ctx, m, "reconcile");
    JS_AddModuleExport(ctx, m, "running");
    JS_AddModuleExport(ctx, m, "confirm");
    JS_AddModuleExport(ctx, m, "revert");
    JS_AddModuleExport(ctx, m, "bearer");
    JS_AddModuleExport(ctx, m, "registry");
    JS_AddModuleExport(ctx, m, "parseOffer");
    JS_AddModuleExport(ctx, m, "applyOffer");
    JS_AddModuleExport(ctx, m, "parseConfig");
    JS_AddModuleExport(ctx, m, "applyConfig");
    JS_AddModuleExport(ctx, m, "configState");
    return m;
}

void mik__ota_client_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    if (!state || !state->client) return;

    state->client->Poll();

    /* Drop settled checks. Done after Poll rather than inside the sink so the
     * vector is never mutated while the machine is walking it. */
    for (size_t i = state->pending.size(); i > 0; i--) {
        if (state->pending[i - 1]->settled) state->pending.erase(state->pending.begin() + (i - 1));
    }
}

void mik__ota_client_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKOtaClientState* state = mik__ota_client_st(mik_rt);
    if (!state) return;

    if (state->client) state->client->StopWatch();
    /* Anything still waiting will never settle: free the promise values so
     * teardown does not leave JSValues behind. */
    for (auto& pending : state->pending) {
        if (!pending->settled) MIK_FreePromise(ctx, &pending->promise);
    }
    state->pending.clear();
    /* The client before the hooks: a round parked in beforeCheck or teardown
     * still holds the hook pointer, and the client's teardown is what lets it
     * go. */
    if (state->apply.active) {
        /* Nothing will settle it now; free the promise's values rather than
         * leaving them behind. */
        MIK_FreePromise(ctx, &state->apply.promise);
        state->apply.active = false;
    }
    state->client.reset();
    state->hooks.reset();
    JS_FreeValue(ctx, state->on_config);
    state->on_config = JS_UNDEFINED;
    /* Before the runtime: the reader holds the last document it served. */
    state->config.reset();
    delete state;
    mik__ota_client_st(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(ota_client, "native:mikro/ota_client", mik__ota_client_init,
                    mik__ota_client_consume, mik__ota_client_destroy)

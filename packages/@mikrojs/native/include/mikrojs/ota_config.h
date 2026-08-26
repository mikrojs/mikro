#pragma once

/**
 * The `ota.config()` read.
 *
 * The effective config is the running build's manifest defaults with the stored
 * document spread over them, top level only: `{...defaults, ...doc}`. Every key
 * a document carries is a complete top-level value, computed and validated by
 * the registry that served it at check-in, so the device never validates and
 * never merges deeper than one level. A document stamped for a version other
 * than the one running is ignored, because it was computed against a different
 * release's schema.
 *
 * The writes deliver a document into those slots. The built-in check-in client
 * takes them from its response; an app running its own transport (`ota.parseConfig`
 * / `ota.applyConfig`) takes them from wherever its client got them. Both go
 * through here, so the two cannot disagree about the trial and the baseline.
 *
 * The read answers with an object or throws: there is no "no config yet" value.
 * A build that went through the tooling carries a manifest, the manifest
 * carries the defaults, and an app that declares no config schema gets an empty
 * object. The throw is reserved for a build with no readable manifest and
 * nothing stored, which is a build that never went through `mikro deploy`.
 */

#include <quickjs.h>

#include "mikrojs/ota_env.h"

namespace mikrojs {

class MIKOtaConfigReader {
public:
    explicit MIKOtaConfigReader(const MIKOtaEnv* env) : env_(env) {}
    ~MIKOtaConfigReader();
    MIKOtaConfigReader(const MIKOtaConfigReader&) = delete;
    MIKOtaConfigReader& operator=(const MIKOtaConfigReader&) = delete;

    /**
     * Read the effective config. The caller owns the returned value, a fresh
     * object on every call so an app that mutates what it got cannot reach the
     * cached defaults. JS_EXCEPTION means nothing could be served at all.
     *
     * A FAILED store read is not absence. The store can fail because reading it
     * allocates and heap pressure (a TLS handshake in flight) can starve it.
     * Treating that as "no document" flips a live device onto the defaults for a
     * beat, re-configuring its GPIO mid-handshake. A failed read serves whatever
     * the last successful read returned, for exactly as long as reads keep
     * failing; before the first success this runtime it serves the defaults
     * alone. A genuine clear removes the key and reads back as an honest
     * absence, so the two cases travel different channels and cannot be
     * confused.
     *
     * THE FIRST READ OF EACH BOOT THAT SERVES THE STORED DOCUMENT is also where
     * a running-release trial is accounted. A schema-valid document can still be
     * fatal to the app (a GPIO this board does not have), and a config-caused
     * crash can fire before the first check-in ever runs, but never before the
     * app reads the document that causes it, which makes the read the one hook a
     * crash loop cannot starve. Each such boot burns one trial boot; the budget
     * spent, the previous document is restored, the failure recorded for the
     * next check-in to report, and this very read returns the restored values,
     * which is what breaks the loop. A boot that never serves the document (the
     * store could not answer, the document is stamped for another version, its
     * bytes do not decode) leaves the trial untouched: recording that the app
     * read a document it never saw is what the accounting exists to prevent.
     */
    JSValue Read(JSContext* ctx);

private:
    /* The stored document for the running version, decoded, or JS_UNDEFINED
     * when there is none to serve. Sets *out_failed when the store could not
     * answer, which is not the same as having nothing stored. */
    JSValue LoadDoc(JSContext* ctx, bool* out_failed);
    /* Accounts this boot against a running-release trial. `serving_doc` says
     * whether this read returns the stored document, which is the only case a
     * trial boot may be charged to. False when the store could not answer, in
     * which case nothing was written and the whole block retries on the next
     * read. Sets *out_rolled_back when the budget was spent and the stored
     * document changed under the caller. */
    bool Account(bool serving_doc, bool* out_rolled_back);
    /* The manifest defaults, parsed once and held for the runtime's lifetime.
     * Borrowed: the caller must not free it. JS_UNDEFINED when the manifest
     * could not be read or parsed, which is retried on the next call. */
    JSValue Defaults(JSContext* ctx);
    /* What to serve when the store could not answer. */
    JSValue ServeFallback(JSContext* ctx);
    JSValue ServeLastGood(JSContext* ctx) const;
    void KeepLastGood(JSContext* ctx, JSValue value);

    const MIKOtaEnv* env_;
    /* Module state resets on every boot, so "once per boot" needs no clock. */
    bool accounted_ = false;
    bool has_last_good_ = false;
    JSValue last_good_ = JS_UNDEFINED;
    /* Held so the destructor can free last_good_ without being handed a ctx. */
    JSContext* last_good_ctx_ = nullptr;
    /* Cached on success only: a manifest that could not be read or parsed under
     * heap pressure must be retried, not remembered as "no defaults". */
    bool has_defaults_ = false;
    JSValue defaults_ = JS_UNDEFINED;
    /* The same, for the cached defaults. */
    JSContext* defaults_ctx_ = nullptr;
};

/* ── the writes ──────────────────────────────────────────────────────────── */

/* What a write did to the store.
 *
 * `kUnchanged` covers both "identical to what is already held" and "a clear
 * with nothing to clear": nothing moved, and the rev the device echoes is the
 * one it echoed before. `kFailed` is a store that could not answer, which is
 * not the same as nothing to do — the caller must not echo the new rev, so the
 * writer sends the document again. */
enum class MIKOtaConfigWrite {
    kUnchanged,
    kApplied,
    kCleared,
    kStaged,
    kFailed,
};

const char* mik__ota_config_write_to_str(MIKOtaConfigWrite write);

/* Deliver a document to the RUNNING release: the document it replaces becomes
 * the rollback baseline, and a trial of `trial_boots` is armed, because a
 * schema-valid value can still be fatal to the app. A NULL config, or one whose
 * doc is absent, is the clear. */
MIKOtaConfigWrite mik__ota_apply_running_config(const MIKOtaEnv* env,
                                                const MIKOtaStoredConfig* config,
                                                int trial_boots);

/* Stage a document alongside an offered build: it was computed for that
 * release, so it applies at its trial boot, with the build. A NULL config, or
 * one whose doc is absent, stages the clear: the new release holds no document
 * and its manifest defaults stand in. */
void mik__ota_stage_next_config(const MIKOtaEnv* env, const MIKOtaStoredConfig* config);

/* Deliver a document whose slot is not known from context, which is the case
 * for a client that receives one over its own transport: the version stamp
 * decides. Stamped for the running release it is applied, anything else is
 * staged for the build it names. */
MIKOtaConfigWrite mik__ota_deliver_config(const MIKOtaEnv* env, const MIKOtaStoredConfig* config,
                                          int trial_boots);

/* Settle a running-release trial on the health signal a completed check-in is.
 * Adopts only once the app has READ the document: a check-in completing before
 * the app ever ran with the new values proves nothing about them. Returns
 * whether a trial was settled. */
bool mik__ota_adopt_config_trial(const MIKOtaEnv* env);

}  // namespace mikrojs

#pragma once

/**
 * The `beforeCheck` hook, bridged from JS into the round machine.
 *
 * This is the one place the client re-enters JavaScript, and everything it
 * touches comes back from app code — so it lives here, in the portable library,
 * rather than in the firmware module. Nothing in it needs ESP-IDF, and every
 * bug it has had so far was a marshalling bug that only a device could show.
 */

#include <quickjs.h>

#include <cstdint>
#include <string>

#include "mikrojs/ota_client.h"

namespace mikrojs {

/**
 * What a hook may hand back, and what each shape means:
 *
 *   a function            the round runs, and this runs after it
 *   nothing               the round runs, with no teardown
 *   an `err` Result       the round is skipped and retried sooner
 *   an `ok` Result        as its value: a teardown function, or nothing
 *   a thrown exception    the round is skipped and retried sooner
 *
 * Anything else is taken as success with no teardown. A promise of any of the
 * above is awaited first.
 *
 * The bare-function form exists because wrapping every teardown in `ok()` is
 * ceremony on the path that always succeeds, while the Result form is what lets
 * a failing setup hand its own error straight back.
 */
class MIKOtaJsHooks : public MIKOtaRoundHooks {
public:
    /* Takes ownership of `before_check`, which may be undefined (no hook). */
    MIKOtaJsHooks(JSContext* ctx, JSValue before_check);
    ~MIKOtaJsHooks() override;
    MIKOtaJsHooks(const MIKOtaJsHooks&) = delete;
    MIKOtaJsHooks& operator=(const MIKOtaJsHooks&) = delete;

    bool BeginBeforeCheck() override;
    MIKOtaHookState PollBeforeCheck() override;
    bool BeginTeardown() override;
    MIKOtaHookState PollTeardown() override;

    /* True once beforeCheck has handed back a teardown to run. */
    bool has_teardown() const;

private:
    void Call(JSValue fn);
    /* Interpret a settled value from app code. */
    void Settle(JSValue value);
    static JSValue OnFulfilled(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv,
                               int magic, JSValue* func_data);

    JSContext* ctx_;
    JSValue before_check_;
    JSValue teardown_ = JS_UNDEFINED;
    MIKOtaHookState state_ = MIKOtaHookState::kOk;
    bool awaiting_before_check_ = false;
    /* Identifies this instance to a promise callback that outlives it. Never
     * reused, so a continuation from a destroyed hooks object cannot land on
     * whatever was allocated at the same address afterwards. */
    uint64_t id_;
};

}  // namespace mikrojs

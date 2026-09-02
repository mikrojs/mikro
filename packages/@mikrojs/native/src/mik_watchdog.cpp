#include <quickjs.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/* ── Watchdog: blocking deadline, feed deadline, awake budget ─────────
 *
 * All three measure wall time via get_boot_us(). The blocking deadline is
 * polled from the QuickJS interrupt handler (every 10k branches/calls);
 * feed and awake are checked once per MIK_Loop pass. State is per-runtime,
 * so the Node addon's parallel runtimes need no atomics. */


void mik__blocking_begin(MIKRuntime* mik_rt) {
    if (!mik_rt) return;
    mik_rt->blocking_start_us = 0;
    mik_rt->blocking_armed = true;
}

int mik__watchdog_interrupt(JSRuntime* rt, void* opaque) {
    (void)rt;
    MIKRuntime* mik_rt = static_cast<MIKRuntime*>(opaque);
    int budget_ms = mik_rt->config.blocking_timeout_ms;
    if (budget_ms <= 0 || !mik_rt->blocking_armed) {
        return 0;
    }
    int64_t now = MIK_GetPlatform()->get_boot_us();
    int64_t start = mik_rt->blocking_start_us;
    /* now < start: the boot clock reset (deep sleep, test platform swap). */
    if (start == 0 || now < start) {
        mik_rt->blocking_start_us = now;
        return 0;
    }
    if (now - start >= (int64_t)budget_ms * 1000) {
        /* One-shot: stay off while the error unwinds so finally blocks
         * and error-handler property reads are not interrupted too. */
        mik_rt->blocking_armed = false;
        mik_rt->blocking_tripped = true;
        /* The app could not feed while it was blocked; give it a fresh
         * window so a surviving session (REPL eval) is not hit twice. */
        mik_rt->feed_last_us = now;
        return 1;
    }
    return 0;
}

bool mik__watchdog_report_blocking(MIKRuntime* mik_rt) {
    if (!mik_rt || !mik_rt->blocking_tripped) {
        return false;
    }
    mik_rt->blocking_tripped = false;
    mik__print_error_line("[watchdog] WATCHDOG TRIGGERED: event loop blocking time exceeded "
                          "configured limit of %d ms",
                          mik_rt->config.blocking_timeout_ms);
    return true;
}

void mik__watchdog_arm(MIKRuntime* mik_rt) {
    const MIKPlatform* platform = MIK_GetPlatform();
    const MIKConfig* cfg = &mik_rt->config;
    mik__blocking_begin(mik_rt);
    mik_rt->feed_armed = cfg->feed_timeout_ms > 0;
    mik_rt->feed_last_us = platform->get_boot_us();
    mik_rt->awake_armed = cfg->awake_timeout_ms > 0;
    mik_rt->awake_pause_offset_us = 0;
    mik_rt->pause_start_us = 0;
    if (mik_rt->awake_armed && cfg->panic_mode != MIK_PANIC_DEEP_SLEEP) {
        /* Always visible: platform->log is silent on device by default. */
        mik__print_error_line("[watchdog] awake limit of %d ms without onPanic.mode 'deepSleep': "
                              "the device restarts every %d ms",
                              cfg->awake_timeout_ms, cfg->awake_timeout_ms);
    }
}

void mik__watchdog_check(MIKRuntime* mik_rt) {
    if (mik_rt->stop_requested || (!mik_rt->feed_armed && !mik_rt->awake_armed)) {
        return;
    }
    /* A pending exception (a blocking timeout, or any uncaught throw from the
     * entry) is about to be reported and stop the runtime. Firing feed or
     * awake on top of it would replace that exception and lose its trace. */
    if (JS_HasException(mik_rt->ctx)) {
        return;
    }
    const MIKPlatform* platform = MIK_GetPlatform();
    int64_t now = platform->get_boot_us();

    if (mik_rt->awake_armed) {
        int64_t elapsed_us = now - mik_rt->awake_pause_offset_us;
        if (elapsed_us >= (int64_t)mik_rt->config.awake_timeout_ms * 1000) {
            mik_rt->awake_armed = false;
            mik__print_error_line("[watchdog] WATCHDOG TRIGGERED: awake time exceeded configured "
                                  "limit of %d ms",
                                  mik_rt->config.awake_timeout_ms);
            /* No JS error: nothing to point a trace at, and this must not
             * reach the OTA trial error handler (a slow link is not a bug). */
            MIK_Stop(mik_rt);
            return;
        }
    }

    if (mik_rt->feed_armed) {
        if (now < mik_rt->feed_last_us) {
            mik_rt->feed_last_us = now;
        } else if (now - mik_rt->feed_last_us >= (int64_t)mik_rt->config.feed_timeout_ms * 1000) {
            mik_rt->feed_armed = false;
            mik__print_error_line("[watchdog] WATCHDOG TRIGGERED: time since last feed() exceeded "
                                  "configured limit of %d ms",
                                  mik_rt->config.feed_timeout_ms);
            /* No JS frame is active here, so uncatchable marking is moot: the
             * JS_HasException branch in MIK_Loop routes this before any user
             * code runs. */
            JS_ThrowInternalError(mik_rt->ctx,
                                  "watchdog: time since last feed() exceeded configured limit "
                                  "of %d ms",
                                  mik_rt->config.feed_timeout_ms);
        }
    }
}

void mik__watchdog_wake(MIKRuntime* mik_rt) {
    if (!mik_rt) return;
    mik__blocking_begin(mik_rt);
    /* The app could not feed while asleep; it gets a fresh window, as after
     * a pause. The awake clock keeps counting: light sleep is still uptime. */
    mik_rt->feed_last_us = MIK_GetPlatform()->get_boot_us();
}

void mik__watchdog_pause_begin(MIKRuntime* mik_rt) {
    if (!mik_rt || mik_rt->pause_start_us != 0) return;
    mik_rt->pause_start_us = MIK_GetPlatform()->get_boot_us();
}

void mik__watchdog_pause_end(MIKRuntime* mik_rt) {
    if (!mik_rt || mik_rt->pause_start_us == 0) return;
    int64_t now = MIK_GetPlatform()->get_boot_us();
    if (now > mik_rt->pause_start_us) {
        mik_rt->awake_pause_offset_us += now - mik_rt->pause_start_us;
    }
    mik_rt->pause_start_us = 0;
    /* The app could not feed while suspended; it gets a fresh budget. */
    mik_rt->feed_last_us = now;
}

/* ── native:mikro/watchdog ──────────────────────────────────────────── */

static JSValue mik__watchdog_feed(JSContext* ctx, JSValueConst this_val, int argc,
                                  JSValueConst* argv) {
    (void)this_val;
    (void)argc;
    (void)argv;
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt && mik_rt->feed_armed) {
        mik_rt->feed_last_us = MIK_GetPlatform()->get_boot_us();
    }
    return JS_UNDEFINED;
}

static int mik__watchdog_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "feed", JS_NewCFunction(ctx, mik__watchdog_feed, "feed", 0));
    return 0;
}

void mik__watchdog_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/watchdog", mik__watchdog_module_init);
    if (!m) return;
    JS_AddModuleExport(ctx, m, "feed");
}

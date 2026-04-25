#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <mikrojs/utils.h>

#include <algorithm>

#include "quickjs.h"

#define MAX_SAFE_INTEGER (((uint32_t)1 << 31) - 1)

uint32_t MIK_Timer_Schedule(MIKTimers* timers, JSContext* ctx, const JSValue func, const int argc,
                            const JSValue* argv, const int64_t timeout, const bool is_interval,
                            const int64_t now = MIK_GetPlatform()->get_boot_us()) {
    auto timer_id = timers->next_timer_id++;

    if (timer_id > MAX_SAFE_INTEGER)
        timer_id = 1;

    const int64_t next_deadline = now + timeout;

    auto entry = MIKTimerEntry{
        timer_id, is_interval, timeout, next_deadline, JS_DupValue(ctx, func), argc, {},
    };

    for (int i = 0; i < argc; i++) {
        entry.argv[i] = JS_DupValue(ctx, argv[i]);
    }

    timers->entries.push_back(entry);
    return entry.id;
}

bool MIK_Timer_UnSchedule(MIKTimers* timers, JSContext* ctx, uint32_t id) {
    auto it = std::find_if(timers->entries.begin(), timers->entries.end(),
                           [id](const MIKTimerEntry& e) { return e.id == id; });
    if (it != timers->entries.end()) {
        JS_FreeValue(ctx, it->func);
        for (int i = 0; i < it->argc; i++) JS_FreeValue(ctx, it->argv[i]);
        timers->entries.erase(it);  // remove the element
        return true;
    }

    return false;
}

size_t MIK_Timer_CountDue(MIKTimers* timers, int64_t now) {
    size_t count = 0;
    for (const auto& entry : timers->entries) {
        if (entry.next_deadline <= now) {
            count++;
        }
    }
    return count;
}

void MIK_Timer_SetNextDeadline(MIKTimers* timers, uint32_t id, int64_t next_deadline) {
    for (auto& timer : timers->entries) {
        if (timer.id == id) {
            timer.next_deadline = next_deadline;
            return;
        }
    }
}

void MIK_Timer_ClearAll(MIKTimers* timers, JSContext* ctx) {
    while (!timers->entries.empty()) {
        auto& entry = timers->entries.back();
        JS_FreeValue(ctx, entry.func);
        for (int i = 0; i < entry.argc; i++) JS_FreeValue(ctx, entry.argv[i]);
        timers->entries.pop_back();
    }
}

MIKTimerRegistry* MIK_NewTimerRegistry() {
    auto* timers = new MIKTimerRegistry();
    timers->entries.reserve(MIK_MAX_DUE_TIMERS);
    return timers;
}

static JSValue mik__timer_set(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                              int magic) {
    MIKRuntime* mik_runtime = static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
    CHECK_NOT_NULL(mik_runtime);

    int64_t delay;
    JSValue func;

    func = argv[0];
    if (!JS_IsFunction(ctx, func)) {
        return JS_ThrowTypeError(ctx, "not a function");
    }

    if (argc <= 1) {
        delay = 0;
    } else if (JS_ToInt64(ctx, &delay, argv[1])) {
        return JS_EXCEPTION;
    }

    int nargs = argc - 2;
    if (nargs < 0) {
        nargs = 0;
    }
    if (nargs > MIK_TIMER_MAX_ARGS) {
        return JS_ThrowRangeError(ctx, "too many arguments for setTimeout/setInterval (max %d)",
                                  MIK_TIMER_MAX_ARGS);
    }

    uint32_t id = MIK_Timer_Schedule(mik_runtime->timers, mik_runtime->ctx, func, nargs,
                                     argv + 2, delay * 1000, magic);

    return JS_NewInt32(ctx, id);
}

static JSValue mik__timer_clear(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_runtime = static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
    CHECK_NOT_NULL(mik_runtime);
    int64_t timer_id;

    if (JS_ToInt64(ctx, &timer_id, argv[0])) {
        return JS_EXCEPTION;
    }

    MIK_Timer_UnSchedule(mik_runtime->timers, mik_runtime->ctx, timer_id);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry mik_timer_funcs[] = {
    JS_CFUNC_MAGIC_DEF("setTimeout", 2, mik__timer_set, 0),
    MIK_CFUNC_DEF("clearTimeout", 1, mik__timer_clear),
    JS_CFUNC_MAGIC_DEF("setInterval", 2, mik__timer_set, 1),
    MIK_CFUNC_DEF("clearInterval", 1, mik__timer_clear)};

void mik__timers_init(JSContext* ctx, JSValue ns) {
    JS_SetPropertyFunctionList(ctx, ns, mik_timer_funcs, countof(mik_timer_funcs));
}

void mik__timers_destroy(JSContext* ctx) {
    const MIKRuntime* mik_rt = static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
    MIK_Timer_ClearAll(mik_rt->timers, mik_rt->ctx);
}

void mik__timers_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
    auto* timers = mik_rt->timers;
    const MIKPlatform* platform = MIK_GetPlatform();
    int64_t now = platform->get_boot_us();

    // Collect IDs of due timers into a small stack buffer to avoid heap allocation.
    // This lets us safely iterate even if callbacks add/remove timers.
    uint32_t due_ids[MIK_MAX_DUE_TIMERS];
    size_t due_count = 0;

    for (auto& entry : timers->entries) {
        if (entry.next_deadline <= now) {
            if (due_count < MIK_MAX_DUE_TIMERS) {
                due_ids[due_count++] = entry.id;
            }
            // Update interval deadlines before executing callbacks
            if (entry.is_interval) {
                entry.next_deadline = entry.timeout + platform->get_boot_us();
            }
        }
    }

    if (due_count == 0)
        return;

    for (size_t i = 0; i < due_count; i++) {
        // Re-find the entry — a previous callback may have cleared it
        auto it = std::find_if(timers->entries.begin(), timers->entries.end(),
                               [&](const MIKTimerEntry& e) { return e.id == due_ids[i]; });
        if (it == timers->entries.end())
            continue;

        // Dup the function and args before calling — the callback may call
        // clearInterval which frees the entry (and its JSValues) mid-call.
        JSValue func = JS_DupValue(mik_rt->ctx, it->func);
        int nargs = it->argc;
        JSValue args[MIK_TIMER_MAX_ARGS];
        for (int j = 0; j < nargs; j++) {
            args[j] = JS_DupValue(mik_rt->ctx, it->argv[j]);
        }

        JSValue ret = JS_Call(mik_rt->ctx, func, JS_UNDEFINED, nargs, args);
        if (JS_IsException(ret)) {
            if (mik_rt->error_handler_fn && JS_HasException(mik_rt->ctx)) {
                JSValue exc = JS_GetException(mik_rt->ctx);
                mik_rt->error_handler_fn(mik_rt->ctx, exc, mik_rt->error_handler_opaque);
                JS_Throw(mik_rt->ctx, exc);
            }
            mik_dump_error(mik_rt->ctx);
        }
        JS_FreeValue(mik_rt->ctx, ret);
        JS_FreeValue(mik_rt->ctx, func);
        for (int j = 0; j < nargs; j++) {
            JS_FreeValue(mik_rt->ctx, args[j]);
        }
    }

    // Remove one-shot timers that are still alive (not already cleared by a callback)
    for (size_t i = 0; i < due_count; i++) {
        auto it = std::find_if(timers->entries.begin(), timers->entries.end(),
                               [&](const MIKTimerEntry& e) { return e.id == due_ids[i]; });
        if (it != timers->entries.end() && !it->is_interval) {
            MIK_Timer_UnSchedule(timers, mik_rt->ctx, due_ids[i]);
        }
    }
}

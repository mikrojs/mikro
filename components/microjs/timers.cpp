#include <esp_timer.h>
#include <private.h>
#include <utils.h>

#include <algorithm>
#include <vector>

#include "quickjs.h"

#define MAX_SAFE_INTEGER (((uint32_t)1 << 31) - 1)

uint32_t UJS_Timer_Schedule(UJSTimers* timers, JSContext* ctx, const JSValue func, const int argc,
                            const JSValue* argv, const uint32_t timeout, const bool is_interval,
                            const uint32_t now = esp_timer_get_time()) {
    auto timer_id = timers->next_timer_id++;

    if (timer_id > MAX_SAFE_INTEGER)
        timer_id = 1;

    const uint32_t next_deadline = now + timeout;

    auto entry = UJSTimerEntry{
        timer_id, is_interval, timeout, next_deadline, JS_DupValue(ctx, func), argc,
    };

    for (int i = 0; i < argc; i++) {
        entry.argv[i] = JS_DupValue(ctx, argv[i]);
    }

    timers->entries.push_back(entry);
    return entry.id;
}

bool UJS_Timer_UnSchedule(UJSTimers* timers, JSContext* ctx, uint32_t id) {
    auto it = std::find_if(timers->entries.begin(), timers->entries.end(), [id](UJSTimerEntry it) {
        return it.id == id;
    });
    if (it != timers->entries.end()) {
        JS_FreeValue(ctx, it->func);
        for (int i = 0; i < it->argc; i++) JS_FreeValue(ctx, it->argv[i]);
        timers->entries.erase(it);  // remove the element
        return true;
    }

    return false;
}

std::vector<UJSTimerEntry> UJS_Timer_GetDueTimers(UJSTimers* timers, uint32_t now) {
    std::vector<UJSTimerEntry> due;
    for (auto timer : timers->entries) {
        if (timer.next_deadline <= now) {
            due.push_back(timer);
        }
    }
    return due;
}

void UJS_Timer_SetNextDeadline(UJSTimers* timers, uint32_t id, uint32_t next_deadline) {
    for (auto timer : timers->entries) {
        if (timer.id == id) {
            timer.next_deadline = next_deadline;
            return;
        }
    }
}

void UJS_Timer_ClearAll(UJSTimers* timers, JSContext* ctx) {
    // Collect ages in a new vector
    std::vector<uint32_t> ids;
    for (const auto& entry : timers->entries) {
        ids.push_back(entry.id);
    }
    for (const auto& id : ids) {
        UJS_Timer_UnSchedule(timers, ctx, id);
    }
}

UJSTimerRegistry* UJS_NewTimerRegistry() { return new UJSTimerRegistry(); }

static JSValue ujs_setTimeout(JSContext* ctx, JSValue this_val, int argc, JSValue* argv,
                              int magic) {
    UJSRuntime* ujs_runtime = static_cast<UJSRuntime*>(JS_GetContextOpaque(ctx));
    CHECK_NOT_NULL(ujs_runtime);

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

    uint32_t id =
        UJS_Timer_Schedule(ujs_runtime->timers, ujs_runtime->ctx, func, nargs, argv, delay, magic);

    return JS_NewInt32(ctx, id);
}

static JSValue ujs_clearTimeout(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UJSRuntime* ujs_runtime = static_cast<UJSRuntime*>(JS_GetContextOpaque(ctx));
    CHECK_NOT_NULL(ujs_runtime);
    int64_t timer_id;

    if (JS_ToInt64(ctx, &timer_id, argv[0])) {
        return JS_EXCEPTION;
    }

    UJS_Timer_UnSchedule(ujs_runtime->timers, ujs_runtime->ctx, timer_id);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry ujs_timer_funcs[] = {
    JS_CFUNC_MAGIC_DEF("setTimeout", 2, ujs_setTimeout, 0),
    UJS_CFUNC_DEF("clearTimeout", 1, ujs_clearTimeout),
    JS_CFUNC_MAGIC_DEF("setInterval", 2, ujs_setTimeout, 1),
    UJS_CFUNC_DEF("clearInterval", 1, ujs_clearTimeout)};

void ujs__timers_init(JSContext* ctx, JSValue ns) {
    JS_SetPropertyFunctionList(ctx, ns, ujs_timer_funcs, countof(ujs_timer_funcs));
}

void ujs__timers_destroy(JSContext* ctx) {
    const UJSRuntime* ujs_rt = static_cast<UJSRuntime*>(JS_GetContextOpaque(ctx));
    UJS_Timer_ClearAll(ujs_rt->timers, ujs_rt->ctx);
}

void ujs__timers_consume(JSContext* ctx) {
    UJSRuntime* ujs_rt = static_cast<UJSRuntime*>(JS_GetContextOpaque(ctx));
    auto* timers = ujs_rt->timers;
    std::vector<UJSTimerEntry> dueTimers = UJS_Timer_GetDueTimers(timers, esp_timer_get_time());

    if (dueTimers.empty())
        return;

    for (auto const timer : dueTimers) {
        if (timer.is_interval) {
            UJS_Timer_SetNextDeadline(timers, timer.id, timer.timeout + esp_timer_get_time());
        }
    }

    for (auto timer : dueTimers) {
        JSValue ret = JS_Call(ujs_rt->ctx, timer.func, JS_UNDEFINED, timer.argc, timer.argv);
        if (JS_IsException(ret)) {
            // todo: throw error
            // Serial.println(format_error(ctx, error_from_exception(ctx)));
        }
        JS_FreeValue(ujs_rt->ctx, ret);
    }

    for (auto const timer : dueTimers) {
        if (!timer.is_interval) {
            // remove one-shot timers
            UJS_Timer_UnSchedule(timers, ujs_rt->ctx, timer.id);
        }
    }

    dueTimers.clear();
}

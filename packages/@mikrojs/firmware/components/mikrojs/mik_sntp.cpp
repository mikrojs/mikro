#include <cstring>
#include <ctime>
#include <sys/time.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#define MIK_SNTP_TAG "native:sntp"
#define MIK_SNTP_MAX_SERVERS 3

/* ── SNTP state (attached to MIKRuntime) ───────────────────────────── */

struct MIKSntpState {
    QueueHandle_t event_queue;
    MIKPromise sync_promise;
    bool sync_pending;
    bool running;
    bool background;
};

/* Dynamic module data slot, allocated on first import */
static int mik__sntp_slot = -1;

static inline MIKSntpState*& mik__sntp_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKSntpState*&>(rt->module_data[mik__sntp_slot]);
}

/* Global queue pointer for the sync callback (runs in lwIP timer task) */
static QueueHandle_t s_event_queue = nullptr;

/* ── SNTP sync callback ────────────────────────────────────────────── */

static void mik__sntp_sync_cb(struct timeval* tv) {
    if (!s_event_queue) return;
    struct timeval evt = *tv;
    xQueueSend(s_event_queue, &evt, 0);
}

/* ── Test helper: inject a fake sync event ─────────────────────────── */

void mik__sntp_inject_sync(int64_t epoch_sec) {
    if (!s_event_queue) return;
    struct timeval tv = {.tv_sec = static_cast<time_t>(epoch_sec), .tv_usec = 0};
    xQueueSend(s_event_queue, &tv, 0);
}

/* ── JS functions ──────────────────────────────────────────────────── */

static JSValue mik__sntp_sync(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKSntpState* state = mik__sntp_st(mik_rt);
    CHECK_NOT_NULL(state);

    /* arg 0: servers (array of strings) */
    /* arg 1: timezone (string) */
    /* arg 2: background (bool) */

    if (!JS_IsArray(argv[0])) {
        return JS_ThrowTypeError(ctx, "expected servers to be an array");
    }

    /* Extract server strings */
    JSValue len_val = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t server_count = 0;
    JS_ToInt32(ctx, &server_count, len_val);
    JS_FreeValue(ctx, len_val);

    if (server_count <= 0 || server_count > MIK_SNTP_MAX_SERVERS) {
        return JS_ThrowRangeError(ctx, "expected 1-%d servers, got %d", MIK_SNTP_MAX_SERVERS,
                                  server_count);
    }

    const char* servers[MIK_SNTP_MAX_SERVERS] = {};
    for (int32_t i = 0; i < server_count; i++) {
        JSValue elem = JS_GetPropertyUint32(ctx, argv[0], i);
        servers[i] = JS_ToCString(ctx, elem);
        JS_FreeValue(ctx, elem);
        if (!servers[i]) {
            for (int32_t j = 0; j < i; j++) JS_FreeCString(ctx, servers[j]);
            return JS_EXCEPTION;
        }
    }

    /* Set timezone */
    const char* tz = JS_ToCString(ctx, argv[1]);
    if (!tz) {
        for (int32_t i = 0; i < server_count; i++) JS_FreeCString(ctx, servers[i]);
        return JS_EXCEPTION;
    }
    setenv("TZ", tz, 1);
    tzset();
    JS_FreeCString(ctx, tz);

    bool background = JS_ToBool(ctx, argv[2]);

    /* If already running, tear down first */
    if (state->running) {
        if (state->sync_pending) {
            JSValue cancel_err = mik__result_err_tag(ctx, "Cancelled");
            MIK_ResolvePromise(ctx, &state->sync_promise, 1, &cancel_err);
            state->sync_pending = false;
        }
        esp_netif_sntp_deinit();
        state->running = false;

        /* Drain queue */
        struct timeval discard;
        while (xQueueReceive(state->event_queue, &discard, 0) == pdTRUE) {
        }
    }

    /* Configure SNTP */
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(servers[0]);
    config.sync_cb = mik__sntp_sync_cb;

    /* Add additional servers if provided */
    if (server_count > 1) {
        config.num_of_servers = server_count;
        /* The first server is already set by the macro. Set additional ones after init. */
    }

    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK) {
        for (int32_t i = 0; i < server_count; i++) JS_FreeCString(ctx, servers[i]);
        return mik__result_err_named(ctx, "InitFailed",
                                     "SNTP init failed: %s", esp_err_to_name(err));
    }

    /* Set additional servers (index 1+) */
    for (int32_t i = 1; i < server_count; i++) {
        esp_sntp_setservername(i, servers[i]);
    }

    for (int32_t i = 0; i < server_count; i++) JS_FreeCString(ctx, servers[i]);

    state->running = true;
    state->background = background;

    /* Create and return promise wrapped in result */
    JSValue promise = MIK_InitPromise(ctx, &state->sync_promise);
    state->sync_pending = true;

    return mik__result_ok(ctx, promise);
}

static JSValue mik__sntp_stop(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    MIKSntpState* state = mik__sntp_st(mik_rt);
    CHECK_NOT_NULL(state);

    if (state->running) {
        esp_netif_sntp_deinit();
        state->running = false;
    }

    return JS_UNDEFINED;
}

static JSValue mik__sntp_set_timezone(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* tz = JS_ToCString(ctx, argv[0]);
    if (!tz) return JS_EXCEPTION;
    setenv("TZ", tz, 1);
    tzset();
    JS_FreeCString(ctx, tz);
    return JS_UNDEFINED;
}

/* ── Module init ───────────────────────────────────────────────────── */

static int mik__sntp_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "sync", JS_NewCFunction(ctx, mik__sntp_sync, "sync", 3));
    JS_SetModuleExport(ctx, m, "stop", JS_NewCFunction(ctx, mik__sntp_stop, "stop", 0));
    JS_SetModuleExport(ctx, m, "setTimezone",
                       JS_NewCFunction(ctx, mik__sntp_set_timezone, "setTimezone", 1));
    return 0;
}

/* ── Public API ────────────────────────────────────────────────────── */

static JSModuleDef* mik__sntp_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    mik__sntp_slot = MIK_AllocModuleSlot(mik_rt);

    auto* state = new MIKSntpState();
    state->event_queue = xQueueCreate(4, sizeof(struct timeval));
    CHECK_NOT_NULL(state->event_queue);
    state->sync_pending = false;
    state->running = false;
    state->background = false;

    s_event_queue = state->event_queue;
    mik__sntp_st(mik_rt) = state;

    JSModuleDef* m = JS_NewCModule(ctx, "native:sntp", mik__sntp_module_init);
    if (!m) {
        /* The loop consumer (mik__sntp_destroy) is only registered when init
         * returns a non-null module (see modules.cpp). Clean up manually. */
        s_event_queue = nullptr;
        vQueueDelete(state->event_queue);
        delete state;
        mik__sntp_st(mik_rt) = nullptr;
        return nullptr;
    }
    JS_AddModuleExport(ctx, m, "sync");
    JS_AddModuleExport(ctx, m, "stop");
    JS_AddModuleExport(ctx, m, "setTimezone");
    return m;
}

void mik__sntp_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__sntp_st(mik_rt)) return;

    MIKSntpState* state = mik__sntp_st(mik_rt);
    struct timeval tv;

    while (xQueueReceive(state->event_queue, &tv, 0) == pdTRUE) {
        if (state->sync_pending) {
            /* Build result object: { time: <milliseconds since epoch> } */
            double time_ms =
                static_cast<double>(tv.tv_sec) * 1000.0 + static_cast<double>(tv.tv_usec) / 1000.0;
            JSValue time_obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, time_obj, "time", JS_NewFloat64(ctx, time_ms));
            JSValue result = mik__result_ok(ctx, time_obj);

            MIK_ResolvePromise(ctx, &state->sync_promise, 1, &result);
            state->sync_pending = false;

            /* If not background mode, stop SNTP after first sync */
            if (!state->background) {
                esp_netif_sntp_deinit();
                state->running = false;
            }
        }
    }
}

void mik__sntp_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__sntp_st(mik_rt)) return;

    MIKSntpState* state = mik__sntp_st(mik_rt);

    if (state->running) {
        esp_netif_sntp_deinit();
        state->running = false;
    }

    if (state->sync_pending) {
        MIK_FreePromise(ctx, &state->sync_promise);
        state->sync_pending = false;
    }

    /* Drain queue */
    struct timeval discard;
    while (xQueueReceive(state->event_queue, &discard, 0) == pdTRUE) {
    }

    s_event_queue = nullptr;
    vQueueDelete(state->event_queue);
    delete state;
    mik__sntp_st(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(sntp, "native:sntp", mik__sntp_init, mik__sntp_consume, mik__sntp_destroy)

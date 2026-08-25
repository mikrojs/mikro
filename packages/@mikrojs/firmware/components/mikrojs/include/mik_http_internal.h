/* Internal HTTP module layout shared with on-device tests.
 * Included by mik_http.cpp and test/http_test.cpp so struct changes can't
 * drift silently between the implementation and its mirror. */
#pragma once

#include <atomic>
#include <cstdint>
#include <cstdlib>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "utils.h"

struct MIKHttpHeader {
    char* key;
    char* value;
};

enum MIKHttpMsgKind : uint8_t {
    MIK_HTTP_MSG_HEADERS,
    MIK_HTTP_MSG_CHUNK,
    MIK_HTTP_MSG_END,
    MIK_HTTP_MSG_ERROR,
};

struct MIKHttpMsg {
    uint32_t id;
    MIKHttpMsgKind kind;
    /* HEADERS */
    int status;
    MIKHttpHeader* headers;
    size_t header_count;
    /* CHUNK */
    uint8_t* chunk_data;
    size_t chunk_len;
    /* ERROR */
    bool is_cancelled;
    char* error_message;
};

struct MIKHttpQueuedMsg {
    MIKHttpMsgKind kind;
    uint8_t* chunk_data;
    size_t chunk_len;
    bool is_cancelled;
    char* error_message;
    MIKHttpQueuedMsg* next;
};

/* A C consumer of one request's messages, used when the requester is native
 * code rather than JS — the OTA client. Set on a pending entry, it replaces the
 * two promises entirely: nothing on that entry is ever handed to JS.
 *
 * Callbacks run from mik__http_consume, i.e. on the JS loop thread, never on the
 * HTTP background task. `done` fires exactly once and is terminal. */
struct MIKHttpNativeSink {
    void (*headers)(void* user_data, int status);
    void (*data)(void* user_data, const uint8_t* data, size_t len);
    void (*done)(void* user_data, int status, const char* error_msg);
    void* user_data;
};

struct MIKHttpPending {
    uint32_t id;
    std::atomic<bool>* cancelled;
    bool js_cancelled;
    /* Native requests only: when this request stops being worth waiting for,
     * in esp_timer microseconds. 0 means no deadline. */
    int64_t deadline_us;

    /* `done == nullptr` means this is a JS request and the promises below are
     * live. Otherwise messages route to the sink and the promises are unused. */
    MIKHttpNativeSink sink;

    MIKPromise headers_promise;
    bool headers_resolved;

    MIKPromise next_promise;
    bool next_promise_active;

    MIKHttpQueuedMsg* queue_head;
    MIKHttpQueuedMsg* queue_tail;
};

/* One native request, as the OTA client describes it. Strings and buffers are
 * borrowed for the duration of the start call only; the module copies them. */
struct MIKHttpNativeRequest {
    const char* url;
    const char* method;
    const char* const* header_keys;
    const char* const* header_values;
    size_t header_count;
    const uint8_t* body;
    size_t body_len;
    /* Whole-request bound, milliseconds; 0 for none. The 10s socket timeout
     * only bounds a single read, so a server that dribbles is otherwise
     * unbounded and holds the task and its TLS session indefinitely. */
    uint32_t timeout_ms;
};

/* Bring the transport up for a native consumer that never imports the JS module.
 * Must be called before mik__http_start_native. Idempotent. */
void mik__http_ensure_native(struct JSContext* ctx);

/* Start a request whose messages go to `sink`. Returns the request id, or 0 when
 * it could not be started. Defined in mik_http.cpp. */
uint32_t mik__http_start_native(struct MIKRuntime* rt, const MIKHttpNativeRequest* req,
                                const MIKHttpNativeSink* sink);
/* Abandon a native request. No further sink callbacks fire for it. */
void mik__http_cancel_native(struct MIKRuntime* rt, uint32_t id);

/* Ceilings shared with the test harness. Must match the #defines in
 * mik_http.cpp. */
#define MIK_HTTP_MAX_PENDING 4
#define MIK_HTTP_MAX_CHUNKS_INFLIGHT 8

struct MIKHttpState {
    QueueHandle_t result_queue;
    SemaphoreHandle_t inflight;
    MIKHttpPending pending[MIK_HTTP_MAX_PENDING];
    size_t pending_count = 0;
    uint32_t next_id = 1;
};

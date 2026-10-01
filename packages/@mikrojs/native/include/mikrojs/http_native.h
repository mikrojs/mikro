/* The native request path of the platform's HTTP module (native:mikro/http).
 * C code, the OTA client, shares that module's task, TLS setup and budgets
 * rather than running a second HTTP client. Each port's HTTP module implements
 * these; a build without networking implements them as refusals. */
#pragma once

#include <stddef.h>
#include <stdint.h>

struct JSContext;
struct MIKRuntime;

/* A C consumer of one request's messages, used when the requester is native
 * code rather than JS. Set on a pending entry, it replaces the two promises
 * entirely: nothing on that entry is ever handed to JS.
 *
 * Callbacks run from the module's loop consumer, i.e. on the JS loop thread,
 * never on the HTTP background task. `done` fires exactly once and is terminal. */
struct MIKHttpNativeSink {
    void (*headers)(void* user_data, int status);
    void (*data)(void* user_data, const uint8_t* data, size_t len);
    void (*done)(void* user_data, int status, const char* error_msg);
    void* user_data;
};

/* One native request. Strings and buffers are borrowed for the duration of the
 * start call only; the module copies them. */
struct MIKHttpNativeRequest {
    const char* url;
    const char* method;
    const char* const* header_keys;
    const char* const* header_values;
    size_t header_count;
    const uint8_t* body;
    size_t body_len;
    /* Whole-request bound, milliseconds; 0 for none. The socket timeout only
     * bounds a single read, so a server that dribbles is otherwise unbounded
     * and holds the task and its TLS session indefinitely. */
    uint32_t timeout_ms;
};

/* Bring the transport up for a native consumer that never imports the JS module.
 * Must be called before mik__http_start_native. Idempotent. */
void mik__http_ensure_native(struct JSContext* ctx);

/* Start a request whose messages go to `sink`. Returns the request id, or 0 when
 * it could not be started. */
uint32_t mik__http_start_native(struct MIKRuntime* rt, const MIKHttpNativeRequest* req,
                                const MIKHttpNativeSink* sink);

/* Abandon a native request. No further sink callbacks fire for it. */
void mik__http_cancel_native(struct MIKRuntime* rt, uint32_t id);

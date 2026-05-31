/* Internal HTTP-server module layout shared with on-device tests.
 * Included by mik_http_server.cpp and test/http_server_test.cpp so struct
 * changes can't drift silently between the implementation and its mirror. */
#pragma once

#include <cstdint>
#include <cstdlib>

#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "utils.h"

struct MIKHsHeader {
    char* key;
    char* value;
};

enum MIKHsCmd : uint8_t {
    MIK_HS_RESPOND,  // one-shot: status + headers + full body
    MIK_HS_START,    // begin chunked: status + headers
    MIK_HS_CHUNK,    // one body chunk
    MIK_HS_END,      // finish chunked
};

/* Per-request command channel, shared between the httpd task and the JS task.
 * Allocated by the httpd task; freed by it once the response is finished. */
struct MIKHsExchange {
    SemaphoreHandle_t cmd_ready;  // given by a respond* call, taken by the httpd task
    httpd_req_t* req;             // live request; valid while the httpd task is parked
    MIKHsCmd cmd;
    int status;
    char status_line[40];  // must outlive the (possibly deferred) header flush
    MIKHsHeader* headers;
    size_t header_count;
    uint8_t* body;  // RESPOND: owned full body
    size_t body_len;
    uint8_t* chunk;  // CHUNK: owned chunk buffer
    size_t chunk_len;
    bool aborted;  // server stopping: handler closes the response and returns
};

/* Acknowledgement posted by the httpd task after processing START/CHUNK, so the
 * JS side can resolve the matching respondStart/respondChunk promise. */
struct MIKHsAck {
    MIKHsExchange* ex;
    bool ok;  // false if the chunk send failed (client gone)
};

/* A live request tracked on the JS side. `method`/`uri`/`body` are freed once
 * the request is delivered to JS; `exchange` lives until the response finishes.
 * `chunk_promise` holds the in-flight respondStart/respondChunk promise. */
struct MIKHsReq {
    uint32_t id;
    MIKHsExchange* exchange;
    char* method;
    char* uri;
    uint8_t* body;
    size_t body_len;
    size_t content_length;
    bool body_too_large;
    bool delivered;
    MIKPromise chunk_promise;
    bool chunk_promise_active;
    MIKHsReq* next;
};

/* Message posted from the httpd task to the JS task on request arrival. */
struct MIKHsMsg {
    MIKHsExchange* exchange;
    char* method;
    char* uri;
    uint8_t* body;
    size_t body_len;
    size_t content_length;
    bool body_too_large;
};

struct MIKHttpServerState {
    httpd_handle_t server;
    QueueHandle_t request_queue;  // httpd -> JS: request arrivals
    QueueHandle_t ack_queue;      // httpd -> JS: START/CHUNK acks (backpressure)
    size_t max_body_size;
    volatile bool stopping;
    uint32_t next_id;
    MIKHsReq* reqs;  // linked list of live requests
    MIKPromise next_promise;
    bool next_promise_active;
};

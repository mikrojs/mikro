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

struct MIKHttpPending {
    uint32_t id;
    std::atomic<bool>* cancelled;
    bool js_cancelled;

    MIKPromise headers_promise;
    bool headers_resolved;

    MIKPromise next_promise;
    bool next_promise_active;

    MIKHttpQueuedMsg* queue_head;
    MIKHttpQueuedMsg* queue_tail;
};

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

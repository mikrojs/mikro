#include <atomic>
#include <cstring>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mik_http_internal.h"
#include "private.h"
#include "utils.h"

/* Dynamic module data slot, allocated on first import.
 * Non-static so tests can access it via extern. */
int mik__http_slot = -1;

/* Helper to access HTTP state from runtime module_data slot */
static inline MIKHttpState*& mik__http_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKHttpState*&>(rt->module_data[mik__http_slot]);
}

#define MIK_HTTP_TAG "native:http"
/* 8 KB was tight for HTTPS — mbedTLS handshake + request header buffer can
 * spike the task stack; the ESP-HTTP-client header list was corrupted once
 * the stack overran. 12 KB matches the recommendation for esp-tls users. */
#define MIK_HTTP_TASK_STACK_SIZE 12288
#define MIK_HTTP_CHUNK_SIZE 2048
/* MIK_HTTP_MAX_PENDING and MIK_HTTP_MAX_CHUNKS_INFLIGHT live in
 * mik_http_internal.h so tests can reference the same ceilings. */

/* ── Types ─────────────────────────────────────────────────────────── */

struct MIKHttpRequest {
    char* url;
    esp_http_client_method_t method;
    uint8_t* body;
    size_t body_len;
    MIKHttpHeader* headers;
    size_t header_count;
};

/* ── Background task ───────────────────────────────────────────────── */

struct MIKHttpTaskArgs {
    uint32_t id;
    MIKHttpRequest req;
    QueueHandle_t result_queue;
    SemaphoreHandle_t inflight;
    std::atomic<bool>* cancelled;
};

static esp_http_client_method_t mik__method_from_string(const char* method) {
    if (!method) return HTTP_METHOD_GET;
    if (strcasecmp(method, "GET") == 0) return HTTP_METHOD_GET;
    if (strcasecmp(method, "POST") == 0) return HTTP_METHOD_POST;
    if (strcasecmp(method, "PUT") == 0) return HTTP_METHOD_PUT;
    if (strcasecmp(method, "PATCH") == 0) return HTTP_METHOD_PATCH;
    if (strcasecmp(method, "DELETE") == 0) return HTTP_METHOD_DELETE;
    if (strcasecmp(method, "HEAD") == 0) return HTTP_METHOD_HEAD;
    if (strcasecmp(method, "OPTIONS") == 0) return HTTP_METHOD_OPTIONS;
    return HTTP_METHOD_GET;
}

static void mik__http_free_headers(MIKHttpHeader* headers, size_t count) {
    for (size_t i = 0; i < count; i++) {
        free(headers[i].key);
        free(headers[i].value);
    }
    free(headers);
}

static void mik__http_free_request(MIKHttpRequest* req) {
    free(req->url);
    free(req->body);
    mik__http_free_headers(req->headers, req->header_count);
}

struct MIKHttpEventData {
    MIKHttpHeader* headers;
    size_t header_count;
    size_t header_capacity;
    bool oom;
};

static esp_err_t mik__http_event_handler(esp_http_client_event_t* evt) {
    auto* data = static_cast<MIKHttpEventData*>(evt->user_data);
    if (evt->event_id == HTTP_EVENT_ON_HEADER && data && !data->oom) {
        if (data->header_count >= data->header_capacity) {
            size_t new_cap = data->header_capacity == 0 ? 8 : data->header_capacity * 2;
            auto* new_headers = static_cast<MIKHttpHeader*>(
                realloc(data->headers, new_cap * sizeof(MIKHttpHeader)));
            if (!new_headers) {
                data->oom = true;
                return ESP_OK;
            }
            data->headers = new_headers;
            data->header_capacity = new_cap;
        }
        char* key = strdup(evt->header_key);
        char* value = strdup(evt->header_value);
        if (!key || !value) {
            free(key);
            free(value);
            data->oom = true;
            return ESP_OK;
        }
        data->headers[data->header_count].key = key;
        data->headers[data->header_count].value = value;
        data->header_count++;
    }
    return ESP_OK;
}

static void mik__post_headers(QueueHandle_t q, uint32_t id, int status,
                              MIKHttpHeader* headers, size_t header_count) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_HEADERS;
    m.status = status;
    m.headers = headers;
    m.header_count = header_count;
    xQueueSend(q, &m, portMAX_DELAY);
}

static void mik__post_chunk(QueueHandle_t q, uint32_t id, uint8_t* data, size_t len) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_CHUNK;
    m.chunk_data = data;
    m.chunk_len = len;
    xQueueSend(q, &m, portMAX_DELAY);
}

static void mik__post_end(QueueHandle_t q, uint32_t id) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_END;
    xQueueSend(q, &m, portMAX_DELAY);
}

static void mik__post_error(QueueHandle_t q, uint32_t id, const char* msg, bool cancelled) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_ERROR;
    m.is_cancelled = cancelled;
    m.error_message = strdup(msg);
    /* If strdup fails under OOM, the downstream consumer treats NULL as "" but
     * the JS side then sees an empty error message. Leave NULL here — the
     * empty-string fallback in mik__error_msg_value keeps the flow intact. */
    xQueueSend(q, &m, portMAX_DELAY);
}

static bool mik__task_cancelled(MIKHttpTaskArgs* args) {
    return args->cancelled->load(std::memory_order_relaxed);
}

/* Heap headroom note: sequential HTTPS requests on a 260KB heap produce
 * fragmentation that is NOT a leak in this code — it's mbedTLS scatter-alloc
 * during handshake plus lwIP holding socket TCBs in TIME_WAIT for 2*MSL
 * (CONFIG_LWIP_TCP_MSL). Both reclaim over time; sysFree recovers after the
 * TIME_WAIT window. The UAF fix in commit [UAF fix] removed the real bug;
 * remaining drift is expected platform behavior, not worth chasing without
 * a broader evaluation of CONFIG_MBEDTLS_DYNAMIC_BUFFER, session tickets,
 * or moving to a custom esp-tls-direct HTTP implementation. */
static void mik__http_task(void* arg) {
    auto* args = static_cast<MIKHttpTaskArgs*>(arg);

    MIKHttpEventData event_data = {};
    bool headers_posted = false;
    bool cancelled = false;
    char error_buf[256] = {0};
    bool have_error = false;

    esp_http_client_config_t config = {};
    config.url = args->req.url;
    config.method = args->req.method;
    // 10s socket-level timeout. Lower than the default 30s so that a
    // blocking read can't hold the BG task hostage past any reasonable
    // JS-level timeoutMs (our cancel polling can't interrupt a blocking
    // read — it only checks between reads).
    config.timeout_ms = 10000;
    config.disable_auto_redirect = false;
    config.max_redirection_count = 10;
    config.event_handler = mik__http_event_handler;
    config.user_data = &event_data;
    config.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        snprintf(error_buf, sizeof(error_buf), "failed to init HTTP client");
        have_error = true;
        goto done;
    }

    if (mik__task_cancelled(args)) {
        cancelled = true;
        goto cleanup;
    }

    for (size_t i = 0; i < args->req.header_count; i++) {
        esp_http_client_set_header(client, args->req.headers[i].key, args->req.headers[i].value);
    }

    if (args->req.body && args->req.body_len > 0) {
        esp_http_client_set_post_field(client, reinterpret_cast<const char*>(args->req.body),
                                       args->req.body_len);
    }

    {
        esp_err_t err = esp_http_client_open(client, args->req.body_len);
        if (err != ESP_OK) {
            snprintf(error_buf, sizeof(error_buf), "fetch failed: could not connect to %s",
                     args->req.url);
            have_error = true;
            goto cleanup;
        }

        if (mik__task_cancelled(args)) {
            cancelled = true;
            goto cleanup;
        }

        if (args->req.body && args->req.body_len > 0) {
            int wlen = esp_http_client_write(client, reinterpret_cast<const char*>(args->req.body),
                                             args->req.body_len);
            if (wlen < 0) {
                snprintf(error_buf, sizeof(error_buf),
                         "fetch failed: could not send request body to %s", args->req.url);
                have_error = true;
                goto cleanup;
            }
        }

        if (mik__task_cancelled(args)) {
            cancelled = true;
            goto cleanup;
        }

        int content_length = esp_http_client_fetch_headers(client);
        if (content_length < 0 && esp_http_client_get_status_code(client) == 0) {
            snprintf(error_buf, sizeof(error_buf), "fetch failed: error reading response from %s",
                     args->req.url);
            have_error = true;
            goto cleanup;
        }

        /* Fail the request if the event handler hit OOM while collecting
         * response headers — silently dropping headers would let missing
         * Content-Type / Location / Set-Cookie cause downstream bugs. */
        if (event_data.oom) {
            snprintf(error_buf, sizeof(error_buf),
                     "fetch failed: out of memory collecting response headers");
            have_error = true;
            goto cleanup;
        }

        if (mik__task_cancelled(args)) {
            cancelled = true;
            goto cleanup;
        }

        /* Post HEADERS now that we have status + collected headers.
         * Transfer ownership of event_data.headers into the message. */
        int status = esp_http_client_get_status_code(client);
        mik__post_headers(args->result_queue, args->id, status, event_data.headers,
                          event_data.header_count);
        event_data.headers = nullptr;
        event_data.header_count = 0;
        headers_posted = true;

        /* Stream body chunks. Each chunk takes one semaphore slot. */
        while (true) {
            if (mik__task_cancelled(args)) {
                cancelled = true;
                goto cleanup;
            }
            /* Wait for an inflight slot. Periodically wake to re-check cancel. */
            if (xSemaphoreTake(args->inflight, pdMS_TO_TICKS(500)) != pdTRUE) {
                continue;
            }

            auto* buf = static_cast<uint8_t*>(malloc(MIK_HTTP_CHUNK_SIZE));
            if (!buf) {
                xSemaphoreGive(args->inflight);
                snprintf(error_buf, sizeof(error_buf), "out of memory");
                have_error = true;
                goto cleanup;
            }

            int rlen = esp_http_client_read(client, reinterpret_cast<char*>(buf),
                                            MIK_HTTP_CHUNK_SIZE);
            if (rlen < 0) {
                xSemaphoreGive(args->inflight);
                free(buf);
                snprintf(error_buf, sizeof(error_buf), "fetch failed: error reading body from %s",
                         args->req.url);
                have_error = true;
                goto cleanup;
            }
            if (rlen == 0) {
                /* EOF. Slot still held — give it back; we don't need it. */
                xSemaphoreGive(args->inflight);
                free(buf);
                break;
            }
            mik__post_chunk(args->result_queue, args->id, buf, rlen);
            /* Slot ownership transfers to consume, which gives it back on dequeue. */
        }
    }

cleanup:
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

done:
    if (cancelled) {
        if (!headers_posted) {
            mik__http_free_headers(event_data.headers, event_data.header_count);
        }
        mik__post_error(args->result_queue, args->id, "cancelled", true);
    } else if (have_error) {
        if (!headers_posted) {
            mik__http_free_headers(event_data.headers, event_data.header_count);
        }
        mik__post_error(args->result_queue, args->id, error_buf, false);
    } else {
        mik__post_end(args->result_queue, args->id);
    }

    mik__http_free_request(&args->req);
    /* Ownership of the `cancelled` atomic transfers to the JS side once the
     * terminal message is posted. The BG task no longer reads it after this
     * point, so it's safe for JS (consume / pending_drop / destroy) to free
     * it whenever it sees fit — and JS holding the pointer via
     * pending[].cancelled guarantees there's no UAF window when JS calls
     * cancel() between our xQueueSend and vTaskDelete. */
    free(args);
    vTaskDelete(nullptr);
}

/* ── JS bindings ──────────────────────────────────────────────────── */

static MIKHttpPending* mik__find_pending(MIKHttpState* state, uint32_t id) {
    for (size_t i = 0; i < state->pending_count; i++) {
        if (state->pending[i].id == id) return &state->pending[i];
    }
    return nullptr;
}

static void mik__free_queued_msg(MIKHttpQueuedMsg* m) {
    if (!m) return;
    free(m->chunk_data);
    free(m->error_message);
    free(m);
}

/* Callers must resolve headers_promise and next_promise (if active) before
 * dropping the pending. This function does not have access to a JSContext
 * to free them defensively. */
static void mik__pending_drop(MIKHttpState* state, size_t idx) {
    MIKHttpPending* p = &state->pending[idx];
    delete p->cancelled;
    p->cancelled = nullptr;
    MIKHttpQueuedMsg* m = p->queue_head;
    while (m) {
        MIKHttpQueuedMsg* next = m->next;
        if (m->kind == MIK_HTTP_MSG_CHUNK) xSemaphoreGive(state->inflight);
        mik__free_queued_msg(m);
        m = next;
    }
    p->queue_head = nullptr;
    p->queue_tail = nullptr;
    state->pending[idx] = state->pending[--state->pending_count];
}

/* Build a JS value representing a message for the JS side: either the headers
 * result or the nextMessage result (both kinds). */
static JSValue mik__headers_result_ok(JSContext* ctx, int status, MIKHttpHeader* headers,
                                      size_t header_count) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "status", JS_NewInt32(ctx, status));
    JSValue js_headers = JS_NewArray(ctx);
    for (size_t h = 0; h < header_count; h++) {
        JSValue pair = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, pair, 0, JS_NewString(ctx, headers[h].key));
        JS_SetPropertyUint32(ctx, pair, 1, JS_NewString(ctx, headers[h].value));
        JS_SetPropertyUint32(ctx, js_headers, h, pair);
    }
    JS_SetPropertyStr(ctx, obj, "headers", js_headers);
    return mik__result_ok(ctx, obj);
}

static JSValue mik__chunk_msg_value(JSContext* ctx, uint8_t* data, size_t len) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, "chunk"));
    JS_SetPropertyStr(ctx, obj, "data",
                      len > 0 ? JS_NewUint8ArrayCopy(ctx, data, len)
                              : JS_NewUint8ArrayCopy(ctx, nullptr, 0));
    return obj;
}

static JSValue mik__end_msg_value(JSContext* ctx) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, "end"));
    return obj;
}

static JSValue mik__error_msg_value(JSContext* ctx, bool cancelled, const char* message) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "kind", JS_NewString(ctx, "error"));
    JS_SetPropertyStr(ctx, obj, "cancelled", JS_NewBool(ctx, cancelled));
    JS_SetPropertyStr(ctx, obj, "message",
                      message ? JS_NewString(ctx, message) : JS_NewString(ctx, ""));
    return obj;
}

/* Resolve a pending's next_promise with a message. Caller sets *finished=true
 * when END or ERROR was delivered so the caller can drop the pending entry. */
static void mik__resolve_next(JSContext* ctx, MIKHttpPending* p, MIKHttpMsgKind kind,
                              uint8_t* chunk_data, size_t chunk_len, bool is_cancelled,
                              const char* error_message, bool* finished) {
    JSValue v;
    *finished = false;
    if (kind == MIK_HTTP_MSG_CHUNK) {
        v = mik__chunk_msg_value(ctx, chunk_data, chunk_len);
    } else if (kind == MIK_HTTP_MSG_END) {
        v = mik__end_msg_value(ctx);
        *finished = true;
    } else {
        v = mik__error_msg_value(ctx, is_cancelled, error_message);
        *finished = true;
    }
    MIK_ResolvePromise(ctx, &p->next_promise, 1, &v);
    p->next_promise_active = false;
}

/* Returns false on OOM. Callers must free the transferred payload themselves
 * and release any associated resources (inflight semaphore for CHUNK). */
static bool mik__enqueue_msg(MIKHttpPending* p, const MIKHttpMsg& m) {
    auto* q = static_cast<MIKHttpQueuedMsg*>(calloc(1, sizeof(MIKHttpQueuedMsg)));
    if (!q) return false;
    q->kind = m.kind;
    if (m.kind == MIK_HTTP_MSG_CHUNK) {
        q->chunk_data = m.chunk_data;
        q->chunk_len = m.chunk_len;
    } else if (m.kind == MIK_HTTP_MSG_ERROR) {
        q->is_cancelled = m.is_cancelled;
        q->error_message = m.error_message;  // ownership transferred
    }
    if (p->queue_tail) {
        p->queue_tail->next = q;
        p->queue_tail = q;
    } else {
        p->queue_head = p->queue_tail = q;
    }
    return true;
}

static JSValue mik__http_request(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    CHECK_NOT_NULL(mik__http_st(mik_rt));

    if (mik__http_st(mik_rt)->pending_count >= MIK_HTTP_MAX_PENDING) {
        return mik__result_err_tag(ctx, "TooManyPending");
    }

    const char* url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_EXCEPTION;

    MIKHttpRequest req = {};
    req.url = strdup(url);
    JS_FreeCString(ctx, url);
    if (!req.url) return JS_ThrowOutOfMemory(ctx);
    req.method = HTTP_METHOD_GET;

    if (argc > 1 && JS_IsObject(argv[1])) {
        JSValue opts = argv[1];

        JSValue method_val = JS_GetPropertyStr(ctx, opts, "method");
        if (JS_IsString(method_val)) {
            const char* method_str = JS_ToCString(ctx, method_val);
            if (method_str) {
                req.method = mik__method_from_string(method_str);
                JS_FreeCString(ctx, method_str);
            }
        }
        JS_FreeValue(ctx, method_val);

        JSValue body_val = JS_GetPropertyStr(ctx, opts, "body");
        if (!JS_IsUndefined(body_val) && !JS_IsNull(body_val)) {
            size_t body_size;
            const uint8_t* body_ptr = JS_GetUint8Array(ctx, &body_size, body_val);
            if (body_ptr && body_size > 0) {
                req.body = static_cast<uint8_t*>(malloc(body_size));
                if (!req.body) {
                    JS_FreeValue(ctx, body_val);
                    mik__http_free_request(&req);
                    return JS_ThrowOutOfMemory(ctx);
                }
                memcpy(req.body, body_ptr, body_size);
                req.body_len = body_size;
            }
        }
        JS_FreeValue(ctx, body_val);

        JSValue headers_val = JS_GetPropertyStr(ctx, opts, "headers");
        if (JS_IsArray(headers_val)) {
            JSValue len_val = JS_GetPropertyStr(ctx, headers_val, "length");
            int64_t len = 0;
            JS_ToInt64(ctx, &len, len_val);
            JS_FreeValue(ctx, len_val);

            if (len > 0) {
                req.headers = static_cast<MIKHttpHeader*>(calloc(len, sizeof(MIKHttpHeader)));
                if (!req.headers) {
                    JS_FreeValue(ctx, headers_val);
                    mik__http_free_request(&req);
                    return JS_ThrowOutOfMemory(ctx);
                }
                req.header_count = 0;
                bool oom = false;
                for (int64_t i = 0; i < len; i++) {
                    JSValue pair = JS_GetPropertyUint32(ctx, headers_val, i);
                    if (JS_IsArray(pair)) {
                        JSValue k = JS_GetPropertyUint32(ctx, pair, 0);
                        JSValue v = JS_GetPropertyUint32(ctx, pair, 1);
                        const char* ks = JS_ToCString(ctx, k);
                        const char* vs = JS_ToCString(ctx, v);
                        if (ks && vs) {
                            char* k_dup = strdup(ks);
                            char* v_dup = strdup(vs);
                            if (k_dup && v_dup) {
                                req.headers[req.header_count].key = k_dup;
                                req.headers[req.header_count].value = v_dup;
                                req.header_count++;
                            } else {
                                free(k_dup);
                                free(v_dup);
                                oom = true;
                            }
                        }
                        if (ks) JS_FreeCString(ctx, ks);
                        if (vs) JS_FreeCString(ctx, vs);
                        JS_FreeValue(ctx, k);
                        JS_FreeValue(ctx, v);
                    }
                    JS_FreeValue(ctx, pair);
                    if (oom) break;
                }
                if (oom) {
                    JS_FreeValue(ctx, headers_val);
                    mik__http_free_request(&req);
                    return JS_ThrowOutOfMemory(ctx);
                }
            }
        }
        JS_FreeValue(ctx, headers_val);
    }

    MIKHttpPending pending = {};
    pending.id = mik__http_st(mik_rt)->next_id++;
    JSValue headers_promise = MIK_InitPromise(ctx, &pending.headers_promise);

    auto* cancelled = new std::atomic<bool>(false);
    pending.cancelled = cancelled;

    auto* task_args = static_cast<MIKHttpTaskArgs*>(malloc(sizeof(MIKHttpTaskArgs)));
    if (!task_args) {
        mik__http_free_request(&req);
        MIK_FreePromise(ctx, &pending.headers_promise);
        delete cancelled;
        return JS_ThrowOutOfMemory(ctx);
    }
    task_args->id = pending.id;
    task_args->req = req;
    task_args->result_queue = mik__http_st(mik_rt)->result_queue;
    task_args->inflight = mik__http_st(mik_rt)->inflight;
    task_args->cancelled = cancelled;

    BaseType_t ret = xTaskCreate(mik__http_task, "mik_http", MIK_HTTP_TASK_STACK_SIZE, task_args,
                                 tskIDLE_PRIORITY + 1, nullptr);
    if (ret != pdPASS) {
        mik__http_free_request(&task_args->req);
        free(task_args);
        delete cancelled;
        MIK_FreePromise(ctx, &pending.headers_promise);
        return mik__result_err_named(ctx, "Network",
                                     "failed to create HTTP background task");
    }

    mik__http_st(mik_rt)->pending[mik__http_st(mik_rt)->pending_count++] = pending;

    JSValue obj = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, obj, "ok", JS_TRUE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "id", JS_NewUint32(ctx, pending.id), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "headers", headers_promise, JS_PROP_C_W_E);
    return obj;
}

/* nextMessage(id) → Promise resolving with the next CHUNK/END/ERROR message. */
static JSValue mik__http_next_message(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__http_st(mik_rt)) {
        JSValue v = mik__end_msg_value(ctx);
        return MIK_NewResolvedPromise(ctx, 1, &v);
    }

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;

    MIKHttpState* state = mik__http_st(mik_rt);
    MIKHttpPending* p = mik__find_pending(state, id);
    if (!p) {
        /* Pending gone: request already finished. Return resolved END so
         * iterators terminate cleanly on stray calls. */
        JSValue v = mik__end_msg_value(ctx);
        return MIK_NewResolvedPromise(ctx, 1, &v);
    }
    if (p->next_promise_active) {
        /* Concurrent nextMessage calls are unsupported. */
        return JS_ThrowTypeError(ctx, "nextMessage already pending for request %u", id);
    }

    /* Fast path: a message is already buffered. */
    if (p->queue_head) {
        MIKHttpQueuedMsg* q = p->queue_head;
        p->queue_head = q->next;
        if (!p->queue_head) p->queue_tail = nullptr;

        JSValue v;
        bool finished = false;
        if (q->kind == MIK_HTTP_MSG_CHUNK) {
            v = mik__chunk_msg_value(ctx, q->chunk_data, q->chunk_len);
            xSemaphoreGive(state->inflight);
        } else if (q->kind == MIK_HTTP_MSG_END) {
            v = mik__end_msg_value(ctx);
            finished = true;
        } else {
            v = mik__error_msg_value(ctx, q->is_cancelled, q->error_message);
            finished = true;
        }
        mik__free_queued_msg(q);
        JSValue promise = MIK_NewResolvedPromise(ctx, 1, &v);
        if (finished) {
            size_t idx = static_cast<size_t>(p - state->pending);
            mik__pending_drop(state, idx);
        }
        return promise;
    }

    /* Slow path: wait. Create a new promise stored on the pending entry. */
    JSValue promise = MIK_InitPromise(ctx, &p->next_promise);
    p->next_promise_active = true;
    return promise;
}

/* pendingCount() — number of in-flight requests whose terminal message has
 * not yet been consumed. Useful for tests that want to verify cancel+drain
 * freed a slot without relying on heap-headroom for a follow-up request. */
static JSValue mik__http_pending_count(JSContext* ctx, JSValue this_val, int argc,
                                       JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__http_st(mik_rt)) return JS_NewUint32(ctx, 0);
    return JS_NewUint32(ctx, mik__http_st(mik_rt)->pending_count);
}

/* cancel(id) — signal a pending request to abort */
static JSValue mik__http_cancel(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__http_st(mik_rt)) return JS_UNDEFINED;

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;

    MIKHttpState* state = mik__http_st(mik_rt);
    for (size_t i = 0; i < state->pending_count; i++) {
        if (state->pending[i].id == id) {
            if (state->pending[i].cancelled) {
                state->pending[i].cancelled->store(true, std::memory_order_relaxed);
            }
            state->pending[i].js_cancelled = true;
            return JS_UNDEFINED;
        }
    }
    return JS_UNDEFINED;
}

/* ── Module init ───────────────────────────────────────────────────── */

static void mik__ensure_netif_initialized() {
    static bool initialized = false;
    if (initialized) return;
    initialized = true;

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(MIK_HTTP_TAG, "esp_netif_init failed: %s", esp_err_to_name(err));
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(MIK_HTTP_TAG, "esp_event_loop_create_default failed: %s", esp_err_to_name(err));
    }
}

static void mik__http_ensure_initialized(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (mik__http_st(mik_rt)) return;

    mik__ensure_netif_initialized();

    auto* state = new MIKHttpState();
    /* Queue depth: enough for HEADERS + CHUNKs + END across all requests. */
    state->result_queue =
        xQueueCreate(MIK_HTTP_MAX_PENDING * 2 + MIK_HTTP_MAX_CHUNKS_INFLIGHT, sizeof(MIKHttpMsg));
    state->inflight =
        xSemaphoreCreateCounting(MIK_HTTP_MAX_CHUNKS_INFLIGHT, MIK_HTTP_MAX_CHUNKS_INFLIGHT);
    CHECK_NOT_NULL(state->result_queue);
    CHECK_NOT_NULL(state->inflight);
    mik__http_st(mik_rt) = state;
}

static int mik__http_module_init(JSContext* ctx, JSModuleDef* m) {
    mik__http_ensure_initialized(ctx);
    JS_SetModuleExport(ctx, m, "request",
                       JS_NewCFunction(ctx, mik__http_request, "request", 2));
    JS_SetModuleExport(ctx, m, "nextMessage",
                       JS_NewCFunction(ctx, mik__http_next_message, "nextMessage", 1));
    JS_SetModuleExport(ctx, m, "cancel", JS_NewCFunction(ctx, mik__http_cancel, "cancel", 1));
    JS_SetModuleExport(ctx, m, "pendingCount",
                       JS_NewCFunction(ctx, mik__http_pending_count, "pendingCount", 0));
    return 0;
}

static JSModuleDef* mik__http_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    mik__http_slot = MIK_AllocModuleSlot(mik_rt);

    JSModuleDef* m = JS_NewCModule(ctx, "native:http", mik__http_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "request");
    JS_AddModuleExport(ctx, m, "nextMessage");
    JS_AddModuleExport(ctx, m, "cancel");
    JS_AddModuleExport(ctx, m, "pendingCount");
    return m;
}

/* ── Event loop consumption ────────────────────────────────────────── */

void mik__http_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__http_st(mik_rt)) return;

    MIKHttpState* state = mik__http_st(mik_rt);
    MIKHttpMsg msg;
    while (xQueueReceive(state->result_queue, &msg, 0) == pdTRUE) {
        MIKHttpPending* p = mik__find_pending(state, msg.id);
        if (!p) {
            /* Pending gone — free payloads and drop. */
            if (msg.kind == MIK_HTTP_MSG_CHUNK) {
                xSemaphoreGive(state->inflight);
                free(msg.chunk_data);
            } else if (msg.kind == MIK_HTTP_MSG_ERROR) {
                free(msg.error_message);
            } else if (msg.kind == MIK_HTTP_MSG_HEADERS) {
                mik__http_free_headers(msg.headers, msg.header_count);
            }
            continue;
        }

        if (msg.kind == MIK_HTTP_MSG_HEADERS) {
            JSValue v =
                mik__headers_result_ok(ctx, msg.status, msg.headers, msg.header_count);
            mik__http_free_headers(msg.headers, msg.header_count);
            MIK_ResolvePromise(ctx, &p->headers_promise, 1, &v);
            p->headers_resolved = true;
            continue;
        }

        /* ERROR before HEADERS: deliver the failure via headers_promise so
         * callers awaiting `start.headers` don't hang. The pending entry is
         * then dropped; any queued messages for it are freed. */
        if (msg.kind == MIK_HTTP_MSG_ERROR && !p->headers_resolved) {
            const char* name = msg.is_cancelled ? "Aborted" : "Network";
            /* If nextMessage was already awaiting, resolve it with the same
             * error so the caller doesn't hang and the MIKPromise's JSValues
             * are freed (MIK_ResolvePromise calls MIK_FreePromise internally). */
            if (p->next_promise_active) {
                JSValue em = mik__error_msg_value(ctx, msg.is_cancelled, msg.error_message);
                MIK_ResolvePromise(ctx, &p->next_promise, 1, &em);
                p->next_promise_active = false;
            }
            JSValue v = mik__result_err_named(ctx, name, "%s",
                                              msg.error_message ? msg.error_message : "HTTP error");
            free(msg.error_message);
            MIK_ResolvePromise(ctx, &p->headers_promise, 1, &v);
            p->headers_resolved = true;
            size_t idx = static_cast<size_t>(p - state->pending);
            mik__pending_drop(state, idx);
            continue;
        }

        /* CHUNK / END / ERROR: deliver or enqueue. */
        if (p->next_promise_active) {
            size_t idx = static_cast<size_t>(p - state->pending);
            bool finished = false;
            mik__resolve_next(ctx, p, msg.kind, msg.chunk_data, msg.chunk_len, msg.is_cancelled,
                              msg.error_message, &finished);
            if (msg.kind == MIK_HTTP_MSG_CHUNK) {
                xSemaphoreGive(state->inflight);
                free(msg.chunk_data);
            } else if (msg.kind == MIK_HTTP_MSG_ERROR) {
                free(msg.error_message);
            }
            if (finished) mik__pending_drop(state, idx);
        } else if ((msg.kind == MIK_HTTP_MSG_END || msg.kind == MIK_HTTP_MSG_ERROR) &&
                   p->js_cancelled) {
            /* Terminal message for a cancelled request with no JS consumer.
             * Safe to discard: nobody will iterate this body. */
            if (msg.kind == MIK_HTTP_MSG_ERROR) free(msg.error_message);
            size_t idx = static_cast<size_t>(p - state->pending);
            mik__pending_drop(state, idx);
        } else {
            if (!mik__enqueue_msg(p, msg)) {
                /* OOM: drop this frame. Mirror the delivery-path cleanup so
                 * the inflight semaphore and payload don't leak. A dropped
                 * terminal message can hang a JS iterator — callers should
                 * apply fetch() timeoutMs to bound the wait. */
                if (msg.kind == MIK_HTTP_MSG_CHUNK) {
                    xSemaphoreGive(state->inflight);
                    free(msg.chunk_data);
                } else if (msg.kind == MIK_HTTP_MSG_ERROR) {
                    free(msg.error_message);
                }
            }
            /* chunk_data / error_message ownership transferred to queue entry
             * (or already freed on the OOM drop above). */
            /* Terminal message means the background task has exited its loop
             * and will never read the shared cancelled atomic again. Free and
             * null it so destroy/cancel don't touch stale memory. */
            if (msg.kind == MIK_HTTP_MSG_END || msg.kind == MIK_HTTP_MSG_ERROR) {
                delete p->cancelled;
                p->cancelled = nullptr;
            }
        }
    }
}

void mik__http_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);
    if (!mik__http_st(mik_rt)) return;

    MIKHttpState* state = mik__http_st(mik_rt);

    /* Signal all pending requests to cancel so background tasks clean up. */
    size_t remaining = 0;
    for (size_t i = 0; i < state->pending_count; i++) {
        if (state->pending[i].cancelled) {
            state->pending[i].cancelled->store(true, std::memory_order_relaxed);
            state->pending[i].js_cancelled = true;
            remaining++;
        }
    }

    /* Drain until every pending task has emitted its END/ERROR message. */
    while (remaining > 0) {
        MIKHttpMsg msg;
        if (xQueueReceive(state->result_queue, &msg, pdMS_TO_TICKS(1000)) != pdTRUE) continue;
        if (msg.kind == MIK_HTTP_MSG_CHUNK) {
            xSemaphoreGive(state->inflight);
            free(msg.chunk_data);
        } else if (msg.kind == MIK_HTTP_MSG_ERROR) {
            free(msg.error_message);
            remaining--;
        } else if (msg.kind == MIK_HTTP_MSG_END) {
            remaining--;
        } else if (msg.kind == MIK_HTTP_MSG_HEADERS) {
            mik__http_free_headers(msg.headers, msg.header_count);
        }
    }

    /* Free any remaining pending promises and queues. MIK_ResolvePromise
     * already frees the MIKPromise's JSValues on settlement, so only free
     * promises that were never resolved. */
    for (size_t i = 0; i < state->pending_count; i++) {
        MIKHttpPending* p = &state->pending[i];
        delete p->cancelled;
        p->cancelled = nullptr;
        MIKHttpQueuedMsg* m = p->queue_head;
        while (m) {
            MIKHttpQueuedMsg* next = m->next;
            mik__free_queued_msg(m);
            m = next;
        }
        if (!p->headers_resolved) MIK_FreePromise(ctx, &p->headers_promise);
        if (p->next_promise_active) MIK_FreePromise(ctx, &p->next_promise);
    }

    vQueueDelete(state->result_queue);
    vSemaphoreDelete(state->inflight);
    delete state;
    mik__http_st(mik_rt) = nullptr;
}

MIK_REGISTER_MODULE(http, "native:http", mik__http_init, mik__http_consume, mik__http_destroy)

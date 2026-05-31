#include <cstring>

#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "mik_http_server_internal.h"
#include "private.h"
#include "utils.h"

/* native:http_server — an HTTP server backed by ESP-IDF's esp_http_server.
 *
 * esp_http_server runs request handlers on its own (single) task; QuickJS is
 * single-threaded, so the JS handler must run on the event-loop task. This is
 * mik_http.cpp reversed: the httpd task parses the request, posts it to a
 * queue, and BLOCKS on a per-request command channel until the JS side drives
 * the response. Because the httpd task is single-threaded and blocks per
 * request, at most one request is in flight at a time — strictly serial.
 *
 * Response protocol (JS -> httpd, via the exchange's cmd_ready semaphore):
 *   - RESPOND: one-shot. status + headers + full body, sent with Content-Length.
 *   - START / CHUNK / END: a chunked (streamed) response. START and CHUNK are
 *     acked back through ack_queue so the JS side gets backpressure (it awaits
 *     each ack before sending the next command); END needs no ack.
 * The cmd_ready semaphore is binary, so the JS side must wait for the previous
 * command's ack before posting the next — which the await-per-command flow on
 * the JS side guarantees.
 *
 * Header limitation: esp_http_server cannot enumerate a request's headers (the
 * only API fetches a header by name), so the JS side exposes lazy by-name
 * lookups via getHeader(), reading the parked request directly. The httpd task
 * is blocked waiting for the response, so there is no concurrent writer. */

#define MIK_HS_TAG "native:http_server"
#define MIK_HS_DEFAULT_MAX_BODY 16384
/* How often the parked handler wakes to check for server shutdown. */
#define MIK_HS_ABORT_POLL_MS 250

/* Dynamic module data slot, allocated on first import. The module's data
 * structures live in mik_http_server_internal.h so on-device tests can drive
 * the queues and inspect the exchange directly. */
int mik__http_server_slot = -1;

static inline MIKHttpServerState*& mik__hs_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKHttpServerState*&>(rt->module_data[mik__http_server_slot]);
}

/* ── Small helpers ─────────────────────────────────────────────────── */

static const char* mik__hs_reason(int status) {
    switch (status) {
        case 200: return "OK";
        case 201: return "Created";
        case 202: return "Accepted";
        case 204: return "No Content";
        case 301: return "Moved Permanently";
        case 302: return "Found";
        case 303: return "See Other";
        case 304: return "Not Modified";
        case 307: return "Temporary Redirect";
        case 308: return "Permanent Redirect";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 413: return "Payload Too Large";
        case 415: return "Unsupported Media Type";
        case 422: return "Unprocessable Entity";
        case 429: return "Too Many Requests";
        case 500: return "Internal Server Error";
        case 501: return "Not Implemented";
        case 503: return "Service Unavailable";
        default: return "Status";
    }
}

static const char* mik__hs_method_str(int m) {
    switch (m) {
        case HTTP_GET: return "GET";
        case HTTP_POST: return "POST";
        case HTTP_PUT: return "PUT";
        case HTTP_PATCH: return "PATCH";
        case HTTP_DELETE: return "DELETE";
        case HTTP_HEAD: return "HEAD";
        case HTTP_OPTIONS: return "OPTIONS";
        default: return "GET";
    }
}

static void mik__hs_free_headers(MIKHsHeader* h, size_t n) {
    for (size_t i = 0; i < n; i++) {
        free(h[i].key);
        free(h[i].value);
    }
    free(h);
}

static void mik__hs_free_exchange(MIKHsExchange* ex) {
    if (!ex) return;
    if (ex->cmd_ready) vSemaphoreDelete(ex->cmd_ready);
    mik__hs_free_headers(ex->headers, ex->header_count);
    free(ex->body);
    free(ex->chunk);
    delete ex;
}

static void mik__hs_post_ack(QueueHandle_t q, MIKHsExchange* ex, bool ok) {
    MIKHsAck a = {ex, ok};
    xQueueSend(q, &a, portMAX_DELAY);
}

static void mik__hs_set_head(httpd_req_t* req, MIKHsExchange* ex) {
    snprintf(ex->status_line, sizeof(ex->status_line), "%d %s", ex->status,
             mik__hs_reason(ex->status));
    httpd_resp_set_status(req, ex->status_line);
    for (size_t i = 0; i < ex->header_count; i++) {
        httpd_resp_set_hdr(req, ex->headers[i].key, ex->headers[i].value);
    }
}

/* ── httpd task: request handler ───────────────────────────────────── */

static esp_err_t mik__hs_handler(httpd_req_t* req) {
    auto* state = static_cast<MIKHttpServerState*>(req->user_ctx);

    /* Read the request body up to the cap, before handing the request to JS. */
    uint8_t* body = nullptr;
    size_t body_len = 0;
    bool too_large = false;
    size_t clen = req->content_len;
    if (clen > 0) {
        if (clen > state->max_body_size) {
            too_large = true;
        } else {
            body = static_cast<uint8_t*>(malloc(clen));
            if (!body) {
                httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
                return ESP_OK;
            }
            size_t off = 0;
            while (off < clen) {
                int r = httpd_req_recv(req, reinterpret_cast<char*>(body) + off, clen - off);
                if (r <= 0) {
                    free(body);
                    if (r == HTTPD_SOCK_ERR_TIMEOUT) {
                        httpd_resp_send_err(req, HTTPD_408_REQ_TIMEOUT, nullptr);
                    }
                    return ESP_OK;
                }
                off += static_cast<size_t>(r);
            }
            body_len = off;
        }
    }

    auto* ex = new MIKHsExchange();
    ex->cmd_ready = xSemaphoreCreateBinary();
    if (!ex->cmd_ready) {
        delete ex;
        free(body);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
        return ESP_OK;
    }
    ex->req = req;

    MIKHsMsg msg = {};
    msg.exchange = ex;
    msg.method = strdup(mik__hs_method_str(req->method));
    msg.uri = strdup(req->uri);
    msg.body = body;
    msg.body_len = body_len;
    msg.content_length = clen;
    msg.body_too_large = too_large;

    if (xQueueSend(state->request_queue, &msg, portMAX_DELAY) != pdTRUE) {
        free(msg.method);
        free(msg.uri);
        free(body);
        mik__hs_free_exchange(ex);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, nullptr);
        return ESP_OK;
    }

    /* Drive the response from JS commands. httpd_stop() can't complete until
     * this handler returns, so stop() sets `stopping` before calling it. */
    bool response_started = false;
    bool aborted = false;
    bool done = false;
    while (!done) {
        bool got = false;
        while (!got) {
            if (xSemaphoreTake(ex->cmd_ready, pdMS_TO_TICKS(MIK_HS_ABORT_POLL_MS)) == pdTRUE) {
                got = true;
            } else if (state->stopping) {
                aborted = true;
                break;
            }
        }
        if (aborted) break;

        switch (ex->cmd) {
            case MIK_HS_RESPOND:
                mik__hs_set_head(req, ex);
                httpd_resp_send(req, reinterpret_cast<const char*>(ex->body),
                                ex->body ? ex->body_len : 0);
                response_started = true;
                done = true;  // JS already removed the req
                break;
            case MIK_HS_START:
                mik__hs_set_head(req, ex);  // flushed on the first send_chunk
                response_started = true;
                mik__hs_post_ack(state->ack_queue, ex, true);
                break;
            case MIK_HS_CHUNK: {
                esp_err_t e = httpd_resp_send_chunk(req, reinterpret_cast<const char*>(ex->chunk),
                                                    ex->chunk_len);
                free(ex->chunk);
                ex->chunk = nullptr;
                ex->chunk_len = 0;
                mik__hs_post_ack(state->ack_queue, ex, e == ESP_OK);
                break;
            }
            case MIK_HS_END:
                httpd_resp_send_chunk(req, nullptr, 0);  // terminate the chunked response
                done = true;  // JS already removed the req
                break;
        }
    }

    if (aborted) {
        if (response_started) {
            httpd_resp_send_chunk(req, nullptr, 0);  // close a stream already in progress
        } else {
            httpd_resp_set_status(req, "503 Service Unavailable");
            httpd_resp_send(req, nullptr, 0);
        }
    }

    mik__hs_free_exchange(ex);
    return ESP_OK;
}

/* ── JS bindings ───────────────────────────────────────────────────── */

/* The request list is a plain singly-linked list with O(n) find/append. Because
 * the httpd task is single and blocks per request, at most one request is in
 * flight (plus, briefly, ones the serve loop has yet to drain), so n stays tiny. */
static MIKHsReq* mik__hs_find_req(MIKHttpServerState* state, uint32_t id) {
    for (MIKHsReq* r = state->reqs; r; r = r->next) {
        if (r->id == id) return r;
    }
    return nullptr;
}

static MIKHsReq* mik__hs_find_undelivered(MIKHttpServerState* state) {
    for (MIKHsReq* r = state->reqs; r; r = r->next) {
        if (!r->delivered) return r;
    }
    return nullptr;
}

static void mik__hs_remove_req(MIKHttpServerState* state, MIKHsReq* target) {
    MIKHsReq** pp = &state->reqs;
    while (*pp) {
        if (*pp == target) {
            *pp = target->next;
            delete target;
            return;
        }
        pp = &(*pp)->next;
    }
}

static JSValue mik__hs_build_descriptor(JSContext* ctx, MIKHsReq* r) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "id", JS_NewUint32(ctx, r->id));
    JS_SetPropertyStr(ctx, obj, "method", JS_NewString(ctx, r->method ? r->method : "GET"));
    JS_SetPropertyStr(ctx, obj, "url", JS_NewString(ctx, r->uri ? r->uri : "/"));
    JS_SetPropertyStr(ctx, obj, "body",
                      r->body ? JS_NewUint8ArrayCopy(ctx, r->body, r->body_len)
                              : JS_NewUint8ArrayCopy(ctx, nullptr, 0));
    JS_SetPropertyStr(ctx, obj, "bodyTooLarge", JS_NewBool(ctx, r->body_too_large));
    JS_SetPropertyStr(ctx, obj, "contentLength",
                      JS_NewInt64(ctx, static_cast<int64_t>(r->content_length)));
    return obj;
}

/* Mark a request as delivered to JS and release its request-side buffers (the
 * descriptor already copied them). `exchange` stays until the response finishes. */
static void mik__hs_mark_delivered(MIKHsReq* r) {
    r->delivered = true;
    free(r->method);
    r->method = nullptr;
    free(r->uri);
    r->uri = nullptr;
    free(r->body);
    r->body = nullptr;
    r->body_len = 0;
}

static JSValue mik__hs_start(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    CHECK_NOT_NULL(state);

    if (state->server) return mik__result_err_tag(ctx, "AlreadyListening");

    uint32_t port = 80;
    if (argc > 0) JS_ToUint32(ctx, &port, argv[0]);
    uint32_t max_body = MIK_HS_DEFAULT_MAX_BODY;
    if (argc > 1 && JS_IsNumber(argv[1])) JS_ToUint32(ctx, &max_body, argv[1]);
    state->max_body_size = max_body;
    state->stopping = false;

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = static_cast<uint16_t>(port);
    config.uri_match_fn = httpd_uri_match_wildcard;

    httpd_handle_t server = nullptr;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        const char* tag = (err == ESP_ERR_HTTPD_ALLOC_MEM) ? "OutOfMemory" : "StartFailed";
        return mik__result_err_named(ctx, tag, "failed to start HTTP server: %s",
                                     esp_err_to_name(err));
    }
    state->server = server;

    /* Register one wildcard handler per method; all routing is done in JS. */
    static const int methods[] = {HTTP_GET,    HTTP_POST, HTTP_PUT,     HTTP_PATCH,
                                  HTTP_DELETE, HTTP_HEAD, HTTP_OPTIONS};
    for (int m : methods) {
        httpd_uri_t uri = {};
        uri.uri = "/*";
        uri.method = static_cast<httpd_method_t>(m);
        uri.handler = mik__hs_handler;
        uri.user_ctx = state;
        httpd_register_uri_handler(server, &uri);
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__hs_stop(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state || !state->server) return JS_UNDEFINED;

    /* Set `stopping` first so any parked handler aborts; httpd_stop() then
     * blocks until the (single) httpd task returns from the handler. */
    state->stopping = true;
    httpd_stop(state->server);
    state->server = nullptr;

    /* Handlers have all returned and freed their exchanges. Free only the
     * request-side data; never touch exchange pointers (already freed). Resolve
     * any in-flight chunk promise with false so a streaming loop ends. */
    MIKHsMsg msg;
    while (xQueueReceive(state->request_queue, &msg, 0) == pdTRUE) {
        free(msg.method);
        free(msg.uri);
        free(msg.body);
    }
    MIKHsAck ack;
    while (xQueueReceive(state->ack_queue, &ack, 0) == pdTRUE) { /* discard */ }

    MIKHsReq* r = state->reqs;
    while (r) {
        MIKHsReq* next = r->next;
        if (!r->delivered) {
            free(r->method);
            free(r->uri);
            free(r->body);
        }
        if (r->chunk_promise_active) {
            JSValue v = JS_FALSE;
            MIK_ResolvePromise(ctx, &r->chunk_promise, 1, &v);
            r->chunk_promise_active = false;
        }
        delete r;
        r = next;
    }
    state->reqs = nullptr;

    /* Wake a pending nextRequest() with a close sentinel so the serve loop ends. */
    if (state->next_promise_active) {
        JSValue closed = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, closed, "closed", JS_TRUE);
        MIK_ResolvePromise(ctx, &state->next_promise, 1, &closed);
        state->next_promise_active = false;
    }
    return JS_UNDEFINED;
}

static JSValue mik__hs_next_request(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state || !state->server) {
        JSValue closed = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, closed, "closed", JS_TRUE);
        return MIK_NewResolvedPromise(ctx, 1, &closed);
    }
    if (state->next_promise_active) {
        return JS_ThrowTypeError(ctx, "nextRequest already pending");
    }

    MIKHsReq* r = mik__hs_find_undelivered(state);
    if (r) {
        JSValue desc = mik__hs_build_descriptor(ctx, r);
        mik__hs_mark_delivered(r);
        return MIK_NewResolvedPromise(ctx, 1, &desc);
    }

    JSValue promise = MIK_InitPromise(ctx, &state->next_promise);
    state->next_promise_active = true;
    return promise;
}

/* Parse a [[key, value], ...] array into a heap MIKHsHeader array. On any
 * allocation failure, frees what it built and yields an empty set — a response
 * with fewer headers is preferable to failing the whole request. */
static void mik__hs_parse_headers(JSContext* ctx, JSValue arr, MIKHsHeader** out,
                                  size_t* out_count) {
    *out = nullptr;
    *out_count = 0;
    JSValue len_val = JS_GetPropertyStr(ctx, arr, "length");
    int64_t len = 0;
    JS_ToInt64(ctx, &len, len_val);
    JS_FreeValue(ctx, len_val);
    if (len <= 0) return;

    auto* headers = static_cast<MIKHsHeader*>(calloc(len, sizeof(MIKHsHeader)));
    if (!headers) return;
    size_t count = 0;
    for (int64_t i = 0; i < len; i++) {
        JSValue pair = JS_GetPropertyUint32(ctx, arr, i);
        if (JS_IsArray(pair)) {
            JSValue k = JS_GetPropertyUint32(ctx, pair, 0);
            JSValue v = JS_GetPropertyUint32(ctx, pair, 1);
            const char* ks = JS_ToCString(ctx, k);
            const char* vs = JS_ToCString(ctx, v);
            if (ks && vs) {
                char* kd = strdup(ks);
                char* vd = strdup(vs);
                if (kd && vd) {
                    headers[count].key = kd;
                    headers[count].value = vd;
                    count++;
                } else {
                    free(kd);
                    free(vd);
                }
            }
            if (ks) JS_FreeCString(ctx, ks);
            if (vs) JS_FreeCString(ctx, vs);
            JS_FreeValue(ctx, k);
            JS_FreeValue(ctx, v);
        }
        JS_FreeValue(ctx, pair);
    }
    *out = headers;
    *out_count = count;
}

/* respond(id, status, headers, body) — one-shot response. No-op if the request
 * is unknown (already responded). */
static JSValue mik__hs_respond(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state) return JS_UNDEFINED;

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    MIKHsReq* r = mik__hs_find_req(state, id);
    if (!r || !r->delivered || !r->exchange) return JS_UNDEFINED;
    MIKHsExchange* ex = r->exchange;

    ex->cmd = MIK_HS_RESPOND;
    int32_t status = 200;
    JS_ToInt32(ctx, &status, argv[1]);
    ex->status = status;
    if (argc > 2 && JS_IsArray(argv[2])) {
        mik__hs_parse_headers(ctx, argv[2], &ex->headers, &ex->header_count);
    }
    if (argc > 3 && !JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) {
        size_t blen;
        const uint8_t* bptr = JS_GetUint8Array(ctx, &blen, argv[3]);
        if (bptr && blen > 0) {
            ex->body = static_cast<uint8_t*>(malloc(blen));
            if (ex->body) {
                memcpy(ex->body, bptr, blen);
                ex->body_len = blen;
            }
        }
    }

    /* Hand ownership to the httpd task and drop our bookkeeping. Do not touch
     * `ex` after giving cmd_ready — the httpd task may free it immediately. */
    r->exchange = nullptr;
    xSemaphoreGive(ex->cmd_ready);
    mik__hs_remove_req(state, r);
    return JS_UNDEFINED;
}

/* respondStart(id, status, headers) — begin a chunked response. Returns a
 * promise that resolves once status + headers are queued. */
static JSValue mik__hs_respond_start(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    JSValue undef = JS_UNDEFINED;
    if (!state) return MIK_NewResolvedPromise(ctx, 1, &undef);

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    MIKHsReq* r = mik__hs_find_req(state, id);
    if (!r || !r->delivered || !r->exchange || r->chunk_promise_active) {
        return MIK_NewResolvedPromise(ctx, 1, &undef);
    }
    MIKHsExchange* ex = r->exchange;

    ex->cmd = MIK_HS_START;
    int32_t status = 200;
    JS_ToInt32(ctx, &status, argv[1]);
    ex->status = status;
    if (argc > 2 && JS_IsArray(argv[2])) {
        mik__hs_parse_headers(ctx, argv[2], &ex->headers, &ex->header_count);
    }

    JSValue promise = MIK_InitPromise(ctx, &r->chunk_promise);
    r->chunk_promise_active = true;
    xSemaphoreGive(ex->cmd_ready);
    return promise;
}

/* respondChunk(id, data) — send one body chunk. Returns a promise resolving to
 * false if the client has gone (caller should stop sending). */
static JSValue mik__hs_respond_chunk(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    JSValue f = JS_FALSE;
    if (!state) return MIK_NewResolvedPromise(ctx, 1, &f);

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    MIKHsReq* r = mik__hs_find_req(state, id);
    if (!r || !r->delivered || !r->exchange || r->chunk_promise_active) {
        return MIK_NewResolvedPromise(ctx, 1, &f);
    }
    MIKHsExchange* ex = r->exchange;

    ex->cmd = MIK_HS_CHUNK;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        size_t len;
        const uint8_t* p = JS_GetUint8Array(ctx, &len, argv[1]);
        if (p && len > 0) {
            ex->chunk = static_cast<uint8_t*>(malloc(len));
            if (ex->chunk) {
                memcpy(ex->chunk, p, len);
                ex->chunk_len = len;
            }
        }
    }

    JSValue promise = MIK_InitPromise(ctx, &r->chunk_promise);
    r->chunk_promise_active = true;
    xSemaphoreGive(ex->cmd_ready);
    return promise;
}

/* respondEnd(id) — finish a chunked response. */
static JSValue mik__hs_respond_end(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state) return JS_UNDEFINED;

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    MIKHsReq* r = mik__hs_find_req(state, id);
    if (!r || !r->delivered || !r->exchange) return JS_UNDEFINED;
    MIKHsExchange* ex = r->exchange;

    if (r->chunk_promise_active) {
        MIK_FreePromise(ctx, &r->chunk_promise);
        r->chunk_promise_active = false;
    }
    ex->cmd = MIK_HS_END;
    r->exchange = nullptr;
    xSemaphoreGive(ex->cmd_ready);
    mik__hs_remove_req(state, r);
    return JS_UNDEFINED;
}

/* getHeader(id, name) — fetch a single request header by name, or undefined.
 * Reads the parked request directly; the httpd task is blocked in the handler
 * waiting for the response, so there is no concurrent writer. */
static JSValue mik__hs_get_header(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state) return JS_UNDEFINED;

    uint32_t id;
    if (JS_ToUint32(ctx, &id, argv[0])) return JS_EXCEPTION;
    const char* name = JS_ToCString(ctx, argv[1]);
    if (!name) return JS_EXCEPTION;

    JSValue result = JS_UNDEFINED;
    MIKHsReq* r = mik__hs_find_req(state, id);
    if (r && r->delivered && r->exchange && r->exchange->req) {
        httpd_req_t* req = r->exchange->req;
        size_t len = httpd_req_get_hdr_value_len(req, name);
        if (len > 0) {
            char* buf = static_cast<char*>(malloc(len + 1));
            if (buf) {
                if (httpd_req_get_hdr_value_str(req, name, buf, len + 1) == ESP_OK) {
                    result = JS_NewStringLen(ctx, buf, len);
                }
                free(buf);
            }
        }
    }
    JS_FreeCString(ctx, name);
    return result;
}

/* ── Module init ───────────────────────────────────────────────────── */

static void mik__hs_ensure_initialized(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    if (mik__hs_st(rt)) return;

    auto* state = new MIKHttpServerState();
    state->server = nullptr;
    state->request_queue = xQueueCreate(8, sizeof(MIKHsMsg));
    state->ack_queue = xQueueCreate(8, sizeof(MIKHsAck));
    CHECK_NOT_NULL(state->request_queue);
    CHECK_NOT_NULL(state->ack_queue);
    state->max_body_size = MIK_HS_DEFAULT_MAX_BODY;
    state->stopping = false;
    state->next_id = 1;
    state->reqs = nullptr;
    state->next_promise_active = false;
    mik__hs_st(rt) = state;
}

static int mik__hs_module_init(JSContext* ctx, JSModuleDef* m) {
    mik__hs_ensure_initialized(ctx);
    JS_SetModuleExport(ctx, m, "start", JS_NewCFunction(ctx, mik__hs_start, "start", 2));
    JS_SetModuleExport(ctx, m, "stop", JS_NewCFunction(ctx, mik__hs_stop, "stop", 0));
    JS_SetModuleExport(ctx, m, "nextRequest",
                       JS_NewCFunction(ctx, mik__hs_next_request, "nextRequest", 0));
    JS_SetModuleExport(ctx, m, "respond", JS_NewCFunction(ctx, mik__hs_respond, "respond", 4));
    JS_SetModuleExport(ctx, m, "respondStart",
                       JS_NewCFunction(ctx, mik__hs_respond_start, "respondStart", 3));
    JS_SetModuleExport(ctx, m, "respondChunk",
                       JS_NewCFunction(ctx, mik__hs_respond_chunk, "respondChunk", 2));
    JS_SetModuleExport(ctx, m, "respondEnd",
                       JS_NewCFunction(ctx, mik__hs_respond_end, "respondEnd", 1));
    JS_SetModuleExport(ctx, m, "getHeader",
                       JS_NewCFunction(ctx, mik__hs_get_header, "getHeader", 2));
    return 0;
}

static JSModuleDef* mik__http_server_init(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    mik__http_server_slot = MIK_AllocModuleSlot(rt);

    JSModuleDef* m = JS_NewCModule(ctx, "native:http_server", mik__hs_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "start");
    JS_AddModuleExport(ctx, m, "stop");
    JS_AddModuleExport(ctx, m, "nextRequest");
    JS_AddModuleExport(ctx, m, "respond");
    JS_AddModuleExport(ctx, m, "respondStart");
    JS_AddModuleExport(ctx, m, "respondChunk");
    JS_AddModuleExport(ctx, m, "respondEnd");
    JS_AddModuleExport(ctx, m, "getHeader");
    return m;
}

/* ── Event loop consumption ────────────────────────────────────────── */

void mik__http_server_consume(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state) return;

    /* Resolve START/CHUNK acks (backpressure) before delivering new requests. */
    MIKHsAck ack;
    while (xQueueReceive(state->ack_queue, &ack, 0) == pdTRUE) {
        for (MIKHsReq* r = state->reqs; r; r = r->next) {
            if (r->exchange == ack.ex && r->chunk_promise_active) {
                JSValue v = JS_NewBool(ctx, ack.ok);
                MIK_ResolvePromise(ctx, &r->chunk_promise, 1, &v);
                r->chunk_promise_active = false;
                break;
            }
        }
    }

    MIKHsMsg msg;
    while (xQueueReceive(state->request_queue, &msg, 0) == pdTRUE) {
        auto* r = new MIKHsReq();
        r->id = state->next_id++;
        r->exchange = msg.exchange;
        r->method = msg.method;
        r->uri = msg.uri;
        r->body = msg.body;
        r->body_len = msg.body_len;
        r->content_length = msg.content_length;
        r->body_too_large = msg.body_too_large;
        r->delivered = false;
        r->chunk_promise_active = false;
        r->next = nullptr;

        if (!state->reqs) {
            state->reqs = r;
        } else {
            MIKHsReq* t = state->reqs;
            while (t->next) t = t->next;
            t->next = r;
        }

        if (state->next_promise_active) {
            JSValue desc = mik__hs_build_descriptor(ctx, r);
            mik__hs_mark_delivered(r);
            MIK_ResolvePromise(ctx, &state->next_promise, 1, &desc);
            state->next_promise_active = false;
        }
    }
}

void mik__http_server_destroy(JSContext* ctx) {
    MIKRuntime* rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(rt);
    MIKHttpServerState* state = mik__hs_st(rt);
    if (!state) return;

    if (state->server) {
        state->stopping = true;
        httpd_stop(state->server);
        state->server = nullptr;
    }

    MIKHsMsg msg;
    while (xQueueReceive(state->request_queue, &msg, 0) == pdTRUE) {
        free(msg.method);
        free(msg.uri);
        free(msg.body);
    }
    MIKHsAck ack;
    while (xQueueReceive(state->ack_queue, &ack, 0) == pdTRUE) { /* discard */ }

    MIKHsReq* r = state->reqs;
    while (r) {
        MIKHsReq* next = r->next;
        if (!r->delivered) {
            free(r->method);
            free(r->uri);
            free(r->body);
        }
        if (r->chunk_promise_active) MIK_FreePromise(ctx, &r->chunk_promise);
        delete r;
        r = next;
    }
    state->reqs = nullptr;

    if (state->next_promise_active) {
        MIK_FreePromise(ctx, &state->next_promise);
        state->next_promise_active = false;
    }

    vQueueDelete(state->request_queue);
    vQueueDelete(state->ack_queue);
    delete state;
    mik__hs_st(rt) = nullptr;
}

MIK_REGISTER_MODULE(http_server, "native:http_server", mik__http_server_init,
                    mik__http_server_consume, mik__http_server_destroy)

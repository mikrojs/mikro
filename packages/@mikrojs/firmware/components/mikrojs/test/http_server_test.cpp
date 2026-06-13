#include <cstring>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "mik_http_server_internal.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"
#include "utils.h"

/* Access the http_server module slot and consume function from
 * mik_http_server.cpp. These tests drive the module's queues directly — no
 * real esp_http_server / network — the same approach as http_test.cpp. */
extern int mik__http_server_slot;
extern void mik__http_server_consume(JSContext* ctx);

static inline MIKHttpServerState*& mik__hs(MIKRuntime* r) {
    return reinterpret_cast<MIKHttpServerState*&>(r->module_data[mik__http_server_slot]);
}

/* ── Test scaffolding (same teardown-before-assert convention as http_test) ── */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static void ensure_initialized() {
    const char* code = "import { nextRequest } from 'native:mikro/http_server';";
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
}

static void read_global_string(const char* key, char* out, size_t out_len) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, key);
    const char* s = JS_ToCString(ctx, v);
    if (s) {
        strncpy(out, s, out_len - 1);
        out[out_len - 1] = '\0';
        JS_FreeCString(ctx, s);
    } else {
        out[0] = '\0';
    }
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
}

static bool read_global_bool(const char* key) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, key);
    bool b = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return b;
}

/* Push a request the way the httpd handler would: allocate an exchange with a
 * command semaphore, hand method/uri ownership to the module via the queue. The
 * exchange is returned so the test can inspect what respond() wrote and free it
 * (no real httpd task exists to consume cmd_ready and free it). */
static MIKHsExchange* push_request(const char* method, const char* uri) {
    auto* ex = new MIKHsExchange();  // value-initialized: all fields zero/null
    ex->cmd_ready = xSemaphoreCreateBinary();
    ex->req = nullptr;

    MIKHsMsg msg = {};
    msg.exchange = ex;
    msg.method = strdup(method);
    msg.uri = strdup(uri);
    xQueueSend(mik__hs(rt)->request_queue, &msg, 0);
    return ex;
}

static void free_exchange(MIKHsExchange* ex) {
    if (ex->cmd_ready) {
        xSemaphoreTake(ex->cmd_ready, 0);  // drain the give from respond()
        vSemaphoreDelete(ex->cmd_ready);
    }
    for (size_t i = 0; i < ex->header_count; i++) {
        free(ex->headers[i].key);
        free(ex->headers[i].value);
    }
    free(ex->headers);
    free(ex->body);
    free(ex->chunk);
    delete ex;
}

/* ── Tests ─────────────────────────────────────────────────────────── */

TEST_CASE("native:mikro/http_server exports the expected functions", "[httpd]") {
    setup();
    JSValue ret = eval_module(R"(
        import { start, stop, nextRequest, respond,
                 respondStart, respondChunk, respondEnd, getHeader } from "native:mikro/http_server";
        globalThis.__t = [start, stop, nextRequest, respond,
                          respondStart, respondChunk, respondEnd, getHeader]
                          .every((f) => typeof f === "function") ? "ok" : "bad";
    )");
    bool evalOk = !JS_IsException(ret);
    char t[8];
    read_global_string("__t", t, sizeof(t));
    teardown();

    TEST_ASSERT_TRUE_MESSAGE(evalOk, "module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("ok", t);
}

TEST_CASE("http_server consume with no messages is a no-op", "[httpd]") {
    setup();
    ensure_initialized();
    mik__http_server_consume(ctx);
    bool reqsEmpty = (mik__hs(rt)->reqs == nullptr);
    teardown();

    TEST_ASSERT_TRUE(reqsEmpty);
}

TEST_CASE("nextRequest delivers method/url and respond fills the exchange", "[httpd]") {
    setup();
    ensure_initialized();

    MIKHsExchange* ex = push_request("GET", "/hello?x=1");

    eval_module(R"(
        import { nextRequest, respond } from 'native:mikro/http_server';
        globalThis.__method = '';
        globalThis.__url = '';
        (async () => {
            const r = await nextRequest();
            globalThis.__method = r.method;
            globalThis.__url = r.url;
            respond(r.id, 200, [['X-Test', 'yes']], new Uint8Array([65, 66, 67]));
        })();
    )");

    mik__http_server_consume(ctx);
    mik__execute_jobs(ctx);

    char method[16], url[32];
    read_global_string("__method", method, sizeof(method));
    read_global_string("__url", url, sizeof(url));

    int status = ex->status;
    size_t bodyLen = ex->body_len;
    char body[8] = {};
    if (ex->body && bodyLen < sizeof(body)) memcpy(body, ex->body, bodyLen);
    size_t headerCount = ex->header_count;

    free_exchange(ex);
    teardown();

    TEST_ASSERT_EQUAL_STRING("GET", method);
    TEST_ASSERT_EQUAL_STRING("/hello?x=1", url);
    TEST_ASSERT_EQUAL_INT(200, status);
    TEST_ASSERT_EQUAL_UINT(3, bodyLen);
    TEST_ASSERT_EQUAL_STRING("ABC", body);
    TEST_ASSERT_EQUAL_UINT(1, headerCount);
}

/* Regression: a response with no body (e.g. a 303 redirect) must not throw in
 * native respond(). Before the fix, respond() called JS_GetUint8Array on an
 * undefined body and left a pending TypeError. */
TEST_CASE("respond tolerates a bodyless response", "[httpd]") {
    setup();
    ensure_initialized();

    MIKHsExchange* ex = push_request("POST", "/save");

    eval_module(R"(
        import { nextRequest, respond } from 'native:mikro/http_server';
        globalThis.__threw = false;
        (async () => {
            const r = await nextRequest();
            try {
                respond(r.id, 303, [['location', '/']], undefined);
            } catch (e) {
                globalThis.__threw = true;
            }
        })();
    )");

    mik__http_server_consume(ctx);
    mik__execute_jobs(ctx);

    bool threw = read_global_bool("__threw");
    int status = ex->status;
    bool bodyNull = (ex->body == nullptr);

    free_exchange(ex);
    teardown();

    TEST_ASSERT_FALSE_MESSAGE(threw, "bodyless respond must not throw");
    TEST_ASSERT_EQUAL_INT(303, status);
    TEST_ASSERT_TRUE_MESSAGE(bodyNull, "bodyless respond leaves the body unset");
}

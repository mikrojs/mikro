#include <atomic>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "mik_http_internal.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"
#include "utils.h"

/* Access HTTP state and consume function from mik_http.cpp */
extern int mik__http_slot;
extern void mik__http_consume(JSContext* ctx);

static inline MIKHttpState*& mik__http(MIKRuntime* r) {
    return reinterpret_cast<MIKHttpState*&>(r->module_data[mik__http_slot]);
}

/* ── Test helpers ─────────────────────────────────────────────────── */

/*
 * IMPORTANT: Unity's TEST_ASSERT_* macros use longjmp on failure, which
 * skips any cleanup after the assertion. To avoid leaking the entire
 * runtime on a test failure, we structure every test as:
 *
 *   1. setup() + test work
 *   2. extract observed values into C locals (int, string copy, etc.)
 *   3. teardown()
 *   4. TEST_ASSERT_* against the extracted locals
 *
 * See fs_js_test.cpp for the same convention.
 */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void ensure_http_initialized() {
    const char* code = "import { request } from 'native:mikro/http';";
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static void push_headers(uint32_t id, int status, MIKHttpHeader* headers, size_t header_count) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_HEADERS;
    m.status = status;
    m.headers = headers;
    m.header_count = header_count;
    xQueueSend(mik__http(rt)->result_queue, &m, 0);
}

static void push_chunk(uint32_t id, const char* s) {
    size_t n = strlen(s);
    uint8_t* data = static_cast<uint8_t*>(malloc(n));
    memcpy(data, s, n);
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_CHUNK;
    m.chunk_data = data;
    m.chunk_len = n;
    xSemaphoreTake(mik__http(rt)->inflight, 0);
    xQueueSend(mik__http(rt)->result_queue, &m, 0);
}

static void push_end(uint32_t id) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_END;
    xQueueSend(mik__http(rt)->result_queue, &m, 0);
}

static void push_error(uint32_t id, const char* err_msg, bool cancelled = false) {
    MIKHttpMsg m = {};
    m.id = id;
    m.kind = MIK_HTTP_MSG_ERROR;
    m.is_cancelled = cancelled;
    m.error_message = strdup(err_msg);
    xQueueSend(mik__http(rt)->result_queue, &m, 0);
}

/* Copy a JS string property from globalThis into a caller-provided buffer.
 * Used when we need to extract a value before teardown so TEST_ASSERT can
 * run safely after cleanup. */
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

static int32_t read_global_int(const char* key) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, key);
    int32_t n = 0;
    JS_ToInt32(ctx, &n, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return n;
}

static bool read_global_bool(const char* key) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, key);
    bool b = JS_ToBool(ctx, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return b;
}

/* ── Module structure tests ───────────────────────────────────────── */

TEST_CASE("native:mikro/http exports request, nextMessage, cancel", "[http]") {
    setup();

    JSValue ret = eval_module(R"(
        import { request, nextMessage, cancel } from "native:mikro/http";
        globalThis.__requestType = typeof request;
        globalThis.__nextType = typeof nextMessage;
        globalThis.__cancelType = typeof cancel;
    )");
    bool evalOk = !JS_IsException(ret);

    char types[3][32] = {};
    read_global_string("__requestType", types[0], sizeof(types[0]));
    read_global_string("__nextType", types[1], sizeof(types[1]));
    read_global_string("__cancelType", types[2], sizeof(types[2]));

    teardown();

    TEST_ASSERT_TRUE_MESSAGE(evalOk, "Module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("function", types[0]);
    TEST_ASSERT_EQUAL_STRING("function", types[1]);
    TEST_ASSERT_EQUAL_STRING("function", types[2]);
}

TEST_CASE("native:mikro/http cannot be imported from non-internal module", "[http]") {
    setup();
    const char* code = R"(
        import { request } from "native:mikro/http";
    )";
    JSValue ret = MIK_EvalModuleContent(ctx, "/user/app.js", code, strlen(code));
    bool wasException = JS_IsException(ret);
    if (wasException) {
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
    }
    teardown();

    TEST_ASSERT_TRUE_MESSAGE(wasException,
                             "Importing native:mikro/http from user module should fail");
}

TEST_CASE("http state is lazily initialized", "[http]") {
    setup();
    bool nullBeforeImport = (mik__http(rt) == nullptr);
    ensure_http_initialized();
    bool notNullAfterImport = (mik__http(rt) != nullptr);
    bool queueOk = notNullAfterImport && (mik__http(rt)->result_queue != nullptr);
    bool inflightOk = notNullAfterImport && (mik__http(rt)->inflight != nullptr);
    size_t pendingCount = notNullAfterImport ? mik__http(rt)->pending_count : 999;
    teardown();

    TEST_ASSERT_TRUE_MESSAGE(nullBeforeImport, "HTTP state should not exist before import");
    TEST_ASSERT_TRUE_MESSAGE(notNullAfterImport,
                             "HTTP state should be initialized after import");
    TEST_ASSERT_TRUE(queueOk);
    TEST_ASSERT_TRUE(inflightOk);
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "No pending requests initially");
}

TEST_CASE("http consume with no messages is a no-op", "[http]") {
    setup();
    ensure_http_initialized();
    mik__http_consume(ctx);
    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_EQUAL(0, pendingCount);
}

/* ── Streaming protocol tests ─────────────────────────────────────── */

/* Seed a pending entry that isn't backed by a real background task.
 * The `cancelled` flag is intentionally null so `mik__http_destroy`
 * doesn't wait for a terminator message that will never arrive.
 * Tests that exercise the cancel path allocate it themselves. */
static JSValue seed_pending(uint32_t* out_id) {
    MIKHttpPending pending = {};
    pending.id = mik__http(rt)->next_id++;
    JSValue headers_promise = MIK_InitPromise(ctx, &pending.headers_promise);
    mik__http(rt)->pending[mik__http(rt)->pending_count++] = pending;
    *out_id = pending.id;
    return headers_promise;
}

TEST_CASE("headers message resolves headers promise with status and pairs", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__hp", JS_DupValue(ctx, headers_promise));
    JS_FreeValue(ctx, headers_promise);
    JS_FreeValue(ctx, global);

    eval_module(R"(
        globalThis.__status = -1;
        globalThis.__headerKey = "";
        globalThis.__hp.then((r) => {
            globalThis.__status = r.value.status;
            if (r.value.headers.length > 0) globalThis.__headerKey = r.value.headers[0][0];
        });
    )");

    auto* hdrs = static_cast<MIKHttpHeader*>(malloc(sizeof(MIKHttpHeader)));
    hdrs[0].key = strdup("Content-Type");
    hdrs[0].value = strdup("text/plain");
    push_headers(id, 200, hdrs, 1);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    int32_t status = read_global_int("__status");
    char headerKey[64];
    read_global_string("__headerKey", headerKey, sizeof(headerKey));

    push_end(id);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);
    teardown();

    TEST_ASSERT_EQUAL_INT32_MESSAGE(200, status, "headers promise delivers status");
    TEST_ASSERT_EQUAL_STRING("Content-Type", headerKey);
}

TEST_CASE("nextMessage delivers buffered chunks in order", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);
    JS_FreeValue(ctx, headers_promise);

    char code[512];
    snprintf(code, sizeof(code),
             "import { nextMessage } from 'native:mikro/http';"
             "globalThis.__body = '';"
             "(async () => {"
             "  for (;;) {"
             "    const m = await nextMessage(%u);"
             "    if (m.kind === 'chunk') globalThis.__body += new TextDecoder().decode(m.data);"
             "    else break;"
             "  }"
             "})();",
             id);
    eval_module(code);

    push_headers(id, 200, nullptr, 0);
    push_chunk(id, "Hello, ");
    push_chunk(id, "world");
    push_end(id);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    char body[64];
    read_global_string("__body", body, sizeof(body));
    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_EQUAL_STRING_MESSAGE("Hello, world", body, "chunks concat in order");
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "pending cleared after END delivered");
}

TEST_CASE("error message surfaces kind/cancelled/message fields", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);
    JS_FreeValue(ctx, headers_promise);

    char code[512];
    snprintf(code, sizeof(code),
             "import { nextMessage } from 'native:mikro/http';"
             "globalThis.__kind = '';"
             "globalThis.__cancelled = null;"
             "globalThis.__message = '';"
             "(async () => {"
             "  const m = await nextMessage(%u);"
             "  globalThis.__kind = m.kind;"
             "  if (m.kind === 'error') {"
             "    globalThis.__cancelled = m.cancelled;"
             "    globalThis.__message = m.message;"
             "  }"
             "})();",
             id);
    eval_module(code);

    push_headers(id, 200, nullptr, 0);
    push_error(id, "connection reset", /*cancelled=*/false);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    char kind[32];
    char message[64];
    read_global_string("__kind", kind, sizeof(kind));
    read_global_string("__message", message, sizeof(message));
    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_EQUAL_STRING("error", kind);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("connection reset", message,
                                     "error message carried through to JS");
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "pending cleared after error");
}

TEST_CASE("error before headers resolves headers promise with failure", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__hp", JS_DupValue(ctx, headers_promise));
    JS_FreeValue(ctx, headers_promise);
    JS_FreeValue(ctx, global);

    /* Native error is a {name, message} tag; the pre-headers error path
     * emits "Network" (or "Aborted" when cancelled). */
    eval_module(R"(
        globalThis.__ok = "pending";
        globalThis.__errorName = "";
        globalThis.__hp.then((r) => {
            globalThis.__ok = r.ok ? "true" : "false";
            if (!r.ok) globalThis.__errorName = r.error.name;
        });
    )");

    push_error(id, "connection refused", /*cancelled=*/false);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    char ok[16];
    char errorName[32];
    read_global_string("__ok", ok, sizeof(ok));
    read_global_string("__errorName", errorName, sizeof(errorName));
    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_EQUAL_STRING_MESSAGE(
        "false", ok, "headers promise resolves with ok=false on pre-headers error");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("Network", errorName,
                                     "error name is Network for non-cancelled failure");
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "pending dropped after pre-headers error");
}

TEST_CASE("error before headers also resolves pending nextMessage", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__hp", JS_DupValue(ctx, headers_promise));
    JS_FreeValue(ctx, headers_promise);
    JS_FreeValue(ctx, global);

    /* Caller awaits nextMessage before awaiting headers — unusual but
     * defensible. Pre-headers error must resolve both, or the async
     * nextMessage hangs and JSValues leak. */
    char code[512];
    snprintf(code, sizeof(code),
             "import { nextMessage } from 'native:mikro/http';"
             "globalThis.__headersOk = null;"
             "globalThis.__nextKind = '';"
             "globalThis.__hp.then((r) => { globalThis.__headersOk = r.ok; });"
             "(async () => {"
             "  const m = await nextMessage(%u);"
             "  globalThis.__nextKind = m.kind;"
             "})();",
             id);
    eval_module(code);

    push_error(id, "DNS failure", /*cancelled=*/false);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    bool headersOk = read_global_bool("__headersOk");
    char nextKind[32];
    read_global_string("__nextKind", nextKind, sizeof(nextKind));
    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_FALSE_MESSAGE(headersOk, "headers resolved with ok=false");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("error", nextKind, "nextMessage resolved with error kind");
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "pending dropped");
}

TEST_CASE("cancel sets the pending cancelled flag", "[http]") {
    setup();
    ensure_http_initialized();

    uint32_t id;
    JSValue headers_promise = seed_pending(&id);
    JS_FreeValue(ctx, headers_promise);

    MIKHttpPending* p = nullptr;
    for (size_t i = 0; i < mik__http(rt)->pending_count; i++) {
        if (mik__http(rt)->pending[i].id == id) p = &mik__http(rt)->pending[i];
    }
    bool foundPending = (p != nullptr);
    /* Allocate the cancel flag that a real background task would own.
     * Ownership transfers to the pending entry: mik__pending_drop (called
     * from the ERROR-before-HEADERS path in mik__http_consume below) will
     * free it. Do not delete it from the test. */
    auto* flag = new std::atomic<bool>(false);
    if (p) p->cancelled = flag;

    /* JS calls cancel(id) and also awaits nextMessage so the pending entry
     * drains cleanly once we simulate the task's ERROR response. */
    char code[512];
    snprintf(code, sizeof(code),
             "import { cancel, nextMessage } from 'native:mikro/http';"
             "cancel(%u);"
             "(async () => { await nextMessage(%u); })();",
             id, id);
    eval_module(code);
    bool flagAfterCancel = flag->load();

    /* Simulate the task posting an error after seeing the cancelled flag.
     * consume resolves via the pre-headers-error path and drops the pending. */
    push_error(id, "cancelled", true);
    mik__http_consume(ctx);
    mik__execute_jobs(ctx);

    size_t pendingCount = mik__http(rt)->pending_count;
    teardown();

    TEST_ASSERT_TRUE(foundPending);
    TEST_ASSERT_TRUE_MESSAGE(flagAfterCancel, "cancel sets the shared flag");
    TEST_ASSERT_EQUAL_MESSAGE(0, pendingCount, "pending dropped after cancellation settles");
}

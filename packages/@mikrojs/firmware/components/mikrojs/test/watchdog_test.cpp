#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "mikrojs/platform.h"
#include "private.h"
#include "quickjs.h"
#include "soc/soc_caps.h"
#include "unity.h"

/* The portable layers (blocking, feed, awake) are covered on the host. These
 * check what only exists on silicon: the platform hook, lightSleep's budget
 * re-stamp with esp_timer really counting through the sleep, the REPL
 * surviving a timeout, and the limits MIK_SetConfig switches on.
 * The test firmware builds with CONFIG_ESP_TASK_WDT_EN=n, so nothing here
 * can reset the chip. */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup(int blocking_ms, int feed_ms, int awake_ms) {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    MIKConfig cfg;
    MIK_DefaultConfig(&cfg);
    cfg.blocking_timeout_ms = blocking_ms;
    cfg.feed_timeout_ms = feed_ms;
    cfg.awake_timeout_ms = awake_ms;
    MIK_SetConfig(rt, &cfg);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_script(const char* code) {
    return JS_Eval(ctx, code, strlen(code), "test.js", JS_EVAL_TYPE_GLOBAL);
}

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static bool global_bool(const char* name) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    bool b = JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return b;
}

/* Pump MIK_Loop until it reports a stop or `ms` elapse. True when stopped. */
static bool pump_until_stop(int ms) {
    int64_t deadline = esp_timer_get_time() + (int64_t)ms * 1000;
    while (esp_timer_get_time() < deadline) {
        if (MIK_Loop(rt) != 0) return true;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return false;
}

/* ── Platform hook ───────────────────────────────────────────────── */

TEST_CASE("feed_watchdog follows CONFIG_ESP_TASK_WDT_EN", "[watchdog]") {
    const MIKPlatform* platform = MIK_GetPlatform();
#if CONFIG_ESP_TASK_WDT_EN
    TEST_ASSERT_NOT_NULL(platform->feed_watchdog);
    platform->feed_watchdog(); /* unsubscribed task: must be harmless */
#else
    TEST_ASSERT_NULL(platform->feed_watchdog);
#endif
}

/* ── Blocking deadline ───────────────────────────────────────────── */

TEST_CASE("blocking watchdog interrupts a runaway loop", "[watchdog]") {
    setup(1000, 0, 0);
    int64_t t0 = esp_timer_get_time();
    JSValue ret = eval_script("while (true) {}");
    int64_t elapsed_ms = (esp_timer_get_time() - t0) / 1000;
    TEST_ASSERT_TRUE_MESSAGE(JS_IsException(ret), "runaway loop should be interrupted");
    JSValue exc = JS_GetException(ctx);
    TEST_ASSERT_TRUE_MESSAGE(JS_IsUncatchableError(exc), "the interrupt must be uncatchable");
    JS_FreeValue(ctx, exc);
    TEST_ASSERT_TRUE_MESSAGE(elapsed_ms >= 900 && elapsed_ms < 5000,
                             "should fire near the 1 s budget");
    teardown();
}

TEST_CASE("blocking watchdog error cannot be caught", "[watchdog]") {
    setup(1000, 0, 0);
    JSValue ret = eval_script(R"(
        globalThis.__caught = false;
        try { while (true) {} } catch (e) { globalThis.__caught = true; }
    )");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsException(ret), "runaway loop should be interrupted");
    JSValue exc = JS_GetException(ctx);
    JS_FreeValue(ctx, exc);
    TEST_ASSERT_FALSE_MESSAGE(global_bool("__caught"), "try/catch must not swallow the interrupt");
    teardown();
}

TEST_CASE("blocking watchdog leaves a loop under budget alone", "[watchdog]") {
    setup(2000, 0, 0);
    JSValue ret = eval_script(R"(
        const end = Date.now() + 500;
        while (Date.now() < end) {}
        globalThis.__done = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "loop under budget must not be interrupted");
    JS_FreeValue(ctx, ret);
    TEST_ASSERT_TRUE(global_bool("__done"));
    teardown();
}

/* Light sleep disconnects the UART console on targets without USB
   Serial/JTAG, which stalls the test monitor. Same skip as sleep_test.cpp. */
TEST_CASE("lightSleep past the blocking budget does not fire", "[watchdog]") {
#if !SOC_USB_SERIAL_JTAG_SUPPORTED
    TEST_IGNORE_MESSAGE("light sleep disconnects UART console, skipped on non-USB targets");
#endif
    setup(1000, 0, 0);
    JSValue ret = eval_module(R"(
        import { lightSleep } from "native:mikro/sleep";
        const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
        spin(300); /* lands a budget stamp well before the sleep */
        try {
            lightSleep({timer: 1500000});
        } catch (e) {
            globalThis.__skipped = true; /* board cannot light-sleep; not a watchdog failure */
        }
        spin(300); /* over budget only if the sleep was counted */
        globalThis.__done = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    if (global_bool("__skipped")) {
        teardown();
        TEST_IGNORE_MESSAGE("lightSleep unavailable on this board");
    }
    TEST_ASSERT_TRUE_MESSAGE(global_bool("__done"),
                             "lightSleep must not count against the blocking budget");
    teardown();
}

/* ── Feed deadline ───────────────────────────────────────────────── */

TEST_CASE("feed deadline stops a runtime that never feeds", "[watchdog]") {
    setup(0, 1000, 0);
    TEST_ASSERT_TRUE_MESSAGE(pump_until_stop(5000),
                             "loop should stop once the feed deadline passes");
    TEST_ASSERT_TRUE(MIK_IsStopRequested(rt));
    teardown();
}

TEST_CASE("watchdog.feed() keeps the feed deadline from firing", "[watchdog]") {
    setup(0, 1000, 0);
    JSValue ret = eval_module(R"(
        import { watchdog } from "mikro/watchdog";
        setInterval(() => watchdog.feed(), 100);
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    TEST_ASSERT_FALSE_MESSAGE(pump_until_stop(2500), "a fed runtime must not stop");
    teardown();
}

TEST_CASE("watchdog.feed() without a feed budget is a no-op", "[watchdog]") {
    setup(0, 0, 0);
    JSValue ret = eval_module(R"(
        import { watchdog } from "mikro/watchdog";
        watchdog.feed();
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    TEST_ASSERT_TRUE(global_bool("__ok"));
    teardown();
}

/* ── Awake budget ────────────────────────────────────────────────── */

static int s_error_calls;
static void count_errors(JSContext*, JSValue, void*) { s_error_calls++; }

TEST_CASE("awake budget stops the runtime without a JS error", "[watchdog]") {
    /* The budget counts from boot, so on a device that has been running the
     * suite it is already spent when the runtime starts counting. */
    setup(0, 0, 1000);
    s_error_calls = 0;
    MIK_SetErrorHandler(rt, count_errors, nullptr);
    TEST_ASSERT_TRUE_MESSAGE(pump_until_stop(3000), "loop should stop once the budget elapses");
    TEST_ASSERT_TRUE(MIK_IsStopRequested(rt));
    TEST_ASSERT_EQUAL_MESSAGE(0, s_error_calls,
                              "awake must not reach the error handler (OTA trial rollback)");
    teardown();
}

/* ── REPL survives a timeout ────────────────────────────────────────── */

struct MockTransport {
    std::vector<uint8_t> input;
    size_t pos = 0;
    std::vector<uint8_t> output;
};

static int mock_read(uint8_t* buf, size_t size, void* opaque) {
    auto* m = static_cast<MockTransport*>(opaque);
    if (m->pos >= m->input.size()) {
        errno = 0; /* not EAGAIN: true EOF */
        return -1;
    }
    size_t n = m->input.size() - m->pos;
    if (n > size) n = size;
    memcpy(buf, m->input.data() + m->pos, n);
    m->pos += n;
    return (int)n;
}

static void mock_write(const void* buf, size_t len, void* opaque) {
    auto* m = static_cast<MockTransport*>(opaque);
    auto* bytes = static_cast<const uint8_t*>(buf);
    m->output.insert(m->output.end(), bytes, bytes + len);
}

static void append_frame(std::vector<uint8_t>& buf, uint8_t type, const char* payload) {
    uint32_t len = payload ? (uint32_t)strlen(payload) : 0;
    buf.push_back(type);
    for (int i = 0; i < 4; i++) buf.push_back((uint8_t)(len >> (8 * i)));
    if (len > 0) buf.insert(buf.end(), payload, payload + len);
}

/* Payload of the first frame of `type`, or empty when none was sent. */
static std::string find_payload(const std::vector<uint8_t>& data, uint8_t type) {
    size_t pos = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= data.size()) {
        uint32_t len = (uint32_t)data[pos + 1] | ((uint32_t)data[pos + 2] << 8) |
                       ((uint32_t)data[pos + 3] << 16) | ((uint32_t)data[pos + 4] << 24);
        if (pos + MIK_PROTO_HEADER_SIZE + len > data.size()) break;
        if (data[pos] == type) {
            return std::string((const char*)data.data() + pos + MIK_PROTO_HEADER_SIZE, len);
        }
        pos += MIK_PROTO_HEADER_SIZE + len;
    }
    return "";
}

TEST_CASE("REPL eval of a runaway loop reports an error and the session survives",
          "[watchdog]") {
    setup(1000, 0, 0);
    MockTransport mock;
    append_frame(mock.input, MIK_CMD_EVAL, "while (true) {}");
    append_frame(mock.input, MIK_CMD_EVAL, "1 + 2");
    append_frame(mock.input, MIK_CMD_EXIT, nullptr);

    MIKReplTransport transport = {};
    transport.read = mock_read;
    transport.write = mock_write;
    transport.ctx = &mock;
    MIK_ProtocolOpen(&transport);
    MIK_ProtocolAttach(rt);
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_ProtocolClose();

    std::string err = find_payload(mock.output, MIK_MSG_EVAL_ERROR);
    TEST_ASSERT_TRUE_MESSAGE(err.find("InternalError") != std::string::npos,
                             "runaway eval should report the interrupt as an eval error");
    std::string result = find_payload(mock.output, MIK_MSG_RESULT);
    TEST_ASSERT_EQUAL_STRING_MESSAGE("3", result.c_str(),
                                     "the next eval should still answer");
    TEST_ASSERT_FALSE_MESSAGE(MIK_IsStopRequested(rt), "a REPL timeout must not stop the runtime");
    teardown();
}

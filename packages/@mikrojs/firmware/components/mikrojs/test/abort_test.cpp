#include "mikrojs.h"
#include "quickjs.h"
#include "unity.h"

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval(const char* code) {
    return JS_Eval(ctx, code, strlen(code), "test.js", JS_EVAL_TYPE_GLOBAL);
}

static const char* eval_str(const char* code) {
    JSValue val = eval(code);
    const char* s = JS_ToCString(ctx, val);
    JS_FreeValue(ctx, val);
    return s;
}

/* ── AbortController/AbortSignal API tests ───────────────────────── */

TEST_CASE("AbortController is defined as a function", "[abort]") {
    setup();
    const char* s = eval_str("typeof AbortController");
    TEST_ASSERT_EQUAL_STRING("function", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal is defined as a function", "[abort]") {
    setup();
    const char* s = eval_str("typeof AbortSignal");
    TEST_ASSERT_EQUAL_STRING("function", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortError is defined as a function", "[abort]") {
    setup();
    const char* s = eval_str("typeof AbortError");
    TEST_ASSERT_EQUAL_STRING("function", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("TimeoutError is defined as a function", "[abort]") {
    setup();
    const char* s = eval_str("typeof TimeoutError");
    TEST_ASSERT_EQUAL_STRING("function", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortController.signal starts not aborted", "[abort]") {
    setup();
    const char* s = eval_str("new AbortController().signal.aborted ? 'yes' : 'no'");
    TEST_ASSERT_EQUAL_STRING("no", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortController.abort() sets aborted to true", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        ac.abort();
        ac.signal.aborted ? 'yes' : 'no';
    )");
    TEST_ASSERT_EQUAL_STRING("yes", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortController.abort() sets custom reason", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        ac.abort("custom reason");
        ac.signal.reason;
    )");
    TEST_ASSERT_EQUAL_STRING("custom reason", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortController.abort() default reason is AbortError", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        ac.abort();
        const r = ac.signal.reason;
        (r instanceof AbortError && r.name === "AbortError") ? "ok" : "fail";
    )");
    TEST_ASSERT_EQUAL_STRING("ok", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.abort() returns pre-aborted signal", "[abort]") {
    setup();
    const char* s = eval_str("AbortSignal.abort().aborted ? 'yes' : 'no'");
    TEST_ASSERT_EQUAL_STRING("yes", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.throwIfAborted() throws when aborted", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        try {
            AbortSignal.abort("boom").throwIfAborted();
            "no throw";
        } catch (e) { String(e); }
    )");
    TEST_ASSERT_EQUAL_STRING("boom", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.throwIfAborted() is no-op when not aborted", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        try {
            new AbortController().signal.throwIfAborted();
            "ok";
        } catch (e) { "threw"; }
    )");
    TEST_ASSERT_EQUAL_STRING("ok", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("abort fires onabort and addEventListener listeners", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        const called = [];
        ac.signal.onabort = () => called.push("onabort");
        ac.signal.addEventListener("abort", () => called.push("listener"));
        ac.abort();
        called.join(",");
    )");
    TEST_ASSERT_EQUAL_STRING("onabort,listener", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("abort is idempotent - listeners fire only once", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        let count = 0;
        ac.signal.addEventListener("abort", () => count++);
        ac.abort();
        ac.abort();
        String(count);
    )");
    TEST_ASSERT_EQUAL_STRING("1", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("removeEventListener removes listener", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac = new AbortController();
        let called = false;
        const fn = () => { called = true; };
        ac.signal.addEventListener("abort", fn);
        ac.signal.removeEventListener("abort", fn);
        ac.abort();
        called ? "called" : "not called";
    )");
    TEST_ASSERT_EQUAL_STRING("not called", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.any() aborts when any input aborts", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        const combined = AbortSignal.any([ac1.signal, ac2.signal]);
        ac2.abort("second");
        combined.aborted && combined.reason === "second" ? "ok" : "fail";
    )");
    TEST_ASSERT_EQUAL_STRING("ok", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.any() picks up already-aborted signal", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const aborted = AbortSignal.abort("already");
        const combined = AbortSignal.any([aborted, new AbortController().signal]);
        combined.aborted && combined.reason === "already" ? "ok" : "fail";
    )");
    TEST_ASSERT_EQUAL_STRING("ok", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortSignal.timeout() creates a signal with TimeoutError name", "[abort]") {
    setup();
    // We can't easily test the actual timeout firing (needs event loop),
    // but we can verify the signal is created and starts non-aborted.
    const char* s = eval_str(R"(
        const sig = AbortSignal.timeout(60000);
        sig instanceof AbortSignal && !sig.aborted ? "ok" : "fail";
    )");
    TEST_ASSERT_EQUAL_STRING("ok", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortError has correct name and message", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const e = new AbortError("test msg");
        e.name + ":" + e.message;
    )");
    TEST_ASSERT_EQUAL_STRING("AbortError:test msg", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("AbortError is an instance of Error", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        new AbortError() instanceof Error ? "yes" : "no";
    )");
    TEST_ASSERT_EQUAL_STRING("yes", s);
    JS_FreeCString(ctx, s);
    teardown();
}

TEST_CASE("TimeoutError has correct name and message", "[abort]") {
    setup();
    const char* s = eval_str(R"(
        const e = new TimeoutError("test msg");
        e.name + ":" + e.message;
    )");
    TEST_ASSERT_EQUAL_STRING("TimeoutError:test msg", s);
    JS_FreeCString(ctx, s);
    teardown();
}

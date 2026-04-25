#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

static JSValue eval(JSContext* ctx, const char* code) {
    return JS_Eval(ctx, code, strlen(code), "test.js", JS_EVAL_TYPE_GLOBAL);
}

static const char* eval_str(JSContext* ctx, const char* code) {
    JSValue val = eval(ctx, code);
    const char* s = JS_ToCString(ctx, val);
    JS_FreeValue(ctx, val);
    return s;
}

TEST_CASE("AbortController is defined" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, "typeof AbortController");
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    s = eval_str(ctx, "typeof AbortSignal");
    CHECK_EQ(std::string("function"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController.signal starts not aborted" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, "new AbortController().signal.aborted ? 'yes' : 'no'");
    CHECK_EQ(std::string("no"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController.abort() sets aborted to true" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        ac.abort();
        ac.signal.aborted ? 'yes' : 'no';
    )");
    CHECK_EQ(std::string("yes"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController.abort() sets reason" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        ac.abort("custom reason");
        ac.signal.reason;
    )");
    CHECK_EQ(std::string("custom reason"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController.abort() default reason is AbortError" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        ac.abort();
        ac.signal.reason instanceof AbortError && ac.signal.reason.name === "AbortError" ? "ok" : "fail";
    )");
    CHECK_EQ(std::string("ok"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortSignal.abort() returns pre-aborted signal" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, "AbortSignal.abort().aborted ? 'yes' : 'no'");
    CHECK_EQ(std::string("yes"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortSignal.throwIfAborted() throws when aborted" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        try {
            AbortSignal.abort("boom").throwIfAborted();
            "no throw";
        } catch (e) {
            e;
        }
    )");
    CHECK_EQ(std::string("boom"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortSignal.throwIfAborted() does nothing when not aborted" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        try {
            new AbortController().signal.throwIfAborted();
            "ok";
        } catch (e) {
            "threw";
        }
    )");
    CHECK_EQ(std::string("ok"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController calls onabort and listeners" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        let called = [];
        ac.signal.onabort = () => called.push("onabort");
        ac.signal.addEventListener("abort", () => called.push("listener"));
        ac.abort();
        called.join(",");
    )");
    CHECK_EQ(std::string("onabort,listener"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortController.abort() is idempotent" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        let count = 0;
        ac.signal.addEventListener("abort", () => count++);
        ac.abort();
        ac.abort();
        String(count);
    )");
    CHECK_EQ(std::string("1"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortSignal.any() aborts when any input aborts" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        const combined = AbortSignal.any([ac1.signal, ac2.signal]);
        ac2.abort("second");
        combined.aborted && combined.reason === "second" ? "ok" : "fail";
    )");
    CHECK_EQ(std::string("ok"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("AbortSignal.any() picks up already-aborted signal" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const aborted = AbortSignal.abort("already");
        const combined = AbortSignal.any([aborted, new AbortController().signal]);
        combined.aborted && combined.reason === "already" ? "ok" : "fail";
    )");
    CHECK_EQ(std::string("ok"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

TEST_CASE("removeEventListener removes listener" * doctest::test_suite("runtime")) {
    auto rt = MIK_NewRuntime();
    auto ctx = MIK_GetJSContext(rt);

    const char* s = eval_str(ctx, R"(
        const ac = new AbortController();
        let called = false;
        const fn = () => { called = true; };
        ac.signal.addEventListener("abort", fn);
        ac.signal.removeEventListener("abort", fn);
        ac.abort();
        called ? "called" : "not called";
    )");
    CHECK_EQ(std::string("not called"), std::string(s));
    JS_FreeCString(ctx, s);

    MIK_FreeRuntime(rt);
}

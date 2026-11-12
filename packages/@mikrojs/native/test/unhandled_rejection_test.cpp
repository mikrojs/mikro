#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

#include "temp_dir.h"

namespace {

struct TmpDir {
    std::string path;
    TmpDir() {
        path = mik_test_temp_dir("mikrojs-unhandled");
    }
    std::string write(const char* name, const char* content) {
        std::string p = path + "/" + name;
        FILE* f = fopen(p.c_str(), "w");
        REQUIRE(f != nullptr);
        fputs(content, f);
        fclose(f);
        return p;
    }
};

std::string g_captured;

int capture_stderr(const void* buf, size_t len) {
    g_captured.append(static_cast<const char*>(buf), len);
    return (int)len;
}

int count_uncaught(const std::string& s) {
    int n = 0;
    size_t pos = 0;
    while ((pos = s.find("Uncaught", pos)) != std::string::npos) {
        n++;
        pos += 8;
    }
    return n;
}

/* Captures stderr into g_captured and restores the platform even when a
 * REQUIRE unwinds. */
struct CaptureStderr {
    const MIKPlatform* saved = MIK_GetPlatform();
    MIKPlatform mock = *saved;
    CaptureStderr() {
        mock.stderr_write = capture_stderr;
        MIK_SetPlatform(&mock);
        g_captured.clear();
    }
    ~CaptureStderr() { MIK_SetPlatform(saved); }
};

JSValue eval_global(JSContext* ctx, const char* src) {
    return JS_Eval(ctx, src, strlen(src), "<test>", JS_EVAL_TYPE_GLOBAL);
}

// Run an entry module to completion and return how many "Uncaught" reports
// it produced. No clock mocking and no sleeps: the result depends only on
// event-loop turns, never on wall-clock timing.
int run_and_count_reports(const std::string& entry) {
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform mock = *orig;
    mock.stderr_write = capture_stderr;
    MIK_SetPlatform(&mock);
    g_captured.clear();

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    JSValue r = MIK_EvalModule(ctx, entry.c_str(), true);
    JS_FreeValue(ctx, r);
    for (int i = 0; i < 20; i++) MIK_Loop(rt);

    int n = count_uncaught(g_captured);
    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);
    return n;
}

}  // namespace

/* A failed dynamic import rejects the module's evaluation promise (which the
 * loader then handles) AND the awaited import() promise. With deferred
 * reporting, only the genuinely-unhandled one is reported: exactly once. */
TEST_CASE("uncaught failed dynamic import reports once" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    dir.write("dep.js", "export const x = 1;\n");
    dir.write("wifi.js",
              "import {x} from './dep.js';\n"
              "throw new Error('WiFi init failed: ESP_ERR_NO_MEM');\n");
    std::string main = dir.write(
        "main.js",
        "async function go() { return await import('./wifi.js'); }\n"
        "await go();\n");

    CHECK_EQ(run_and_count_reports(main), 1);
}

/* A caught failed dynamic import reports nothing. QuickJS-NG 0.16 marks the
 * module's internal evaluation promise as handled (it reads the rejection by
 * value, never attaching a handler), so the only observable rejection is the
 * import() promise the catch block handles. Before 0.16 this surfaced one
 * residual engine-internal report. */
TEST_CASE("caught failed dynamic import reports nothing" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    dir.write("wifi.js", "throw new Error('WiFi init failed: ESP_ERR_NO_MEM');\n");
    std::string main = dir.write(
        "main.js",
        "try { await import('./wifi.js'); } catch { /* handled */ }\n");

    CHECK_EQ(run_and_count_reports(main), 0);
}

/* A caught await of a synchronously-throwing async function must report
 * nothing. The function's result promise is born rejected before `await`
 * attaches its handler; deferral lets the handler cancel the pending report
 * before the end-of-turn flush. (The old eager tracker reported this.) */
TEST_CASE("caught await of throwing async fn reports nothing" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    std::string main = dir.write(
        "main.js",
        "async function f() { throw new Error('boom'); }\n"
        "try { await f(); } catch (e) { /* handled */ }\n");
    CHECK_EQ(run_and_count_reports(main), 0);
}

/* A plain unhandled rejection still reports exactly once. */
TEST_CASE("unhandled Promise.reject reports once" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    std::string main = dir.write("main.js", "Promise.reject(new Error('nope'));\n");

    CHECK_EQ(run_and_count_reports(main), 1);
}

/* A rejection that gets a handler attached in a later turn is reported (it
 * WAS unhandled at the end of its turn), but only once. */
TEST_CASE("rejection handled in a later turn still reports once" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    std::string main = dir.write("main.js", "const p = Promise.reject(new Error('late'));\n");

    CHECK_EQ(run_and_count_reports(main), 1);
}

/* Two unhandled promises derived from one rejected promise share its reason:
 * the error is reported once, not once per promise. */
TEST_CASE("forked rejection with one reason reports once" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    std::string main = dir.write(
        "main.js",
        "const p = Promise.reject(new Error('boom'));\n"
        "p.then(() => 1);\n"
        "p.then(() => 2);\n");

    CHECK_EQ(run_and_count_reports(main), 1);
}

/* Guards the flush-time reason dedup against over-collapsing: two DISTINCT
 * unhandled rejections in the same turn must both be reported, never merged.
 * (The dedup keys on reason identity; a regression here would silently
 * swallow real errors.) */
TEST_CASE("distinct unhandled rejections in one turn each report" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    std::string main = dir.write(
        "main.js",
        "Promise.reject(new Error('first'));\n"
        "Promise.reject(new Error('second'));\n");

    CHECK_EQ(run_and_count_reports(main), 2);
}

/* mik__report_uncaught dedups by error-object identity. Reporting the SAME
 * object twice prints once and returns false the second time; a DISTINCT
 * object reports again. */
TEST_CASE("report_uncaught dedups same error object, not distinct ones" *
          doctest::test_suite("unhandled-rejection")) {
    CaptureStderr capture;

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    JSValue e = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, "boom"));
    CHECK(mik__report_uncaught(ctx, e, true));   // first: reports
    CHECK_FALSE(mik__report_uncaught(ctx, e, true));  // same object: deduped
    CHECK_EQ(count_uncaught(g_captured), 1);

    /* The marker is a private symbol: user code can't see it. */
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__e", JS_DupValue(ctx, e));
    JSValue keys = eval_global(ctx, "Reflect.ownKeys(__e).join()");
    REQUIRE_FALSE(JS_IsException(keys));
    const char* keys_str = JS_ToCString(ctx, keys);
    REQUIRE(keys_str);
    CHECK_EQ(std::string(keys_str), "message");
    JS_FreeCString(ctx, keys_str);
    JS_FreeValue(ctx, keys);
    JS_FreeValue(ctx, global);

    JSValue other = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, other, "message", JS_NewString(ctx, "different"));
    CHECK(mik__report_uncaught(ctx, other, true));  // distinct object: reports
    CHECK_EQ(count_uncaught(g_captured), 2);

    JS_FreeValue(ctx, e);
    JS_FreeValue(ctx, other);
    MIK_FreeRuntime(rt);
}

/* A Proxy reason is reported without marking, so its traps never receive the
 * marker. Printing the error reads properties but never calls has or
 * defineProperty, so any key there is the marker; getOwnPropertyDescriptor
 * also serves printing, so only symbol keys count there. */
TEST_CASE("report_uncaught keeps the marker away from Proxy traps" *
          doctest::test_suite("unhandled-rejection")) {
    CaptureStderr capture;

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    JSValue p = eval_global(ctx,
                            "globalThis.seen = [];"
                            "new Proxy(new Error('boom'), {"
                            "  has(t, k) { seen.push(k); return Reflect.has(t, k); },"
                            "  defineProperty(t, k, d) {"
                            "    seen.push(k); return Reflect.defineProperty(t, k, d); },"
                            "  getOwnPropertyDescriptor(t, k) {"
                            "    if (typeof k === 'symbol') seen.push(k);"
                            "    return Reflect.getOwnPropertyDescriptor(t, k); },"
                            "})");
    REQUIRE_FALSE(JS_IsException(p));
    CHECK(mik__report_uncaught(ctx, p, true));
    CHECK_EQ(count_uncaught(g_captured), 1);

    JSValue seen = eval_global(ctx, "seen.length");
    int32_t n = -1;
    JS_ToInt32(ctx, &n, seen);
    CHECK_EQ(n, 0);

    JS_FreeValue(ctx, seen);
    JS_FreeValue(ctx, p);
    MIK_FreeRuntime(rt);
}

/* The marker is checked as an own property: an error whose prototype is an
 * already-reported error is a distinct error and reports. */
TEST_CASE("report_uncaught reports an error inheriting from a reported one" *
          doctest::test_suite("unhandled-rejection")) {
    CaptureStderr capture;

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    JSValue a = eval_global(ctx, "globalThis.a = new Error('first'); a");
    REQUIRE_FALSE(JS_IsException(a));
    CHECK(mik__report_uncaught(ctx, a, true));

    JSValue b = eval_global(ctx, "Object.create(a)");
    REQUIRE_FALSE(JS_IsException(b));
    CHECK(mik__report_uncaught(ctx, b, true));
    CHECK_EQ(count_uncaught(g_captured), 2);

    JS_FreeValue(ctx, a);
    JS_FreeValue(ctx, b);
    MIK_FreeRuntime(rt);
}

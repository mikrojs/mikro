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

namespace {

struct TmpDir {
    std::string path;
    TmpDir() {
        char tmpl[] = "/tmp/mikrojs-unhandled-XXXXXX";
        const char* d = mkdtemp(tmpl);
        REQUIRE(d != nullptr);
        path = d;
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

/* KNOWN RESIDUAL: a caught failed dynamic import still surfaces ONE report.
 * QuickJS runs a module body as an async function (js_execute_sync_module)
 * and resolves the resulting promise by value, never attaching a handler;
 * when the body throws, that internal promise is rejected-and-never-handled
 * and there is no host-side signal that it was "handled". Fully silencing
 * this requires marking that promise handled inside QuickJS. Until then the
 * deferred tracker reports it once (down from the pre-fix behaviour, and the
 * propagated/await-chain duplicate is collapsed by reason identity). */
TEST_CASE("caught failed dynamic import: one residual engine-internal report" *
          doctest::test_suite("unhandled-rejection")) {
    TmpDir dir;
    dir.write("wifi.js", "throw new Error('WiFi init failed: ESP_ERR_NO_MEM');\n");
    std::string main = dir.write(
        "main.js",
        "try { await import('./wifi.js'); } catch { /* handled */ }\n");

    CHECK_EQ(run_and_count_reports(main), 1);
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

/* mik__report_uncaught dedups by error-object identity across report paths.
 * This is what keeps the REPL throw-path report and the deferred flush from
 * printing the same error twice, and lets the flush collapse a dynamic
 * import's two same-reason rejections. Reporting the SAME object twice prints
 * once and returns false the second time; a DISTINCT object reports again. */
TEST_CASE("report_uncaught dedups same error object, not distinct ones" *
          doctest::test_suite("unhandled-rejection")) {
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform mock = *orig;
    mock.stderr_write = capture_stderr;
    MIK_SetPlatform(&mock);
    g_captured.clear();

    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    JSValue e = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, e, "message", JS_NewString(ctx, "boom"));
    CHECK(mik__report_uncaught(ctx, e, true));   // first: reports
    CHECK_FALSE(mik__report_uncaught(ctx, e, true));  // same object: deduped
    CHECK_EQ(count_uncaught(g_captured), 1);

    JSValue other = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, other, "message", JS_NewString(ctx, "different"));
    CHECK(mik__report_uncaught(ctx, other, true));  // distinct object: reports
    CHECK_EQ(count_uncaught(g_captured), 2);

    JS_FreeValue(ctx, e);
    JS_FreeValue(ctx, other);
    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);
}

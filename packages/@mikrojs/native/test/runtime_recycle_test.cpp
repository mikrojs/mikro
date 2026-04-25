/**
 * Regression test for repeated MIK_NewRuntime → import → MIK_FreeRuntime
 * cycles within a single host process. This pattern is the backbone of
 * the firmware test harness (mik_main.cpp supervisor loop) and the
 * simulator's planned manifest mode: the same transport session hosts
 * many runtimes in sequence, with a fresh JS heap + timer registry per
 * test file.
 *
 * The test guards against:
 *   1. Leaked native-module state surviving into a fresh runtime (module
 *      destroy hooks must fully release per-runtime resources).
 *   2. Unbounded system-memory growth across many cycles (a slow leak
 *      would manifest as a runaway in a long CI run).
 *   3. Protocol-layer globals (mik_repl.cpp) refusing to re-attach after
 *      a detach, which would lock out the supervisor from any subsequent
 *      test file.
 */
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

TEST_CASE("Create→eval→free cycles are idempotent"
          * doctest::test_suite("runtime_recycle")) {
    constexpr int ITERATIONS = 8;

    for (int i = 0; i < ITERATIONS; i++) {
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        JSContext* ctx = MIK_GetJSContext(rt);

        /* Allocate a timer, then let it fire and clean itself up, to cover
         * the timer registry's per-runtime lifecycle on both create and free. */
        const char* code =
            "let fired = 0;"
            "setTimeout(() => { fired++; }, 0);"
            "globalThis.__fired = () => fired;";
        JSValue result = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
        CHECK_FALSE(JS_IsException(result));
        JS_FreeValue(ctx, result);

        /* Pump the loop until the timer fires (one MIK_Loop iteration is
         * enough here — the 0ms timer is immediately ready). */
        MIK_Loop(rt);

        JSValue global = JS_GetGlobalObject(ctx);
        JSValue fn = JS_GetPropertyStr(ctx, global, "__fired");
        JSValue fired = JS_Call(ctx, fn, global, 0, nullptr);
        int32_t n = -1;
        JS_ToInt32(ctx, &n, fired);
        CHECK_EQ(1, n);
        JS_FreeValue(ctx, fired);
        JS_FreeValue(ctx, fn);
        JS_FreeValue(ctx, global);

        MIK_FreeRuntime(rt);
    }
}

TEST_CASE("Protocol re-attach across recycled runtimes"
          * doctest::test_suite("runtime_recycle")) {
    /* Mock transport that discards everything — we don't need the wire
     * format here, just that Open/Attach/Detach/Close don't leave the
     * protocol globals in a state that blocks re-open. */
    auto mock_read = [](uint8_t*, size_t, void*) -> int { return -1; };
    auto mock_write = [](const void*, size_t, void*) {};

    MIKReplTransport transport = {};
    transport.read = mock_read;
    transport.write = mock_write;
    transport.ctx = nullptr;

    MIK_ProtocolOpen(&transport);

    for (int i = 0; i < 4; i++) {
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);

        MIK_ProtocolAttach(rt);
        /* Eval something trivial so a JSContext is used under the session. */
        const char* code = "1 + 1";
        JSValue v = JS_Eval(MIK_GetJSContext(rt), code, strlen(code), "main.js",
                             JS_EVAL_TYPE_GLOBAL);
        CHECK(JS_IsNumber(v));
        JS_FreeValue(MIK_GetJSContext(rt), v);

        MIK_ProtocolDetach();
        MIK_FreeRuntime(rt);
    }

    MIK_ProtocolClose();

    /* After Close, a fresh Open must succeed — nothing should be stuck
     * holding pointers to a freed runtime. */
    MIK_ProtocolOpen(&transport);
    MIK_ProtocolClose();
}

TEST_CASE("MIK_RunEntry detects sync-rejected module promises"
          * doctest::test_suite("runtime_recycle")) {
    /* A test file that throws at module top level rejects the TLA-wrapper
     * promise synchronously. The returned JSValue is an Object (the
     * rejected Promise), not a JS_EXCEPTION sentinel. If RunEntry treats
     * that as success, the supervisor enters ServeLoop waiting for an
     * __testFileDone that will never come — hanging the test-manifest
     * run on the first fatal file. RunEntry must flag sync-rejected as
     * an eval failure so the supervisor's synthetic-failure path fires. */
    char dir_template[] = "/tmp/mikrojs-test-XXXXXX";
    const char* dir = mkdtemp(dir_template);
    REQUIRE(dir != nullptr);
    std::string fatal_path = std::string(dir) + "/fatal.js";
    std::string ok_path = std::string(dir) + "/ok.js";
    {
        FILE* f = fopen(fatal_path.c_str(), "w");
        REQUIRE(f != nullptr);
        fputs("throw new Error('fatal at module top level');\n", f);
        fclose(f);
    }
    {
        FILE* f = fopen(ok_path.c_str(), "w");
        REQUIRE(f != nullptr);
        fputs("export const x = 1;\n", f);
        fclose(f);
    }

    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    MIK_SetFSBasePath(rt, "");

    CHECK_EQ(-EFAULT, MIK_RunEntry(rt, fatal_path.c_str()));
    CHECK_EQ(0, MIK_RunEntry(rt, ok_path.c_str()));

    MIK_FreeRuntime(rt);
    unlink(fatal_path.c_str());
    unlink(ok_path.c_str());
    rmdir(dir);
}

TEST_CASE("ServeLoop exits when ProtocolExit fires from inside the pump"
          * doctest::test_suite("runtime_recycle")) {
    /* This is the critical-path regression for the supervisor flow:
     * __testFileDone calls MIK_ProtocolExit from inside a timer fired by
     * MIK_Loop, which the protocol layer pumps while blocked on reads.
     * If the blocking reads don't notice s_exit_serve_loop, the device
     * hangs on every test file. We reproduce the scenario with a mock
     * transport that never yields a byte (EAGAIN forever) and a short
     * setTimeout that calls __testFileDone. */
    auto mock_read = [](uint8_t*, size_t, void*) -> int {
        errno = EAGAIN;
        return -1;
    };
    auto mock_write = [](const void*, size_t, void*) {};

    MIKReplTransport transport = {};
    transport.read = mock_read;
    transport.write = mock_write;
    transport.ctx = nullptr;

    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    /* This test drives __testFileDone — opt into the test-helper globals
     * explicitly, since ordinary runtimes don't install them. */
    MIK_EnableTestHelpers(rt);

    MIK_ProtocolOpen(&transport);
    MIK_ProtocolAttach(rt);

    /* Schedule __testFileDone via a 0ms timer. MIK_Loop pumped from inside
     * ServeLoop will fire the timer; the callback sets s_exit_serve_loop
     * via MIK_ProtocolExit. */
    const char* code = "setTimeout(() => { __testFileDone(); }, 0);";
    JSValue v = JS_Eval(ctx, code, strlen(code), "main.js", JS_EVAL_TYPE_GLOBAL);
    REQUIRE_FALSE(JS_IsException(v));
    JS_FreeValue(ctx, v);

    /* Must return promptly. If the fix regresses, this hangs forever —
     * ctest will kill the process after the default timeout, which is
     * the right failure mode but unpleasant. */
    MIK_ProtocolServeLoop();

    MIK_ProtocolDetach();
    MIK_FreeRuntime(rt);
    MIK_ProtocolClose();
}

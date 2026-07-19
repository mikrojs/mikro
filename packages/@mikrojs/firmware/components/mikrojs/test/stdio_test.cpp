#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

static MIKRuntime* rt;
static JSContext* ctx;

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

/* ── stdout.write ─────────────────────────────────────────────────── */

TEST_CASE("stdout.write with string does not throw", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        stdout.write("hello from test\n");
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "stdout.write with string should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout.write with Uint8Array does not throw", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        const enc = new TextEncoder();
        stdout.write(enc.encode("binary data\n"));
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "stdout.write with Uint8Array should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout.write returns undefined", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        globalThis.__result = stdout.write("test");
        globalThis.__isUndef = globalThis.__result === undefined;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isUndef = JS_GetPropertyStr(ctx, global, "__isUndef");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isUndef), "stdout.write should return undefined");
    JS_FreeValue(ctx, isUndef);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout.write with empty string does not throw", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        stdout.write("");
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "stdout.write with empty string should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout.write with empty Uint8Array does not throw", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        stdout.write(new Uint8Array(0));
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok),
                             "stdout.write with empty Uint8Array should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

/* ── stdout.flush ─────────────────────────────────────────────────── */

TEST_CASE("stdout.flush does not throw", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        stdout.flush();
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "stdout.flush should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout.flush returns undefined", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        globalThis.__isUndef = stdout.flush() === undefined;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isUndef = JS_GetPropertyStr(ctx, global, "__isUndef");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isUndef), "stdout.flush should return undefined");
    JS_FreeValue(ctx, isUndef);
    JS_FreeValue(ctx, global);

    teardown();
}

/* ── stdin.read ───────────────────────────────────────────────────── */

TEST_CASE("stdin.read returns undefined when no data available", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        const data = stdin.read();
        globalThis.__isUndef = data === undefined;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isUndef = JS_GetPropertyStr(ctx, global, "__isUndef");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isUndef),
                             "stdin.read should return undefined when no data is available");
    JS_FreeValue(ctx, isUndef);
    JS_FreeValue(ctx, global);

    teardown();
}

/* ── stdin.setHandler / clearHandler ──────────────────────────────── */

TEST_CASE("stdin.setHandler accepts a function", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        stdin.setHandler(() => {});
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "stdin.setHandler should accept a function");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdin.setHandler throws TypeError for non-function", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        try {
            stdin.setHandler("not a function");
            globalThis.__threw = false;
        } catch (e) {
            globalThis.__threw = true;
            globalThis.__isTypeError = e instanceof TypeError;
        }
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw at top level");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue threw = JS_GetPropertyStr(ctx, global, "__threw");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, threw),
                             "stdin.setHandler should throw for non-function");
    JS_FreeValue(ctx, threw);

    JSValue isTypeError = JS_GetPropertyStr(ctx, global, "__isTypeError");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isTypeError),
                             "stdin.setHandler should throw a TypeError");
    JS_FreeValue(ctx, isTypeError);

    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdin.clearHandler does not throw when no handler set", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        stdin.clearHandler();
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok),
                             "stdin.clearHandler should be safe when no handler is set");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdin.clearHandler unregisters a previously set handler", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        stdin.setHandler(() => {});
        stdin.clearHandler();
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    /* Verify at the C level that on_data was reset to JS_UNDEFINED */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    TEST_ASSERT_TRUE_MESSAGE(JS_IsUndefined(mik_rt->stdin_state.on_data),
                             "on_data should be JS_UNDEFINED after clearHandler");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "clearHandler after setHandler should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdin.setHandler replaces previous handler", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        stdin.setHandler(() => { globalThis.__first = true; });
        stdin.setHandler(() => { globalThis.__second = true; });
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    /* Verify handler was set (on_data should not be undefined) */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsUndefined(mik_rt->stdin_state.on_data),
                              "on_data should be set after setHandler");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok), "Replacing handler should succeed");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

/* ── mik__stdin_consume (C-level event loop integration) ──────────── */

TEST_CASE("mik__stdin_consume is a no-op when no handler is registered", "[stdio]") {
    setup();

    /* Call consume with no handler — should not crash or throw */
    mik__stdin_consume(ctx);

    /* Verify on_data is still undefined */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    TEST_ASSERT_TRUE_MESSAGE(JS_IsUndefined(mik_rt->stdin_state.on_data),
                             "on_data should remain JS_UNDEFINED");

    teardown();
}

/* ── Module exports shape ─────────────────────────────────────────── */

TEST_CASE("native:mikro/stdio exports stdout and stdin objects", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout, stdin } from "native:mikro/stdio";
        globalThis.__hasStdout = typeof stdout === "object" && stdout !== null;
        globalThis.__hasStdin = typeof stdin === "object" && stdin !== null;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Importing native:mikro/stdio should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__hasStdout");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdout should be an object");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasStdin");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdin should be an object");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdout has write and flush functions", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        globalThis.__hasWrite = typeof stdout.write === "function";
        globalThis.__hasFlush = typeof stdout.flush === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__hasWrite");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdout.write should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasFlush");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdout.flush should be a function");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);

    teardown();
}

TEST_CASE("stdin has read, setHandler, and clearHandler functions", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        globalThis.__hasRead = typeof stdin.read === "function";
        globalThis.__hasSetHandler = typeof stdin.setHandler === "function";
        globalThis.__hasClearHandler = typeof stdin.clearHandler === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__hasRead");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdin.read should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasSetHandler");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdin.setHandler should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasClearHandler");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "stdin.clearHandler should be a function");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);

    teardown();
}

/* ── stdout.write coercion edge cases ─────────────────────────────── */

TEST_CASE("stdout.write coerces number to string", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdout } from "native:mikro/stdio";
        stdout.write(42);
        globalThis.__ok = true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ok = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, ok),
                             "stdout.write with a number should not throw");
    JS_FreeValue(ctx, ok);
    JS_FreeValue(ctx, global);

    teardown();
}

/* ── Runtime cleanup ──────────────────────────────────────────────── */

TEST_CASE("stdin handler is cleaned up on runtime free", "[stdio]") {
    setup();

    JSValue ret = eval_module(R"(
        import { stdin } from "native:mikro/stdio";
        stdin.setHandler((data) => {});
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    /* Verify handler is set before teardown */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsUndefined(mik_rt->stdin_state.on_data),
                              "on_data should be set before runtime free");

    /* teardown will call MIK_FreeRuntime — should not leak or crash */
    teardown();
}

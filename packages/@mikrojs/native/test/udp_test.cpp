#include <cstring>
#include <ctime>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

namespace {

/* Eval a JS module string and return the eval result.
 * Caller must JS_FreeValue. Errors are captured to globalThis.__err. */
static JSValue eval_module(JSContext* ctx, const char* src) {
    std::string code = src;
    code += "\n//# sourceURL=/test/udp_driver.js\n";
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "/test/udp_driver.js",
                        JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[eval_module] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
        if (JS_IsString(stack)) {
            const char* st = JS_ToCString(ctx, stack);
            if (st) {
                fprintf(stderr, "[eval_module stack] %s\n", st);
                JS_FreeCString(ctx, st);
            }
        }
        JS_FreeValue(ctx, stack);
        JS_FreeValue(ctx, exc);
    }
    return rv;
}

/* Pump the runtime loop until cond() returns true or `max_iter` ticks elapse. */
template <typename F>
static bool pump_until(MIKRuntime* rt, int max_iter, F cond) {
    for (int i = 0; i < max_iter; i++) {
        if (cond()) return true;
        MIK_Loop(rt);
        struct timespec ts = {0, 1 * 1000 * 1000};  // 1ms
        nanosleep(&ts, nullptr);
    }
    return cond();
}

static std::string read_global_string(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        return "";
    }
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

static int read_global_int(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    int32_t i = -1;
    JS_ToInt32(ctx, &i, v);
    JS_FreeValue(ctx, v);
    return i;
}

}  // namespace

TEST_CASE("mikrojs/udp module is importable" * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__hasBind = (typeof bind === 'function') ? 'yes' : 'no';\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK_EQ(read_global_string(ctx, "__hasBind"), "yes");

    MIK_FreeRuntime(rt);
}

TEST_CASE("bind() returns a socket bound to an ephemeral port" * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__done = 0;\n"
        "bind({port: 0, family: 'ipv4'}).then(r => {\n"
        "  if (r.ok) {\n"
        "    globalThis.__port = r.value.port;\n"
        "    globalThis.__family = r.value.family;\n"
        "    r.value.close();\n"
        "    globalThis.__done = 1;\n"
        "  } else {\n"
        "    globalThis.__err = r.error.name + ': ' + r.error.message;\n"
        "    globalThis.__done = -1;\n"
        "  }\n"
        "});\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool settled = pump_until(rt, 100, [&] { return read_global_int(ctx, "__done") != 0; });
    CHECK(settled);

    int done = read_global_int(ctx, "__done");
    if (done != 1) {
        std::string e = read_global_string(ctx, "__err");
        FAIL("bind failed: " << e);
    }

    int port = read_global_int(ctx, "__port");
    CHECK(port > 0);
    CHECK(port < 65536);
    CHECK_EQ(read_global_string(ctx, "__family"), "ipv4");

    MIK_FreeRuntime(rt);
}

TEST_CASE("send and receive roundtrip on loopback" * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__received = '';\n"
        "globalThis.__from = null;\n"
        "globalThis.__phase = 'init';\n"
        "(async () => {\n"
        "  const r1 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r1.ok) { globalThis.__phase = 'bind1-fail:' + r1.error.name; return; }\n"
        "  globalThis.__sock1 = r1.value;\n"  /* hold reference to prevent GC */
        "  globalThis.__sock1.onMessage = (msg, from) => {\n"
        "    globalThis.__received = new TextDecoder().decode(msg);\n"
        "    globalThis.__from = from.address + ':' + from.port;\n"
        "    globalThis.__phase = 'received';\n"
        "  };\n"
        "  const r2 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r2.ok) { globalThis.__phase = 'bind2-fail:' + r2.error.name; return; }\n"
        "  globalThis.__sock2 = r2.value;\n"
        "  const sr = await globalThis.__sock2.send('hello',\n"
        "    {address: '127.0.0.1', port: globalThis.__sock1.port, family: 'ipv4'});\n"
        "  if (!sr.ok) { globalThis.__phase = 'send-fail:' + sr.error.name; return; }\n"
        "  globalThis.__phase = 'sent';\n"
        "})();\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool got = pump_until(rt, 500, [&] {
        return read_global_string(ctx, "__phase") == "received";
    });
    if (!got) {
        FAIL("did not receive within timeout. phase=" << read_global_string(ctx, "__phase"));
    }
    CHECK_EQ(read_global_string(ctx, "__received"), "hello");

    MIK_FreeRuntime(rt);
}

TEST_CASE("close is idempotent and subsequent send returns Closed" * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__done = 0;\n"
        "(async () => {\n"
        "  const r = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r.ok) { globalThis.__phase = 'bind-fail'; return; }\n"
        "  const sock = r.value;\n"
        "  sock.close();\n"
        "  sock.close();\n"  /* idempotent */
        "  const sr = await sock.send('hi', {address: '127.0.0.1', port: 1234, family: 'ipv4'});\n"
        "  globalThis.__sendName = sr.ok ? 'OK' : sr.error.name;\n"
        "  globalThis.__done = 1;\n"
        "})();\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool settled = pump_until(rt, 100, [&] { return read_global_int(ctx, "__done") == 1; });
    CHECK(settled);
    CHECK_EQ(read_global_string(ctx, "__sendName"), "Closed");

    MIK_FreeRuntime(rt);
}

TEST_CASE("dropped counter increments when no onMessage handler is set"
          * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Bind sock1 without onMessage; blast packets at it from sock2; the
     * loop consumer should drop them and increment sock1.dropped. */
    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__phase = 'init';\n"
        "(async () => {\n"
        "  const r1 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r1.ok) { globalThis.__phase = 'bind1-fail'; return; }\n"
        "  globalThis.__sock1 = r1.value;\n"
        "  const r2 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r2.ok) { globalThis.__phase = 'bind2-fail'; return; }\n"
        "  globalThis.__sock2 = r2.value;\n"
        "  const peer = {address:'127.0.0.1',port:globalThis.__sock1.port,family:'ipv4'};\n"
        "  for (let i = 0; i < 8; i++) {\n"
        "    await globalThis.__sock2.send('x', peer);\n"
        "  }\n"
        "  globalThis.__phase = 'sent';\n"
        "})();\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool sent = pump_until(rt, 200, [&] {
        return read_global_string(ctx, "__phase") == "sent";
    });
    CHECK(sent);

    /* Pump more ticks so the loop consumer has a chance to drain + drop. */
    bool dropped = pump_until(rt, 200, [&] {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue sock = JS_GetPropertyStr(ctx, g, "__sock1");
        JSValue dv = JS_GetPropertyStr(ctx, sock, "dropped");
        int32_t n = 0;
        JS_ToInt32(ctx, &n, dv);
        JS_FreeValue(ctx, dv);
        JS_FreeValue(ctx, sock);
        JS_FreeValue(ctx, g);
        return n > 0;
    });
    CHECK(dropped);

    MIK_FreeRuntime(rt);
}

TEST_CASE("ipv4 socket rejects an IPv6 peer on send" * doctest::test_suite("udp")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__done = 0;\n"
        "(async () => {\n"
        "  const r = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r.ok) { globalThis.__phase = 'bind-fail'; return; }\n"
        "  const sr = await r.value.send('hi',\n"
        "    {address: '::1', port: 1234, family: 'ipv6'});\n"
        "  globalThis.__sendName = sr.ok ? 'OK' : sr.error.name;\n"
        "  r.value.close();\n"
        "  globalThis.__done = 1;\n"
        "})();\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool settled = pump_until(rt, 100, [&] { return read_global_int(ctx, "__done") == 1; });
    CHECK(settled);
    CHECK_EQ(read_global_string(ctx, "__sendName"), "SendFailed");

    MIK_FreeRuntime(rt);
}

TEST_CASE("onMessage that finalizes a sibling socket does not corrupt iteration"
          * doctest::test_suite("udp")) {
    /* Regression: a callback dropping the last reference to another socket
     * synchronously triggers its finalizer. Pre-fix, the consume loop's
     * snapshotted size + immediate erase combination produced an OOB read
     * (or skipped a live socket). Fix is the iteration_depth + dead-mark
     * pattern; this test exercises that path. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
        "import {bind} from 'mikrojs/udp';\n"
        "globalThis.__phase = 'init';\n"
        "(async () => {\n"
        "  const r1 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r1.ok) { globalThis.__phase = 'bind1-fail'; return; }\n"
        "  globalThis.__sock1 = r1.value;\n"
        "  let extra = (await bind({port: 0, family: 'ipv4'})).value;\n"
        "  globalThis.__sock1.onMessage = () => {\n"
        "    extra = null;\n"  /* drops last ref → sync finalizer */
        "    globalThis.__phase = 'received';\n"
        "  };\n"
        "  const r2 = await bind({port: 0, family: 'ipv4'});\n"
        "  if (!r2.ok) { globalThis.__phase = 'bind2-fail'; return; }\n"
        "  globalThis.__sock2 = r2.value;\n"
        "  await globalThis.__sock2.send('hi',\n"
        "    {address:'127.0.0.1',port:globalThis.__sock1.port,family:'ipv4'});\n"
        "})();\n");

    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool got = pump_until(rt, 500, [&] {
        return read_global_string(ctx, "__phase") == "received";
    });
    CHECK(got);

    /* Pump a few more ticks; this would crash pre-fix on a use-after-free. */
    for (int i = 0; i < 20; i++) MIK_Loop(rt);

    MIK_FreeRuntime(rt);
}

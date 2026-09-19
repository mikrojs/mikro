/* MIK_FreeRuntime must finalize every native object an app holds, even when
 * the app is parked in an await. Ports that restart the app in process (RP2)
 * release GPIO claims and hardware in those finalizers. */
#include <quickjs.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <string>
#include <vector>

#include "doctest.h"

namespace {

int g_finalized = 0;
JSClassID g_tracked_class_id = 0;

void tracked_finalizer(JSRuntime*, JSValueConst) {
    g_finalized++;
}

JSClassDef g_tracked_class = {
    .class_name = "Tracked",
    .finalizer = tracked_finalizer,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

JSValue tracked_new(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewObjectClass(ctx, static_cast<int>(g_tracked_class_id));
}

/* Ends MIK_Loop with the app still pending, the way a host restart does. */
JSValue tracked_stop(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    MIK_Stop(MIK_GetRuntime(ctx));
    return JS_UNDEFINED;
}

int tracked_mod_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "track", JS_NewCFunction(ctx, tracked_new, "track", 0));
    return JS_SetModuleExport(ctx, m, "stop", JS_NewCFunction(ctx, tracked_stop, "stop", 0));
}

JSModuleDef* tracked_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    MIK_NewClassID(rt, &g_tracked_class_id);
    if (!JS_IsRegisteredClass(rt, g_tracked_class_id)) {
        JS_NewClass(rt, g_tracked_class_id, &g_tracked_class);
    }
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/test-tracked", tracked_mod_init);
    if (m) {
        JS_AddModuleExport(ctx, m, "track");
        JS_AddModuleExport(ctx, m, "stop");
    }
    return m;
}

}  // namespace

MIK_REGISTER_MODULE(test_tracked, "native:mikro/test-tracked", tracked_init, nullptr, nullptr)

namespace {

void run_and_free(const char* src, bool loop = false) {
    g_finalized = 0;
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);
    std::string code = src;
    /* A mikro/ name may import native: modules; app code may not. */
    JSValue rv =
        JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-teardown", JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    if (loop) MIK_Loop(rt);
    MIK_FreeRuntime(rt);
}

}  // namespace

TEST_CASE("MIK_FreeRuntime finalizes an object a finished app holds" *
          doctest::test_suite("teardown")) {
    run_and_free(
        "import {track} from 'native:mikro/test-tracked'\n"
        "globalThis.kept = track()\n");
    CHECK(g_finalized == 1);
}

TEST_CASE("MIK_FreeRuntime finalizes an object an app holds across a pending await" *
          doctest::test_suite("teardown")) {
    run_and_free(
        "import {track} from 'native:mikro/test-tracked'\n"
        "const kept = track()\n"
        "while (true) {\n"
        "  await new Promise((resolve) => setTimeout(resolve, 1000))\n"
        "  kept.toString()\n"
        "}\n");
    CHECK(g_finalized == 1);
}

TEST_CASE("MIK_FreeRuntime finalizes an object an app holds after the loop has run" *
          doctest::test_suite("teardown")) {
    run_and_free(
        "import {stop, track} from 'native:mikro/test-tracked'\n"
        "const kept = track()\n"
        "let n = 0\n"
        "while (true) {\n"
        "  await new Promise((resolve) => setTimeout(resolve, 5))\n"
        "  kept.toString()\n"
        "  if (++n === 3) stop()\n"
        "}\n",
        true);
    CHECK(g_finalized == 1);
}

namespace {

int idle_read(uint8_t*, size_t, void*) {
    errno = EAGAIN;
    return -1;
}

void discard_write(const void*, size_t, void*) {}

}  // namespace

TEST_CASE("MIK_FreeRuntime finalizes app objects while a protocol session is open" *
          doctest::test_suite("teardown")) {
    /* The order a port uses between app runs: the session stays open while the
     * runtime is freed, and closes after. */
    MIKReplTransport transport = {};
    transport.read = idle_read;
    transport.write = discard_write;
    MIK_ProtocolOpen(&transport);
    g_finalized = 0;
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    MIK_ProtocolAttach(rt);
    JSContext* ctx = MIK_GetJSContext(rt);
    std::string code =
        "import {track} from 'native:mikro/test-tracked'\n"
        "const kept = track()\n"
        "while (true) {\n"
        "  await new Promise((resolve) => setTimeout(resolve, 1000))\n"
        "  kept.toString()\n"
        "}\n";
    JSValue rv =
        JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-teardown", JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    MIK_ProtocolDetach();
    MIK_FreeRuntime(rt);
    MIK_ProtocolClose();
    CHECK(g_finalized == 1);
}

TEST_CASE("MIK_FreeRuntime finalizes app objects of a bytecode entry run by MIK_RunEntry" *
          doctest::test_suite("teardown")) {
    /* The device path: the CLI ships the app as bytecode (app.bjs) and the
     * port starts it with MIK_RunEntry. */
    const char* tmp = getenv("TMPDIR");
    std::string root = std::string(tmp && *tmp ? tmp : "/tmp") + "/mik_teardown_XXXXXX";
    REQUIRE(mkdtemp(root.data()) != nullptr);

    MIKRuntime* compiler = MIK_NewRuntime();
    JSContext* cctx = MIK_GetJSContext(compiler);
    std::string code =
        "import {track} from 'native:mikro/test-tracked'\n"
        "const kept = track()\n"
        "while (true) {\n"
        "  await new Promise((resolve) => setTimeout(resolve, 1000))\n"
        "  kept.toString()\n"
        "}\n";
    JSValue fn = JS_Eval(cctx, code.c_str(), code.size(), "mikro/test-teardown",
                         JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    REQUIRE(!JS_IsException(fn));
    size_t size = 0;
    uint8_t* bytes = JS_WriteObject(cctx, &size, fn, JS_WRITE_OBJ_BYTECODE);
    REQUIRE(bytes != nullptr);
    std::string path = root + "/app.bjs";
    FILE* f = fopen(path.c_str(), "wb");
    REQUIRE(f != nullptr);
    fwrite(bytes, 1, size, f);
    fclose(f);
    js_free(cctx, bytes);
    JS_FreeValue(cctx, fn);
    MIK_FreeRuntime(compiler);

    g_finalized = 0;
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    MIK_SetFSBasePath(rt, root.c_str());
    CHECK(MIK_RunEntry(rt, "/app.js") == 0);
    MIK_FreeRuntime(rt);
    CHECK(g_finalized == 1);

    unlink(path.c_str());
    rmdir(root.c_str());
}

namespace {

/* A host that stays quiet for `quiet_us` (the app's loop runs meanwhile), then
 * sends `frames`, then goes quiet again. */
struct ScriptedHost {
    int64_t t0 = 0;
    int64_t quiet_us = 0;
    std::vector<uint8_t> frames;
    size_t pos = 0;
};

int scripted_read(uint8_t* buf, size_t size, void* ctx) {
    auto* host = static_cast<ScriptedHost*>(ctx);
    if (MIK_GetPlatform()->get_boot_us() - host->t0 < host->quiet_us ||
        host->pos >= host->frames.size()) {
        errno = EAGAIN;
        return -1;
    }
    size_t n = host->frames.size() - host->pos < size ? host->frames.size() - host->pos : size;
    memcpy(buf, host->frames.data() + host->pos, n);
    host->pos += n;
    return static_cast<int>(n);
}

void add_frame(std::vector<uint8_t>& out, uint8_t type) {
    out.insert(out.end(), {type, 0, 0, 0, 0});
}

/* What a port does with the host's pause and restart commands. */
bool port_commands(MIKReplTransport* transport, uint8_t cmd, uint32_t len, void*) {
    mik__proto_drain(transport, len);
    if (cmd == MIK_CMD_RESTART) {
        MIK_ProtocolExit();
        return true;
    }
    if (cmd == MIK_CMD_RUNTIME_PAUSE) {
        mik__repl_set_paused(true);
        mik__proto_send_ok(transport);
        return true;
    }
    return false;
}

void run_session_like_a_port(const std::vector<uint8_t>& frames) {
    ScriptedHost host;
    host.t0 = MIK_GetPlatform()->get_boot_us();
    host.quiet_us = 50 * 1000;
    host.frames = frames;
    MIKReplTransport transport = {};
    transport.read = scripted_read;
    transport.write = discard_write;
    transport.ctx = &host;
    transport.command_handler = port_commands;
    MIK_ProtocolOpen(&transport);
    g_finalized = 0;
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    MIK_ProtocolAttach(rt);
    JSContext* ctx = MIK_GetJSContext(rt);
    std::string code =
        "import {track} from 'native:mikro/test-tracked'\n"
        "const kept = track()\n"
        "while (true) {\n"
        "  await new Promise((resolve) => setTimeout(resolve, 5))\n"
        "  kept.toString()\n"
        "}\n";
    JSValue rv =
        JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-teardown", JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_FreeRuntime(rt);
    MIK_ProtocolClose();
}

}  // namespace

TEST_CASE("A host restart finalizes what the app holds" * doctest::test_suite("teardown")) {
    std::vector<uint8_t> frames;
    add_frame(frames, MIK_CMD_RESTART);
    run_session_like_a_port(frames);
    CHECK(g_finalized == 1);
}

TEST_CASE("A host restart of a paused app finalizes what the app holds" *
          doctest::test_suite("teardown")) {
    std::vector<uint8_t> frames;
    add_frame(frames, MIK_CMD_RUNTIME_PAUSE);
    add_frame(frames, MIK_CMD_RESTART);
    run_session_like_a_port(frames);
    CHECK(g_finalized == 1);
}

namespace {

/* A second class, so two modules can take class IDs in different orders. */
int g_other_finalized = 0;
JSClassID g_other_class_id = 0;

void other_finalizer(JSRuntime*, JSValueConst) {
    g_other_finalized++;
}

JSClassDef g_other_class = {
    .class_name = "Other",
    .finalizer = other_finalizer,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

JSValue other_new(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewObjectClass(ctx, static_cast<int>(g_other_class_id));
}

int other_mod_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExport(ctx, m, "other", JS_NewCFunction(ctx, other_new, "other", 0));
}

JSModuleDef* other_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    MIK_NewClassID(rt, &g_other_class_id);
    if (!JS_IsRegisteredClass(rt, g_other_class_id)) {
        JS_NewClass(rt, g_other_class_id, &g_other_class);
    }
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/test-other", other_mod_init);
    if (m) JS_AddModuleExport(ctx, m, "other");
    return m;
}

}  // namespace

MIK_REGISTER_MODULE(test_other, "native:mikro/test-other", other_init, nullptr, nullptr)

TEST_CASE("Class IDs stay distinct when a later runtime imports modules in another order" *
          doctest::test_suite("teardown")) {
    /* The second runtime imports Other first. A per-runtime allocator hands it
     * the first free number there, which a class from the first runtime already
     * holds, so Other's objects would run that class's finalizer. */
    run_and_free("import {track} from 'native:mikro/test-tracked'\nglobalThis.a = track()\n");
    g_other_finalized = 0;
    run_and_free(
        "import {other} from 'native:mikro/test-other'\n"
        "import {track} from 'native:mikro/test-tracked'\n"
        "globalThis.b = other()\n"
        "globalThis.c = track()\n");
    CHECK(g_finalized == 1);
    CHECK(g_other_finalized == 1);
}

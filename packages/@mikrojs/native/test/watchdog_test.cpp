/* Host tests for the portable watchdog layers: blocking deadline (QuickJS
 * interrupt handler), feed deadline and awake budget (checked in MIK_Loop).
 * A fake boot clock drives every deadline, so no test waits in real time. */
#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

namespace {

int64_t g_now_us = 1000;
/* Added on every clock read; a stepping clock makes a JS loop "take time". */
int64_t g_step_us = 0;
std::string g_log;
int g_restarts = 0;
int g_sleeps = 0;
int g_feeds = 0;
int g_handler_calls = 0;

int64_t fake_boot_us(void) {
    g_now_us += g_step_us;
    return g_now_us;
}

void fake_log(int level, const char* tag, const char* fmt, ...) {
    (void)level;
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    g_log += tag;
    g_log += ": ";
    g_log += buf;
    g_log += '\n';
}

/* Watchdog/panic lines go to stderr (always visible on device), not
 * platform->log; capture them in the same buffer the tests search. */
int fake_stderr_write(const void* buf, size_t len) {
    g_log.append(static_cast<const char*>(buf), len);
    return (int)len;
}

void fake_restart(void) {
    g_restarts++;
}
void fake_deep_sleep(uint64_t us) {
    (void)us;
    g_sleeps++;
}
void fake_feed_watchdog(void) {
    g_feeds++;
}
void fake_yield(void) {}

int dummy_read(uint8_t*, size_t, void*) {
    errno = 0;
    return -1;
}
/* Protocol-mode error lines arrive as frames; the text is contiguous in
 * the payload, so the same substring searches work on g_log. */
void dummy_write(const void* buf, size_t len, void*) {
    g_log.append(static_cast<const char*>(buf), len);
}

void counting_error_handler(JSContext*, JSValue, void*) {
    g_handler_calls++;
}

/* Restores the global platform even when a doctest assertion unwinds. */
struct PlatformGuard {
    const MIKPlatform* saved;
    explicit PlatformGuard(const MIKPlatform* fake) : saved(MIK_GetPlatform()) {
        MIK_SetPlatform(fake);
    }
    ~PlatformGuard() { MIK_SetPlatform(saved); }
};

MIKPlatform make_fake() {
    MIKPlatform fake = *MIK_GetPlatform();
    fake.get_boot_us = fake_boot_us;
    fake.log = fake_log;
    fake.stderr_write = fake_stderr_write;
    fake.restart = fake_restart;
    fake.deep_sleep_us = fake_deep_sleep;
    fake.yield = fake_yield;
    g_now_us = 1000;
    g_step_us = 0;
    g_log.clear();
    g_restarts = 0;
    g_sleeps = 0;
    g_feeds = 0;
    g_handler_calls = 0;
    return fake;
}

void advance_ms(int64_t ms) {
    g_now_us += ms * 1000;
}

void set_config(MIKRuntime* rt, int blocking_ms, int feed_ms, int awake_ms,
                MIKPanicMode mode = MIK_PANIC_RESTART) {
    MIKConfig config;
    MIK_DefaultConfig(&config);
    config.blocking_timeout_ms = blocking_ms;
    config.feed_timeout_ms = feed_ms;
    config.awake_timeout_ms = awake_ms;
    config.panic_mode = mode;
    config.panic_sleep_duration_ms = 5000;
    MIK_SetConfig(rt, &config);
}

/* Attaches a protocol REPL so MIK_Stop starts the panic grace window, as on
 * the device. Pair with repl_close(). */
MIKReplTransport g_transport;
void repl_open(MIKRuntime* rt) {
    g_transport = {};
    g_transport.read = dummy_read;
    g_transport.write = dummy_write;
    MIK_ProtocolOpen(&g_transport);
    MIK_ProtocolAttach(rt);
}
void repl_close() {
    MIK_ProtocolDetach();
    MIK_ProtocolClose();
}

/* Runs a script through the eval entry point (which starts a blocking
 * budget). Leaves any exception pending on ctx, as the entry path does. */
bool eval_throws(JSContext* ctx, const char* src) {
    JSValue rv = MIK_EvalScriptContent(ctx, src, strlen(src));
    if (JS_IsException(rv)) return true;
    JS_FreeValue(ctx, rv);
    return false;
}

std::string take_exception(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    const char* s = JS_ToCString(ctx, exc);
    std::string out = s ? s : "[exception]";
    if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, exc);
    return out;
}

bool global_is_undefined(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    bool undef = JS_IsUndefined(v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, g);
    return undef;
}

/* Native stand-ins for lightSleep: both jump the clock 60 s from inside a
 * JS turn; only one re-stamps the watchdog clocks on return. */
JSValue fake_light_sleep(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    advance_ms(60 * 1000);
    mik__watchdog_wake(MIK_GetRuntime(ctx));
    return JS_UNDEFINED;
}
JSValue fake_slow_native(JSContext*, JSValueConst, int, JSValueConst*) {
    advance_ms(60 * 1000);
    return JS_UNDEFINED;
}

void install_global_fn(JSContext* ctx, const char* name, JSCFunction* fn) {
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, name, JS_NewCFunction(ctx, fn, name, 0));
    JS_FreeValue(ctx, g);
}

/* Imports the mikro/watchdog builtin and exposes feed() on globalThis. */
void install_feed(MIKRuntime* rt, JSContext* ctx) {
    const char* src =
        "import {watchdog} from 'mikro/watchdog'\n"
        "globalThis.feed = () => watchdog.feed()\n";
    JSValue rv = JS_Eval(ctx, src, strlen(src), "/test/feed.js", JS_EVAL_TYPE_MODULE);
    REQUIRE_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    MIK_Loop(rt);
    REQUIRE_FALSE(global_is_undefined(ctx, "feed"));
}

std::string make_temp_dir() {
    char tmpl[] = "/tmp/mik_watchdog_test_XXXXXX";
    return std::string(mkdtemp(tmpl));
}

void write_file(const std::string& path, const char* content) {
    FILE* f = fopen(path.c_str(), "w");
    fputs(content, f);
    fclose(f);
}

/* Loads a mikro.config.json with the given body next to a package.json. */
MIKConfig load_config(const char* json) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json", R"({"main": "./main.js"})");
    write_file(dir + "/mikro.config.json", json);
    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);
    remove((dir + "/package.json").c_str());
    remove((dir + "/mikro.config.json").c_str());
    rmdir(dir.c_str());
    return config;
}

}  // namespace

/* ── Blocking deadline ──────────────────────────────────────────────── */

TEST_CASE("Blocking: an endless loop is interrupted and the runtime stops" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    REQUIRE(eval_throws(ctx, "while (true) {}"));
    CHECK(rt->blocking_tripped);
    /* The pending exception takes the ordinary uncaught path in MIK_Loop. */
    CHECK(MIK_Loop(rt) == 1);
    CHECK(MIK_IsStopRequested(rt));
    CHECK(g_log.find("event loop blocking time exceeded configured limit of 1000 ms") !=
          std::string::npos);
    CHECK_FALSE(rt->blocking_tripped);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: try/catch cannot swallow the interrupt" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    REQUIRE(eval_throws(ctx, "try { while (true) {} } catch (e) { globalThis.caught = e }"));
    CHECK(take_exception(ctx).find("interrupted") != std::string::npos);
    CHECK(global_is_undefined(ctx, "caught"));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: the interrupt crosses an await and its caller's try/catch" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    REQUIRE_FALSE(eval_throws(ctx,
                              "async function f() { await 0; while (true) {} }\n"
                              "async function main() {\n"
                              "  try { await f() } catch (e) { globalThis.caught = String(e) }\n"
                              "}\n"
                              "main()"));
    /* The loop runs inside a promise job; the timeout stops the runtime. */
    CHECK(MIK_Loop(rt) == 1);
    CHECK(global_is_undefined(ctx, "caught"));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: an endless microtask chain is caught (budget is per pass, not per job)" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    REQUIRE_FALSE(eval_throws(ctx, "async function spin() { while (true) await 0 }\nspin()"));
    CHECK(MIK_Loop(rt) == 1);
    CHECK(g_log.find("event loop blocking time exceeded configured limit") != std::string::npos);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: a long loop under budget is not interrupted" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    /* Frozen clock: many polls, no elapsed time. */
    CHECK_FALSE(eval_throws(ctx, "for (let i = 0; i < 200000; i++) {}"));
    /* Disabled: the clock races ahead but nothing measures it. */
    set_config(rt, 0, 0, 0);
    g_step_us = 100 * 1000;
    CHECK_FALSE(eval_throws(ctx, "for (let i = 0; i < 200000; i++) {}"));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: catastrophic regex backtracking is caught" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    REQUIRE(eval_throws(ctx, "/(a+)+$/.test('a'.repeat(26) + 'b')"));
    CHECK(take_exception(ctx).find("interrupted") != std::string::npos);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: back-to-back short turns each get a fresh budget" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    /* Each turn polls once or twice (~200 ms of fake time); 30 of them add
     * up to 6 s, which would fire if the stamp carried across turns. */
    for (int i = 0; i < 30; i++) {
        REQUIRE_FALSE(eval_throws(ctx, "for (let i = 0; i < 20000; i++) {}"));
    }

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: a deliberately blocking native re-stamps the budget on return" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    install_global_fn(ctx, "lightSleep", fake_light_sleep);
    install_global_fn(ctx, "slowNative", fake_slow_native);

    /* The first loop stamps the budget; the sleep jumps 60 s; the second
     * loop polls again. lightSleep re-stamped, so the jump is not counted. */
    CHECK_FALSE(eval_throws(ctx,
                            "for (let i = 0; i < 15000; i++) {}\n"
                            "lightSleep()\n"
                            "for (let i = 0; i < 15000; i++) {}"));
    /* Any other native holding the turn that long is caught. */
    REQUIRE(eval_throws(ctx,
                        "for (let i = 0; i < 15000; i++) {}\n"
                        "slowNative()\n"
                        "for (let i = 0; i < 15000; i++) {}"));
    CHECK(take_exception(ctx).find("interrupted") != std::string::npos);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: a clock running backwards re-stamps instead of firing" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_now_us = 1000LL * 1000 * 1000;
    g_step_us = -100 * 1000;

    CHECK_FALSE(eval_throws(ctx, "for (let i = 0; i < 200000; i++) {}"));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Blocking: in test mode a timeout stops the runtime without scheduling a restart" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    MIK_EnableTestHelpers(rt);
    repl_open(rt);
    g_step_us = 100 * 1000;

    REQUIRE(eval_throws(ctx, "while (true) {}"));
    CHECK(MIK_Loop(rt) == 1);
    CHECK(MIK_IsStopRequested(rt));
    CHECK(rt->restart_at_us == 0);

    repl_close();
    MIK_FreeRuntime(rt);
}

/* ── Feed deadline ──────────────────────────────────────────────────── */

TEST_CASE("Feed: a missed deadline panics through the uncaught-error path" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    set_config(rt, 0, 1000, 0);
    MIK_SetErrorHandler(rt, counting_error_handler, nullptr);
    repl_open(rt);

    advance_ms(900);
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(200);
    CHECK(MIK_Loop(rt) == 1);
    /* Routed like any uncaught error: handler, panic grace window. */
    CHECK(g_handler_calls == 1);
    CHECK(rt->restart_at_us > 0);
    CHECK_FALSE(rt->feed_armed);

    repl_close();
    MIK_FreeRuntime(rt);
}

TEST_CASE("Feed: feeding in time keeps the runtime alive" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 1000, 0);
    install_feed(rt, ctx);

    for (int i = 0; i < 5; i++) {
        advance_ms(600);
        REQUIRE_FALSE(eval_throws(ctx, "feed()"));
        CHECK(MIK_Loop(rt) == 0);
    }
    /* Stop feeding: the deadline still applies. */
    advance_ms(1500);
    CHECK(MIK_Loop(rt) == 1);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Feed: fires exactly once" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 1000, 0);

    advance_ms(1500);
    mik__watchdog_check(rt);
    REQUIRE(JS_HasException(ctx));
    CHECK(take_exception(ctx).find("time since last feed() exceeded configured limit of 1000 ms") !=
          std::string::npos);
    CHECK(g_log.find("WATCHDOG TRIGGERED: time since last feed() exceeded configured limit of "
                     "1000 ms") != std::string::npos);
    advance_ms(5000);
    mik__watchdog_check(rt);
    CHECK_FALSE(JS_HasException(ctx));

    MIK_FreeRuntime(rt);
}

TEST_CASE("Feed: feed() without a configured deadline is a no-op" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    install_feed(rt, ctx);

    int64_t before = rt->feed_last_us;
    advance_ms(5000);
    CHECK_FALSE(eval_throws(ctx, "feed()"));
    CHECK(rt->feed_last_us == before);
    CHECK(MIK_Loop(rt) == 0);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Feed: a pause spanning the deadline does not fire on resume" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    set_config(rt, 0, 1000, 0);
    repl_open(rt);

    advance_ms(500);
    mik__repl_set_paused(true);
    advance_ms(5000);
    mik__repl_set_paused(false);
    CHECK(MIK_Loop(rt) == 0);
    /* A fresh budget, not a suspended one. */
    advance_ms(900);
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(200);
    CHECK(MIK_Loop(rt) == 1);

    repl_close();
    MIK_FreeRuntime(rt);
}

/* Light sleep is not a hang: an app that sleeps past its feed limit gets a
 * fresh window on wake, the same as after a pause. */
TEST_CASE("Feed: light sleep past the deadline does not fire on wake" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 1000, 0);
    install_global_fn(ctx, "lightSleep", fake_light_sleep);

    advance_ms(500);
    REQUIRE_FALSE(eval_throws(ctx, "lightSleep()"));
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(900);
    CHECK(MIK_Loop(rt) == 0);
    /* Still on: a real miss after the wake fires. */
    advance_ms(200);
    CHECK(MIK_Loop(rt) == 1);
    CHECK(g_log.find("time since last feed()") != std::string::npos);

    MIK_FreeRuntime(rt);
}

/* Unlike a pause, light sleep is uptime: the awake clock is not credited. */
TEST_CASE("Awake: light sleep counts against the limit" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 0, 30 * 1000, MIK_PANIC_DEEP_SLEEP);
    install_global_fn(ctx, "lightSleep", fake_light_sleep);

    REQUIRE_FALSE(eval_throws(ctx, "lightSleep()"));
    CHECK(MIK_Loop(rt) == 1);
    CHECK(g_log.find("awake time exceeded configured limit of 30000 ms") != std::string::npos);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Feed and awake: a runtime recycle switches both off" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    set_config(rt, 1000, 1000, 1000, MIK_PANIC_DEEP_SLEEP);
    CHECK(rt->feed_armed);
    CHECK(rt->awake_armed);
    MIK_FreeRuntime(rt);

    rt = MIK_NewRuntime();
    CHECK_FALSE(rt->feed_armed);
    CHECK_FALSE(rt->awake_armed);
    CHECK(rt->awake_pause_offset_us == 0);
    CHECK(rt->config.blocking_timeout_ms == MIK_WATCHDOG_BLOCKING_DEFAULT_MS);
    MIK_FreeRuntime(rt);
}

/* ── Awake budget ───────────────────────────────────────────────────── */

TEST_CASE("Awake: an over-long cycle stops via onPanic with no JS error" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 0, 1000, MIK_PANIC_DEEP_SLEEP);
    MIK_SetErrorHandler(rt, counting_error_handler, nullptr);
    repl_open(rt);

    advance_ms(900);
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(200);
    CHECK(MIK_Loop(rt) == 1);
    CHECK(rt->restart_at_us > 0);
    CHECK_FALSE(rt->awake_armed);
    /* No exception: the OTA trial handler must not see this as a crash. */
    CHECK(g_handler_calls == 0);
    CHECK_FALSE(JS_HasException(ctx));
    CHECK(g_log.find("awake time exceeded configured limit of 1000 ms") != std::string::npos);
    /* The grace window ends in the configured deep sleep. */
    advance_ms(2000);
    MIK_Loop(rt);
    CHECK(g_sleeps == 1);

    repl_close();
    MIK_FreeRuntime(rt);
}

TEST_CASE("Awake: feed() does not extend the budget" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 0, 1000, 1000, MIK_PANIC_DEEP_SLEEP);
    install_feed(rt, ctx);

    for (int i = 0; i < 3; i++) {
        advance_ms(300);
        REQUIRE_FALSE(eval_throws(ctx, "feed()"));
        CHECK(MIK_Loop(rt) == 0);
    }
    advance_ms(300);
    REQUIRE_FALSE(eval_throws(ctx, "feed()"));
    CHECK(MIK_Loop(rt) == 1);
    CHECK(rt->feed_armed); /* the feed deadline was never the problem */
    CHECK_FALSE(rt->awake_armed);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Awake: unset never fires" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();

    advance_ms(24LL * 3600 * 1000);
    CHECK(MIK_Loop(rt) == 0);

    MIK_FreeRuntime(rt);
}

TEST_CASE("Awake: a deploy pause is credited, not counted" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    set_config(rt, 0, 0, 1000, MIK_PANIC_DEEP_SLEEP);
    repl_open(rt);

    advance_ms(200);
    mik__repl_set_paused(true);
    advance_ms(5000);
    mik__repl_set_paused(false);
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(700); /* 900 ms of un-paused time */
    CHECK(MIK_Loop(rt) == 0);
    advance_ms(200); /* 1100 ms */
    CHECK(MIK_Loop(rt) == 1);

    repl_close();
    MIK_FreeRuntime(rt);
}

TEST_CASE("Awake: warns once when paired with a restart panic mode" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();

    set_config(rt, 0, 0, 60000, MIK_PANIC_DEEP_SLEEP);
    CHECK(g_log.find("watchdog.awake") == std::string::npos);
    set_config(rt, 0, 0, 60000, MIK_PANIC_RESTART);
    CHECK(g_log.find("awake limit of 60000 ms without onPanic.mode 'deepSleep'") !=
          std::string::npos);

    MIK_FreeRuntime(rt);
}

/* ── Ordering / platform ────────────────────────────────────────────── */

TEST_CASE("Platform: POSIX has no hardware watchdog and MIK_Loop copes" *
          doctest::test_suite("watchdog")) {
    CHECK(MIK_GetPlatform()->feed_watchdog == nullptr);
    MIKRuntime* rt = MIK_NewRuntime();
    CHECK(MIK_Loop(rt) == 0);
    MIK_FreeRuntime(rt);
}

TEST_CASE("Platform: the hardware watchdog is fed on every pass, grace window included" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    fake.feed_watchdog = fake_feed_watchdog;
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    repl_open(rt);

    MIK_Loop(rt);
    CHECK(g_feeds == 1);
    MIK_Stop(rt);
    REQUIRE(rt->restart_at_us > 0);
    MIK_Loop(rt); /* inside the window: early return, still fed */
    CHECK(g_feeds == 2);

    repl_close();
    MIK_FreeRuntime(rt);
}

/* ── Config parsing ─────────────────────────────────────────────────── */

TEST_CASE("Config: watchdog keys are parsed" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);

    MIKConfig config = load_config(
        R"({"watchdog.blocking": 5000, "watchdog.feed": 2000, "watchdog.awake": 60000})");
    CHECK(config.blocking_timeout_ms == 5000);
    CHECK(config.feed_timeout_ms == 2000);
    CHECK(config.awake_timeout_ms == 60000);
    CHECK(g_log.find("clamping") == std::string::npos);

    config = load_config(R"({"onPanic.delay": 1000})");
    CHECK(config.blocking_timeout_ms == MIK_WATCHDOG_BLOCKING_DEFAULT_MS);
    CHECK(config.feed_timeout_ms == 0);
    CHECK(config.awake_timeout_ms == 0);
}

TEST_CASE("Config: blocking false or 0 disables" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);

    CHECK(load_config(R"({"watchdog.blocking": false})").blocking_timeout_ms == 0);
    CHECK(load_config(R"({"watchdog.blocking": 0})").blocking_timeout_ms == 0);
    CHECK(g_log.find("clamping") == std::string::npos);
}

TEST_CASE("Config: budgets below 1 s clamp up with a warning" * doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);

    MIKConfig config = load_config(R"({"watchdog.blocking": 5, "watchdog.feed": -1})");
    CHECK(config.blocking_timeout_ms == 1000);
    CHECK(config.feed_timeout_ms == 1000);
    CHECK(g_log.find("watchdog.blocking below 1000 ms (5); clamping to 1000") !=
          std::string::npos);
    CHECK(g_log.find("watchdog.feed below 1000 ms (-1); clamping to 1000") != std::string::npos);
}

TEST_CASE("Config: a long onPanic.delay does not clamp blocking" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);

    MIKConfig config = load_config(R"({"onPanic.delay": 60000, "watchdog.blocking": 30000})");
    CHECK(config.panic_restart_delay_ms == 60000);
    CHECK(config.blocking_timeout_ms == 30000);
    CHECK(g_log.find("clamping") == std::string::npos);
}

/* Regression for a device log: the entry spun past the blocking limit, and
 * on the next pass the feed check fired too (nothing had fed while the app
 * was spinning) and its throw replaced the pending "interrupted" error, so
 * the trace was lost and the feed line came first. */
TEST_CASE("Blocking: a timeout during the entry does not also fire feed" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 1000, 0);
    g_step_us = 100 * 1000;

    REQUIRE(eval_throws(ctx, "while (true) {}"));
    /* Well past the feed limit too: the spin took the whole window. */
    g_step_us = 0;
    advance_ms(5000);
    CHECK(MIK_Loop(rt) == 1);
    CHECK(g_log.find("event loop blocking time exceeded") != std::string::npos);
    CHECK(g_log.find("last feed()") == std::string::npos);
    CHECK(rt->feed_armed);

    MIK_FreeRuntime(rt);
}

/* Regression for a device log: the entry module evaluates as a promise, so
 * the interrupt surfaced as an unhandled rejection, which bypasses
 * mik_dump_error and skipped the WATCHDOG TRIGGERED line entirely. */
TEST_CASE("Blocking: a timeout inside a module evaluation still logs the watchdog line" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 1000, 0, 0);
    g_step_us = 100 * 1000;

    const char* src = "while (true) {}";
    JSValue rv = MIK_EvalModuleContent(ctx, "/test/spin.js", src, strlen(src));
    JS_FreeValue(ctx, rv);
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
    CHECK(rt->blocking_tripped);
    /* The rejection is reported at the end-of-turn flush in MIK_Loop. */
    g_step_us = 0;
    MIK_Loop(rt);
    CHECK(g_log.find("event loop blocking time exceeded") != std::string::npos);
    CHECK_FALSE(rt->blocking_tripped);

    MIK_FreeRuntime(rt);
}

/* Device repro: a module that awaits a timer, then light-sleeps past the
 * limit from the continuation. lightSleep re-stamps on return, so the
 * turn that follows must start a fresh budget. */
TEST_CASE("Blocking: lightSleep from a top-level-await continuation does not fire" *
          doctest::test_suite("watchdog")) {
    MIKPlatform fake = make_fake();
    PlatformGuard guard(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);
    set_config(rt, 5000, 0, 0);
    install_global_fn(ctx, "fakeLightSleep", fake_light_sleep);

    const char* src =
        "await new Promise((r) => setTimeout(r, 3000))\n"
        "fakeLightSleep()\n"
        "globalThis.after = 1\n";
    JSValue rv = MIK_EvalModuleContent(ctx, "/test/ls.js", src, strlen(src));
    JS_FreeValue(ctx, rv);
    REQUIRE_FALSE(JS_HasException(ctx));

    advance_ms(3000);
    MIK_Loop(rt);
    CHECK_FALSE(rt->blocking_tripped);
    CHECK(g_log.find("exceeded") == std::string::npos);
    CHECK_FALSE(global_is_undefined(ctx, "after"));

    MIK_FreeRuntime(rt);
}

#include <cstdio>
#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for the sys native module (mik_sys.cpp) through
 * native:mikro/sys, with a fake platform supplying device facts and
 * counting restart calls. The platform must be installed before runtime
 * creation: deviceId and resetReason are read once at module init. */

namespace {

static int g_restart_calls = 0;
static std::string g_device_name;

static bool fake_get_fs_info(const char* label, size_t* total, size_t* used) {
    if (strcmp(label, "user") != 0) return false;
    *total = 1000;
    *used = 250;
    return true;
}

static void fake_restart(void) {
    g_restart_calls++;
}

static const char* fake_get_device_id(void) {
    return "test-device-01";
}

static const char* fake_get_device_name(void) {
    return g_device_name.empty() ? nullptr : g_device_name.c_str();
}

static void fake_set_device_name(const char* name) {
    g_device_name = name ? name : "";
}

static const char* fake_get_reset_reason(void) {
    return "power-on-test";
}

static const char* fake_get_wakeup_cause(void) {
    return "timer";
}

static const char* fake_get_chip_name(void) {
    return "testchip";
}

static void fake_get_chip_info(MIKChipInfo* info) {
    static const char* const features[] = {"wifi", nullptr};
    info->cores = 2;
    info->flash = 4 * 1024 * 1024;
    info->features = features;
}

struct SysFixture {
    const MIKPlatform* orig = nullptr;
    MIKPlatform fake;
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    SysFixture() {
        g_restart_calls = 0;
        g_device_name.clear();
        orig = MIK_GetPlatform();
        fake = *orig;
        fake.get_fs_info = fake_get_fs_info;
        fake.restart = fake_restart;
        fake.get_device_id = fake_get_device_id;
        fake.get_device_name = fake_get_device_name;
        fake.set_device_name = fake_set_device_name;
        fake.get_reset_reason = fake_get_reset_reason;
        MIK_SetPlatform(&fake);
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~SysFixture() {
        MIK_FreeRuntime(rt);
        MIK_SetPlatform(orig);
    }
};

static void run(JSContext* ctx, const char* src) {
    std::string code = src;
    JSValue rv =
        JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-sys-driver", JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[sys run] rejected: %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, rv);
    REQUIRE(state == JS_PROMISE_FULFILLED);
}

static std::string read_global_string(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
}

static const char* PRELUDE = "import * as sys from 'native:mikro/sys'\n";

}  // namespace

TEST_CASE_FIXTURE(SysFixture, "device facts come from the platform" *
                                  doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__id = sys.deviceId\n"
              "globalThis.__reset = sys.resetReason\n"
              "globalThis.__version = sys.version\n"
              "globalThis.__board = sys.board.name\n"
              "globalThis.__firmware = sys.firmware.name\n"
              "globalThis.__chip = sys.board.chip\n"
              "const up = sys.uptime()\n"
              "globalThis.__bootPositive = up.boot > 0 && up.rtc > 0\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__id") == "test-device-01");
    CHECK(read_global_string(ctx, "__reset") == "power-on-test");
    CHECK(read_global_string(ctx, "__version") != "");
    CHECK(read_global_string(ctx, "__board") == "generic");
    CHECK(read_global_string(ctx, "__firmware") == "generic");
    /* No get_chip_name hook on the host platform. */
    CHECK(read_global_string(ctx, "__chip") == "host");
    CHECK(read_global_string(ctx, "__bootPositive") == "true");
}

TEST_CASE("board.chip comes from the platform's get_chip_name" * doctest::test_suite("sys")) {
    /* sys.board is built at module init, so the hook goes in before the runtime. */
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.get_chip_name = fake_get_chip_name;
    MIK_SetPlatform(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);
    run(ctx, (std::string(PRELUDE) + "globalThis.__chip = sys.board.chip\n").c_str());
    CHECK(read_global_string(ctx, "__chip") == "testchip");
    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);
}

TEST_CASE("board facts come from the platform's get_chip_info" * doctest::test_suite("sys")) {
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.get_chip_info = fake_get_chip_info;
    MIK_SetPlatform(&fake);
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);
    run(ctx, (std::string(PRELUDE) +
              "const b = sys.board\n"
              "globalThis.__facts = `${b.cores}/${b.flash}/${b.psram}/${b.features.join(',')}`\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__facts") == "2/4194304/0/wifi");
    MIK_FreeRuntime(rt);
    MIK_SetPlatform(orig);
}

TEST_CASE_FIXTURE(SysFixture, "storage and memory usage report numbers" *
                                  doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) +
              "const st = sys.storageUsage()\n"
              "globalThis.__st = `${st.total}/${st.used}/${st.free}`\n"
              "const mem = sys.memoryUsage()\n"
              "globalThis.__heapUsed = mem.heapUsed > 0\n"
              "const js = sys.jsMemoryUsage()\n"
              "globalThis.__objs = js.objCount > 0 && js.strCount > 0 && js.shapeCount > 0\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__st") == "1000/250/750");
    CHECK(read_global_string(ctx, "__heapUsed") == "true");
    CHECK(read_global_string(ctx, "__objs") == "true");
}

TEST_CASE_FIXTURE(SysFixture, "evalScript runs async and surfaces errors" *
                                  doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) +
              /* async eval fulfills with a {value} wrapper object */
              "sys.evalScript('40 + 2').then((v) => {\n"
              "  globalThis.__v = String(v && typeof v === 'object' && 'value' in v ? v.value : v)\n"
              "})\n"
              /* compile errors may throw synchronously or reject, depending
               * on where compilation fails; accept both */
              "try {\n"
              "  sys.evalScript('syntax error here').catch((e) => { globalThis.__err = e.name })\n"
              "} catch (e) { globalThis.__err = e.name }\n"
              "try { sys.evalScript(Symbol('no-string')) } catch (e) {\n"
              "  globalThis.__badArg = e instanceof TypeError\n"
              "}\n")
                 .c_str());
    MIK_Loop(rt);
    CHECK(read_global_string(ctx, "__v") == "42");
    CHECK(read_global_string(ctx, "__err") == "SyntaxError");
    CHECK(read_global_string(ctx, "__badArg") == "true");
}

TEST_CASE_FIXTURE(SysFixture, "restart calls through the platform" * doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) + "sys.restart()\n").c_str());
    CHECK(g_restart_calls == 1);
}

TEST_CASE_FIXTURE(SysFixture, "device name round-trips and clears" *
                                  doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__before = String(sys.deviceName())\n"
              "sys.setDeviceName('zephyr')\n"
              "globalThis.__after = sys.deviceName()\n"
              "sys.setDeviceName(undefined)\n"
              "globalThis.__cleared = String(sys.deviceName())\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__before") == "undefined");
    CHECK(read_global_string(ctx, "__after") == "zephyr");
    CHECK(read_global_string(ctx, "__cleared") == "undefined");
}

/* Both import the builtin mikro/sys, not native:mikro/sys: it must load on a
 * host with no native:mikro/sleep. The hook is read per call, not at init. */
static const char* WAKEUP_CAUSE = "import {getWakeupCause} from 'mikro/sys'\n"
                                  "globalThis.__cause = getWakeupCause()\n";

TEST_CASE_FIXTURE(SysFixture, "getWakeupCause is 'undefined' without the platform hook" *
                                  doctest::test_suite("sys")) {
    REQUIRE(fake.get_wakeup_cause == nullptr);
    run(ctx, WAKEUP_CAUSE);
    CHECK(read_global_string(ctx, "__cause") == "undefined");
}

TEST_CASE_FIXTURE(SysFixture, "getWakeupCause comes from the platform hook" *
                                  doctest::test_suite("sys")) {
    fake.get_wakeup_cause = fake_get_wakeup_cause;
    run(ctx, WAKEUP_CAUSE);
    CHECK(read_global_string(ctx, "__cause") == "timer");
}

TEST_CASE_FIXTURE(SysFixture, "setTime succeeds or reports errno" * doctest::test_suite("sys")) {
    /* As an unprivileged user settimeofday fails with EPERM; as root it
     * succeeds (we pass the current time, so the clock doesn't move).
     * Either way the call must produce a defined outcome, never crash. */
    run(ctx, (std::string(PRELUDE) +
              "try { sys.setTime(Date.now()); globalThis.__time = 'ok' }\n"
              "catch (e) { globalThis.__time = typeof e.errno === 'number' ? 'errno' : 'bad' }\n")
                 .c_str());
    std::string outcome = read_global_string(ctx, "__time");
    CHECK((outcome == "ok" || outcome == "errno"));
}

TEST_CASE_FIXTURE(SysFixture, "gc and activeTimers respond" * doctest::test_suite("sys")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__timersBefore = sys.activeTimers()\n"
              "const id = setTimeout(() => {}, 60000)\n"
              "globalThis.__timersAfter = sys.activeTimers()\n"
              "clearTimeout(id)\n"
              "sys.gc()\n"
              "globalThis.__done = 'yes'\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__timersBefore") == "0");
    CHECK(read_global_string(ctx, "__timersAfter") == "1");
    CHECK(read_global_string(ctx, "__done") == "yes");
}

#include <cstring>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* The M1a BLE test suite exercises the broadcaster lifecycle through the
 * `native:mikro/ble` module. Tests do not require an external central — they only
 * verify that advertise/stop/teardown return cleanly and the module exports
 * match the expected shape. Real GATT and connection behavior belongs to M2.
 */

static MIKRuntime* rt;
static JSContext* ctx;

extern void mik__ble_consume(JSContext* ctx);

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    mik__ble_consume(ctx);
}

static void teardown() {
    /* Ensure the BLE stack is stopped between tests so every test starts
     * from a clean state. stop() is idempotent. */
    JSValue ret = MIK_EvalModuleContent(
        ctx, "mikro/ble-test-teardown",
        "import {Ble} from \"native:mikro/ble\"; new Ble().stop();", 48);
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    } else {
        JS_FreeValue(ctx, ret);
    }
    mik__ble_consume(ctx);
    /* Let NimBLE tasks settle before freeing the runtime. */
    vTaskDelay(pdMS_TO_TICKS(50));
    MIK_FreeRuntime(rt);
}

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/ble-test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

/* ── Module shape ─────────────────────────────────────────────────── */

TEST_CASE("native:mikro/ble exports Ble with expected methods", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        globalThis.__isFunc = typeof Ble === "function";
        const ble = new Ble();
        globalThis.__isObj = typeof ble === "object" && ble !== null;
        globalThis.__methods = [
            "getName","setName","getAddress","getTxPower","setTxPower",
            "advertise","stopAdvertising","stop"
        ].every(m => typeof ble[m] === "function");
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue isFunc = JS_GetPropertyStr(ctx, global, "__isFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isFunc), "Ble should be a function");
    JS_FreeValue(ctx, isFunc);

    JSValue isObj = JS_GetPropertyStr(ctx, global, "__isObj");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isObj), "new Ble() should return an object");
    JS_FreeValue(ctx, isObj);

    JSValue methods = JS_GetPropertyStr(ctx, global, "__methods");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, methods), "All expected methods should exist");
    JS_FreeValue(ctx, methods);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Default name follows the mikrojs-xxxxxx pattern ───────────────── */

TEST_CASE("Ble.getName returns a mikrojs- prefixed name by default", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        globalThis.__name = ble.getName();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue nameVal = JS_GetPropertyStr(ctx, global, "__name");
    const char* name = JS_ToCString(ctx, nameVal);
    TEST_ASSERT_NOT_NULL(name);
    TEST_ASSERT_TRUE_MESSAGE(strncmp(name, "mikrojs", 7) == 0,
                             "Default name should start with 'mikrojs'");
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, nameVal);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── setName persists across getName ──────────────────────────────── */

TEST_CASE("Ble.setName updates the cached name", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const setResult = ble.setName("mikrojs-test");
        globalThis.__setOk = setResult.ok;
        globalThis.__nameAfter = ble.getName();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue setOk = JS_GetPropertyStr(ctx, global, "__setOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, setOk), "setName should succeed");
    JS_FreeValue(ctx, setOk);

    JSValue nameVal = JS_GetPropertyStr(ctx, global, "__nameAfter");
    const char* name = JS_ToCString(ctx, nameVal);
    TEST_ASSERT_EQUAL_STRING("mikrojs-test", name);
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, nameVal);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── advertise/stopAdvertising round-trip ─────────────────────────── */

TEST_CASE("Ble.advertise then stopAdvertising returns ok", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const startResult = ble.advertise({
            name: "mikrojs-test",
            connectable: false,
            interval: {min: 1000, max: 1500},
        });
        globalThis.__startOk = startResult.ok;
        globalThis.__startErrName = startResult.ok ? null : startResult.error.name;
        const stopResult = ble.stopAdvertising();
        globalThis.__stopOk = stopResult.ok;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue startOk = JS_GetPropertyStr(ctx, global, "__startOk");
    if (!JS_ToBool(ctx, startOk)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__startErrName");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "advertise returned err with no name");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, startOk);

    JSValue stopOk = JS_GetPropertyStr(ctx, global, "__stopOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, stopOk), "stopAdvertising should return ok");
    JS_FreeValue(ctx, stopOk);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Double-advertise returns AlreadyAdvertising ──────────────────── */

TEST_CASE("Ble.advertise twice returns AlreadyAdvertising", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({name: "t", connectable: false});
        const second = ble.advertise({name: "t", connectable: false});
        globalThis.__isErr = !second.ok;
        globalThis.__errName = second.ok ? null : second.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue isErr = JS_GetPropertyStr(ctx, global, "__isErr");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isErr), "Second advertise should be an error");
    JS_FreeValue(ctx, isErr);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__errName");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("AlreadyAdvertising", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── getAddress returns a MAC-shaped string after init ────────────── */

TEST_CASE("Ble.getAddress returns a colon-separated MAC", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const result = ble.getAddress();
        globalThis.__ok = result.ok;
        globalThis.__addr = result.ok ? result.value : null;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, okVal), "getAddress should return ok");
    JS_FreeValue(ctx, okVal);

    JSValue addrVal = JS_GetPropertyStr(ctx, global, "__addr");
    const char* addr = JS_ToCString(ctx, addrVal);
    TEST_ASSERT_NOT_NULL(addr);
    TEST_ASSERT_EQUAL_INT_MESSAGE(17, strlen(addr), "MAC should be 17 chars (aa:bb:cc:dd:ee:ff)");
    if (addr) JS_FreeCString(ctx, addr);
    JS_FreeValue(ctx, addrVal);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Full teardown via stop() is idempotent ───────────────────────── */

TEST_CASE("Ble.stop is idempotent", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const first = ble.stop();
        const second = ble.stop();
        globalThis.__firstOk = first.ok;
        globalThis.__secondOk = second.ok;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue firstOk = JS_GetPropertyStr(ctx, global, "__firstOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, firstOk), "First stop should be ok");
    JS_FreeValue(ctx, firstOk);

    JSValue secondOk = JS_GetPropertyStr(ctx, global, "__secondOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, secondOk), "Second stop should also be ok");
    JS_FreeValue(ctx, secondOk);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── GATT registration ─────────────────────────────────────────────── */

TEST_CASE("Ble.advertise with services registers a GATT table", "[ble]") {
    setup();

    /* Properties bitmask: read (0x01) | notify (0x08) = 0x09 */
    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const result = ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{
                    uuid: "2a19",
                    properties: 0x09,
                    value: new Uint8Array([100]),
                }],
            }],
        });
        globalThis.__ok = result.ok;
        globalThis.__errName = result.ok ? null : result.error.name;
        if (result.ok) ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    if (!JS_ToBool(ctx, okVal)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__errName");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "advertise returned err with no name");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, okVal);
    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.advertise with matching services on re-advertise succeeds", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const services = [{
            uuid: "180f",
            characteristics: [{
                uuid: "2a19",
                properties: 0x09,
                value: new Uint8Array([100]),
            }],
        }];
        const first = ble.advertise({connectable: true, services});
        ble.stopAdvertising();
        const second = ble.advertise({connectable: true, services});
        globalThis.__firstOk = first.ok;
        globalThis.__secondOk = second.ok;
        globalThis.__secondErr = second.ok ? null : second.error.name;
        if (second.ok) ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue firstOk = JS_GetPropertyStr(ctx, global, "__firstOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, firstOk), "First advertise should succeed");
    JS_FreeValue(ctx, firstOk);

    JSValue secondOk = JS_GetPropertyStr(ctx, global, "__secondOk");
    if (!JS_ToBool(ctx, secondOk)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__secondErr");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "second advertise returned err");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, secondOk);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.advertise with different services on re-advertise errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const first = ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{uuid: "2a19", properties: 0x01, value: new Uint8Array([1])}],
            }],
        });
        ble.stopAdvertising();
        const second = ble.advertise({
            connectable: true,
            services: [{
                uuid: "180a",
                characteristics: [{uuid: "2a29", properties: 0x01, value: new Uint8Array([2])}],
            }],
        });
        globalThis.__firstOk = first.ok;
        globalThis.__secondOk = second.ok;
        globalThis.__secondErr = second.ok ? null : second.error.name;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue firstOk = JS_GetPropertyStr(ctx, global, "__firstOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, firstOk), "First advertise should succeed");
    JS_FreeValue(ctx, firstOk);

    JSValue secondOk = JS_GetPropertyStr(ctx, global, "__secondOk");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, secondOk),
                              "Second advertise with different services should fail");
    JS_FreeValue(ctx, secondOk);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__secondErr");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("GattAlreadyRegistered", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.advertise with invalid UUID errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const result = ble.advertise({
            services: [{
                uuid: "not-a-uuid",
                characteristics: [{uuid: "2a19", properties: 0x01, value: new Uint8Array([1])}],
            }],
        });
        globalThis.__ok = result.ok;
        globalThis.__errName = result.ok ? null : result.error.name;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, okVal), "advertise should fail on invalid UUID");
    JS_FreeValue(ctx, okVal);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__errName");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("InvalidUuid", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.advertise with 128-bit UUIDs registers", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const result = ble.advertise({
            connectable: true,
            services: [{
                uuid: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
                characteristics: [{
                    uuid: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
                    properties: 0x02,
                    value: new Uint8Array([]),
                }],
            }],
        });
        globalThis.__ok = result.ok;
        globalThis.__errName = result.ok ? null : result.error.name;
        if (result.ok) ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    if (!JS_ToBool(ctx, okVal)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__errName");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "advertise with 128-bit UUIDs failed");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, okVal);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── setValue ─────────────────────────────────────────────────────── */

TEST_CASE("Ble.setValue on a registered characteristic succeeds", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        const advResult = ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{
                    uuid: "2a19",
                    properties: 0x01,
                    value: new Uint8Array([50]),
                }],
            }],
        });
        globalThis.__advOk = advResult.ok;
        const setResult = ble.setValue("180f", "2a19", new Uint8Array([99]));
        globalThis.__setOk = setResult.ok;
        globalThis.__setErr = setResult.ok ? null : setResult.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue advOk = JS_GetPropertyStr(ctx, global, "__advOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, advOk), "advertise should succeed");
    JS_FreeValue(ctx, advOk);

    JSValue setOk = JS_GetPropertyStr(ctx, global, "__setOk");
    if (!JS_ToBool(ctx, setOk)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__setErr");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "setValue returned err with no name");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, setOk);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.setValue on an unknown service errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{uuid: "2a19", properties: 0x01, value: new Uint8Array([1])}],
            }],
        });
        const result = ble.setValue("1809", "2a19", new Uint8Array([1]));
        globalThis.__ok = result.ok;
        globalThis.__err = result.ok ? null : result.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, okVal),
                              "setValue with unknown service should fail");
    JS_FreeValue(ctx, okVal);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__err");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("NoSuchCharacteristic", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── notify ───────────────────────────────────────────────────────── */

TEST_CASE("Ble.notify with no subscribers is a silent no-op", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{
                    uuid: "2a19",
                    properties: 0x09,  // read | notify
                    value: new Uint8Array([50]),
                }],
            }],
        });
        const result = ble.notify("180f", "2a19", new Uint8Array([42]));
        globalThis.__ok = result.ok;
        globalThis.__err = result.ok ? null : result.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    if (!JS_ToBool(ctx, okVal)) {
        JSValue errName = JS_GetPropertyStr(ctx, global, "__err");
        const char* errStr = JS_ToCString(ctx, errName);
        TEST_FAIL_MESSAGE(errStr ? errStr : "notify returned err");
        if (errStr) JS_FreeCString(ctx, errStr);
        JS_FreeValue(ctx, errName);
    }
    JS_FreeValue(ctx, okVal);
    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.notify on an unknown characteristic errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{
                    uuid: "2a19",
                    properties: 0x09,
                    value: new Uint8Array([1]),
                }],
            }],
        });
        const result = ble.notify("180f", "2a1a", new Uint8Array([1]));
        globalThis.__ok = result.ok;
        globalThis.__err = result.ok ? null : result.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, okVal),
                              "notify with unknown char should fail");
    JS_FreeValue(ctx, okVal);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__err");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("NoSuchCharacteristic", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.notify on a characteristic without notify property errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{
                    uuid: "2a19",
                    properties: 0x01,  // read only, no notify
                    value: new Uint8Array([1]),
                }],
            }],
        });
        const result = ble.notify("180f", "2a19", new Uint8Array([1]));
        globalThis.__ok = result.ok;
        globalThis.__err = result.ok ? null : result.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, okVal),
                              "notify on non-notify char should fail");
    JS_FreeValue(ctx, okVal);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__err");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("InvalidProperties", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Ble.setValue on an unknown characteristic errors", "[ble]") {
    setup();

    JSValue ret = eval_module(R"(
        import {Ble} from "native:mikro/ble";
        const ble = new Ble();
        ble.advertise({
            connectable: true,
            services: [{
                uuid: "180f",
                characteristics: [{uuid: "2a19", properties: 0x01, value: new Uint8Array([1])}],
            }],
        });
        const result = ble.setValue("180f", "2a1a", new Uint8Array([1]));
        globalThis.__ok = result.ok;
        globalThis.__err = result.ok ? null : result.error.name;
        ble.stopAdvertising();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, okVal),
                              "setValue with unknown char should fail");
    JS_FreeValue(ctx, okVal);

    JSValue errName = JS_GetPropertyStr(ctx, global, "__err");
    const char* name = JS_ToCString(ctx, errName);
    TEST_ASSERT_EQUAL_STRING("NoSuchCharacteristic", name);
    if (name) JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, errName);

    JS_FreeValue(ctx, global);
    teardown();
}

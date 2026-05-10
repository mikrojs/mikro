#include "esp_event.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* WiFi status codes — must match MIKWifiStatus in mik_wifi.cpp */
#define WIFI_STATUS_IDLE 0
#define WIFI_STATUS_NO_SSID_AVAIL 1
#define WIFI_STATUS_CONNECTED 3
#define WIFI_STATUS_CONNECT_FAILED 4
#define WIFI_STATUS_CONNECTION_LOST 5
#define WIFI_STATUS_DISCONNECTED 6

static MIKRuntime* rt;
static JSContext* ctx;

/* WiFi consume is needed to drain stale events between tests */
extern void mik__wifi_consume(JSContext* ctx);

static void setup() {
    // Ensure WiFi is idle before each test
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(100));
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    /* Country is config-only — populate it directly so wifi ops that gate on
     * mik__wifi_try_auto_country can proceed. */
    MIKConfig cfg;
    MIK_DefaultConfig(&cfg);
    snprintf(cfg.wifi_country, sizeof(cfg.wifi_country), "US");
    MIK_SetConfig(rt, &cfg);
    /* WiFi module is self-registered and lazily initialized.
     * The import below triggers init + loop consumer registration. */
    const char* init_code = "import { Wifi } from \"native:wifi\"; new Wifi();";
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test-setup", init_code, strlen(init_code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    // Drain any stale events from previous tests
    mik__wifi_consume(ctx);
}

static void teardown() {
    // Disconnect WiFi to avoid leaking "connecting" state into next test
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(100));
    // Drain events before destroying to prevent dangling promise refs
    mik__wifi_consume(ctx);
    MIK_FreeRuntime(rt);
}

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

static int32_t get_wifi_status() {
    JSValue ret = eval_module("globalThis.__s = globalThis.__wifi.status();");
    if (JS_IsException(ret)) return -1;
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, "__s");
    int32_t s;
    JS_ToInt32(ctx, &s, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return s;
}

/* ── Module structure tests ───────────────────────────────────────── */

TEST_CASE("native:wifi exports Wifi with expected methods", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        globalThis.__isFunc = typeof Wifi === "function";
        const wifi = new Wifi();
        globalThis.__isObj = typeof wifi === "object" && wifi !== null;
        globalThis.__methods = ["connect","disconnect","rssi","ip","status","scan","on","off"]
            .every(m => typeof wifi[m] === "function");
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue isFunc = JS_GetPropertyStr(ctx, global, "__isFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isFunc), "Wifi should be a function");
    JS_FreeValue(ctx, isFunc);

    JSValue isObj = JS_GetPropertyStr(ctx, global, "__isObj");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isObj), "new Wifi() should return an object");
    JS_FreeValue(ctx, isObj);

    JSValue methods = JS_GetPropertyStr(ctx, global, "__methods");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, methods), "All expected methods should exist");
    JS_FreeValue(ctx, methods);

    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Wifi ip returns 0.0.0.0 and rssi returns 0 when not connected", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        globalThis.__ip = wifi.ip();
        globalThis.__rssi = wifi.rssi();
        globalThis.__statusType = typeof wifi.status();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue ipVal = JS_GetPropertyStr(ctx, global, "__ip");
    const char* ipStr = JS_ToCString(ctx, ipVal);
    TEST_ASSERT_EQUAL_STRING("0.0.0.0", ipStr);
    JS_FreeCString(ctx, ipStr);
    JS_FreeValue(ctx, ipVal);

    int32_t rssi;
    JSValue rssiVal = JS_GetPropertyStr(ctx, global, "__rssi");
    JS_ToInt32(ctx, &rssi, rssiVal);
    JS_FreeValue(ctx, rssiVal);
    TEST_ASSERT_EQUAL_INT32(0, rssi);

    JSValue stType = JS_GetPropertyStr(ctx, global, "__statusType");
    const char* typeStr = JS_ToCString(ctx, stType);
    TEST_ASSERT_EQUAL_STRING("number", typeStr);
    JS_FreeCString(ctx, typeStr);
    JS_FreeValue(ctx, stType);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Connect returns a promise ─────────────────────────────────────── */

TEST_CASE("Wifi connect returns a promise", "[wifi]") {
    setup();

    // Only test that connect() returns a Promise — don't actually wait for connection.
    // We call disconnect() right after to avoid leaving WiFi in "connecting" state.
    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        const result = wifi.connect("test", "pass");
        globalThis.__isPromise = result.ok && result.value instanceof Promise;
        wifi.disconnect();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isPromise = JS_GetPropertyStr(ctx, global, "__isPromise");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isPromise), "connect() should return a Promise");
    JS_FreeValue(ctx, isPromise);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Scan returns a promise ────────────────────────────────────────── */

TEST_CASE("Wifi scan returns a promise", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        const result = wifi.scan();
        globalThis.__isPromise = result.ok && result.value instanceof Promise;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isPromise = JS_GetPropertyStr(ctx, global, "__isPromise");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isPromise), "scan() should return a Promise");
    JS_FreeValue(ctx, isPromise);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Event-driven state machine tests (mock via esp_event_post) ──── */

TEST_CASE("WiFi status reflects events through connect-disconnect cycle", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        globalThis.__wifi = new Wifi();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    // Connected
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, nullptr, 0, portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_CONNECTED, get_wifi_status());

    // Disconnect: NO_AP_FOUND → NO_SSID_AVAIL
    wifi_event_sta_disconnected_t disc = {};
    disc.reason = WIFI_REASON_NO_AP_FOUND;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_NO_SSID_AVAIL, get_wifi_status());

    // Disconnect: AUTH_FAIL → CONNECT_FAILED
    disc.reason = WIFI_REASON_AUTH_FAIL;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_CONNECT_FAILED, get_wifi_status());

    // Disconnect: BEACON_TIMEOUT → CONNECTION_LOST
    disc.reason = WIFI_REASON_BEACON_TIMEOUT;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_CONNECTION_LOST, get_wifi_status());

    // Disconnect: generic → DISCONNECTED
    disc.reason = WIFI_REASON_UNSPECIFIED;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_DISCONNECTED, get_wifi_status());

    // Reconnect
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_CONNECTED, nullptr, 0, portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    TEST_ASSERT_EQUAL_INT32(WIFI_STATUS_CONNECTED, get_wifi_status());

    teardown();
}

/* ── Event listener tests ──────────────────────────────────────────── */

TEST_CASE("Wifi on/off registers and removes event listeners", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        globalThis.__disconnectCount = 0;
        function onDisconnect(reason) {
            globalThis.__disconnectCount++;
            globalThis.__lastReason = reason;
        }
        wifi.on("disconnect", onDisconnect);
        globalThis.__onDisconnect = onDisconnect;
        globalThis.__wifi = wifi;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    // Fire a disconnect event
    wifi_event_sta_disconnected_t disc = {};
    disc.reason = WIFI_REASON_AUTH_FAIL;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue countVal = JS_GetPropertyStr(ctx, global, "__disconnectCount");
    int32_t count;
    JS_ToInt32(ctx, &count, countVal);
    JS_FreeValue(ctx, countVal);
    TEST_ASSERT_EQUAL_INT32(1, count);

    JSValue reasonVal = JS_GetPropertyStr(ctx, global, "__lastReason");
    const char* reason = JS_ToCString(ctx, reasonVal);
    TEST_ASSERT_EQUAL_STRING("auth-failed", reason);
    JS_FreeCString(ctx, reason);
    JS_FreeValue(ctx, reasonVal);

    // Remove listener and verify it stops receiving events
    eval_module(R"(
        globalThis.__wifi.off("disconnect", globalThis.__onDisconnect);
    )");

    disc.reason = WIFI_REASON_BEACON_TIMEOUT;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, &disc, sizeof(disc), portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    mik__execute_jobs(ctx);

    countVal = JS_GetPropertyStr(ctx, global, "__disconnectCount");
    JS_ToInt32(ctx, &count, countVal);
    JS_FreeValue(ctx, countVal);
    TEST_ASSERT_EQUAL_INT32(1, count);  // still 1, listener was removed

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Phase 4: Network configuration tests ────────────────────────── */

TEST_CASE("Wifi mac returns a valid MAC address format", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        const result = wifi.mac();
        globalThis.__mac = result.ok ? result.value : "";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue macVal = JS_GetPropertyStr(ctx, global, "__mac");
    const char* mac = JS_ToCString(ctx, macVal);
    TEST_ASSERT_NOT_NULL_MESSAGE(mac, "mac() should return a string");
    // MAC format: XX:XX:XX:XX:XX:XX (17 chars)
    TEST_ASSERT_EQUAL_INT(17, strlen(mac));
    // Check colons at expected positions
    TEST_ASSERT_EQUAL_CHAR(':', mac[2]);
    TEST_ASSERT_EQUAL_CHAR(':', mac[5]);
    TEST_ASSERT_EQUAL_CHAR(':', mac[8]);
    TEST_ASSERT_EQUAL_CHAR(':', mac[11]);
    TEST_ASSERT_EQUAL_CHAR(':', mac[14]);
    JS_FreeCString(ctx, mac);
    JS_FreeValue(ctx, macVal);
    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Wifi hostname reflects configured wifi.hostname", "[wifi]") {
    /* Custom setup with wifi.hostname populated. Mirrors setup() but injects
     * a hostname before the lazy netif init runs. */
    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(100));
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
    MIKConfig cfg;
    MIK_DefaultConfig(&cfg);
    snprintf(cfg.wifi_country, sizeof(cfg.wifi_country), "US");
    snprintf(cfg.wifi_hostname, sizeof(cfg.wifi_hostname), "test-device");
    MIK_SetConfig(rt, &cfg);

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        globalThis.__hostname = new Wifi().getHostname();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue hnVal = JS_GetPropertyStr(ctx, global, "__hostname");
    const char* hn = JS_ToCString(ctx, hnVal);
    TEST_ASSERT_EQUAL_STRING("test-device", hn);
    JS_FreeCString(ctx, hn);
    JS_FreeValue(ctx, hnVal);
    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Wifi getIpConfig returns object with expected keys", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        const result = wifi.getIpConfig();
        const cfg = result.ok ? result.value : undefined;
        globalThis.__hasIp = cfg !== undefined && "ip" in cfg;
        globalThis.__hasNetmask = cfg !== undefined && "netmask" in cfg;
        globalThis.__hasGateway = cfg !== undefined && "gateway" in cfg;
        globalThis.__hasDns = cfg !== undefined && "dns" in cfg;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue hasIp = JS_GetPropertyStr(ctx, global, "__hasIp");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasIp), "IpConfig should have 'ip' key");
    JS_FreeValue(ctx, hasIp);

    JSValue hasNetmask = JS_GetPropertyStr(ctx, global, "__hasNetmask");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasNetmask), "IpConfig should have 'netmask' key");
    JS_FreeValue(ctx, hasNetmask);

    JSValue hasGateway = JS_GetPropertyStr(ctx, global, "__hasGateway");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasGateway), "IpConfig should have 'gateway' key");
    JS_FreeValue(ctx, hasGateway);

    JSValue hasDns = JS_GetPropertyStr(ctx, global, "__hasDns");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasDns), "IpConfig should have 'dns' key");
    JS_FreeValue(ctx, hasDns);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Phase 5: AP mode tests ──────────────────────────────────────── */

TEST_CASE("Wifi AP methods exist and return expected types", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        globalThis.__apMethods = ["apStart","apStop","apIsActive","apIp","apStations"]
            .every(m => typeof wifi[m] === "function");
        globalThis.__apInactive = wifi.apIsActive() === false;
        globalThis.__apStationsArray = Array.isArray(wifi.apStations());
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue apMethods = JS_GetPropertyStr(ctx, global, "__apMethods");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, apMethods), "All AP methods should exist");
    JS_FreeValue(ctx, apMethods);

    JSValue apInactive = JS_GetPropertyStr(ctx, global, "__apInactive");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, apInactive), "AP should be inactive initially");
    JS_FreeValue(ctx, apInactive);

    JSValue apStations = JS_GetPropertyStr(ctx, global, "__apStationsArray");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, apStations), "apStations() should return an array");
    JS_FreeValue(ctx, apStations);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Phase 6: Power management & misc tests ──────────────────────── */

TEST_CASE("Wifi power save get/set round-trips", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        wifi.setPowerSave("min");
        globalThis.__ps = wifi.getPowerSave();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue psVal = JS_GetPropertyStr(ctx, global, "__ps");
    const char* ps = JS_ToCString(ctx, psVal);
    TEST_ASSERT_EQUAL_STRING("min", ps);
    JS_FreeCString(ctx, ps);
    JS_FreeValue(ctx, psVal);
    JS_FreeValue(ctx, global);
    teardown();
}

TEST_CASE("Wifi country reflects configured wifi.country", "[wifi]") {
    setup();

    /* setup() populated wifi_country = "US"; trigger a wifi op so
     * mik__wifi_try_auto_country applies it, then read back via getCountry. */
    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        wifi.scan();
        globalThis.__cc = wifi.getCountry();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ccVal = JS_GetPropertyStr(ctx, global, "__cc");
    const char* cc = JS_ToCString(ctx, ccVal);
    TEST_ASSERT_EQUAL_STRING("US", cc);
    JS_FreeCString(ctx, cc);
    JS_FreeValue(ctx, ccVal);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Scan with filter options ─────────────────────────────────────── */

TEST_CASE("Wifi scan accepts filter options", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        const result = wifi.scan({channel: 1, passive: true});
        globalThis.__isPromise = result.ok && result.value instanceof Promise;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isPromise = JS_GetPropertyStr(ctx, global, "__isPromise");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isPromise), "scan({...}) should return a Promise");
    JS_FreeValue(ctx, isPromise);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── TX power get/set ─────────────────────────────────────────────── */

TEST_CASE("Wifi txPower get/set round-trips", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        wifi.setTxPower(8);
        const result = wifi.getTxPower();
        globalThis.__txPower = result.ok ? result.value : 0;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue txVal = JS_GetPropertyStr(ctx, global, "__txPower");
    double txPower;
    JS_ToFloat64(ctx, &txPower, txVal);
    JS_FreeValue(ctx, txVal);
    // ESP-IDF may clamp; just verify it's a reasonable positive number
    TEST_ASSERT_TRUE_MESSAGE(txPower > 0, "TX power should be positive");
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── RSSI threshold ───────────────────────────────────────────────── */

TEST_CASE("Wifi RSSI threshold get/set and event listener", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        wifi.setRssiThreshold(-70);
        globalThis.__threshold = wifi.getRssiThreshold();
        globalThis.__rssiLowCount = 0;
        wifi.on("rssi-low", (rssi) => {
            globalThis.__rssiLowCount++;
            globalThis.__lastRssi = rssi;
        });
        globalThis.__wifi = wifi;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue threshVal = JS_GetPropertyStr(ctx, global, "__threshold");
    int32_t threshold;
    JS_ToInt32(ctx, &threshold, threshVal);
    JS_FreeValue(ctx, threshVal);
    TEST_ASSERT_EQUAL_INT32(-70, threshold);

    // Fire a mock RSSI low event
    wifi_event_bss_rssi_low_t rssi_evt = {};
    rssi_evt.rssi = -75;
    esp_event_post(WIFI_EVENT, WIFI_EVENT_STA_BSS_RSSI_LOW, &rssi_evt, sizeof(rssi_evt),
                   portMAX_DELAY);
    vTaskDelay(pdMS_TO_TICKS(50));
    mik__wifi_consume(ctx);
    mik__execute_jobs(ctx);

    JSValue countVal = JS_GetPropertyStr(ctx, global, "__rssiLowCount");
    int32_t count;
    JS_ToInt32(ctx, &count, countVal);
    JS_FreeValue(ctx, countVal);
    TEST_ASSERT_EQUAL_INT32(1, count);

    JSValue rssiVal = JS_GetPropertyStr(ctx, global, "__lastRssi");
    int32_t rssi;
    JS_ToInt32(ctx, &rssi, rssiVal);
    JS_FreeValue(ctx, rssiVal);
    TEST_ASSERT_EQUAL_INT32(-75, rssi);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── AP deauthStation and inactiveTimeout methods exist ───────────── */

TEST_CASE("Wifi AP extra methods exist", "[wifi]") {
    setup();

    JSValue ret = eval_module(R"(
        import { Wifi } from "native:wifi";
        const wifi = new Wifi();
        globalThis.__hasDeauth = typeof wifi.apDeauthStation === "function";
        globalThis.__hasGetTimeout = typeof wifi.apGetInactiveTimeout === "function";
        globalThis.__hasSetTimeout = typeof wifi.apSetInactiveTimeout === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue hasDeauth = JS_GetPropertyStr(ctx, global, "__hasDeauth");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasDeauth), "apDeauthStation should be a function");
    JS_FreeValue(ctx, hasDeauth);

    JSValue hasGetTimeout = JS_GetPropertyStr(ctx, global, "__hasGetTimeout");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasGetTimeout),
                             "apGetInactiveTimeout should be a function");
    JS_FreeValue(ctx, hasGetTimeout);

    JSValue hasSetTimeout = JS_GetPropertyStr(ctx, global, "__hasSetTimeout");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, hasSetTimeout),
                             "apSetInactiveTimeout should be a function");
    JS_FreeValue(ctx, hasSetTimeout);

    JS_FreeValue(ctx, global);
    teardown();
}

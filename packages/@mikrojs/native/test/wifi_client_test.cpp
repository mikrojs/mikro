#include <cstring>
#include <ctime>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Characterization tests for the mikro/wifi builtin, pinned before porting it
 * to C++. The real builtin bytecode runs on top of a scripted fake registered
 * as a virtual module for native:mikro/wifi (the same mechanism the simulator
 * uses). Each driver stashes observations on globalThis; assertions read them
 * back as JSON. Modeled on test/http_client_test.cpp. */

namespace {

/* Scriptable fake of the native:mikro/wifi surface (runtime/internal.d.ts).
 * Reads the per-test scenario from globalThis.__wifiScenario and records
 * every call (name + args) into globalThis.__wifiCalls.calls. Events are
 * fired from tests via globalThis.__wifiEmit(event, payload). */
static const char* FAKE_WIFI = R"JS(
import {err, ok} from 'mikro/result'

globalThis.__wifiCalls = {constructed: 0, calls: []}

const sc = () => globalThis.__wifiScenario ?? {}
const rec = (name, ...args) => globalThis.__wifiCalls.calls.push([name, ...args])

const listeners = new Map()
globalThis.__wifiEmit = (event, payload) => {
  for (const fn of (listeners.get(event) ?? []).slice()) fn(payload)
}

let connectAttempts = 0

export class Wifi {
  constructor() {
    globalThis.__wifiCalls.constructed++
  }

  connect(ssid, passphrase) {
    rec('connect', ssid, passphrase)
    const s = sc()
    if (s.connectStartError) return err(s.connectStartError)
    if (s.connectInnerReject) return ok(Promise.reject(new Error(s.connectInnerReject)))
    connectAttempts++
    const fail = connectAttempts <= (s.connectFailures ?? 0)
    const settled = fail
      ? err({name: 'ConnectFailed', message: 'assoc failed'})
      : ok(s.connectionInfo ?? {ip: '10.0.0.2', netmask: '255.255.255.0', gateway: '10.0.0.1'})
    return ok(Promise.resolve(settled))
  }

  disconnect(shutdown) {
    rec('disconnect', shutdown)
    return ok(undefined)
  }

  rssi() {
    rec('rssi')
    return ok(sc().rssi ?? -55)
  }

  ip() {
    rec('ip')
    return sc().ip ?? '0.0.0.0'
  }

  status() {
    return sc().statusCode ?? 6
  }

  scan(opts) {
    rec('scan', opts)
    const s = sc()
    if (s.scanStartError) return err(s.scanStartError)
    if (s.scanInnerReject) return ok(Promise.reject(new Error(s.scanInnerReject)))
    return ok(Promise.resolve(ok(s.scanResults ?? [])))
  }

  on(event, fn) {
    rec('on', event)
    const arr = listeners.get(event) ?? []
    arr.push(fn)
    listeners.set(event, arr)
  }

  off(event, fn) {
    rec('off', event)
    const arr = listeners.get(event) ?? []
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }

  mac() {
    rec('mac')
    const s = sc()
    return s.macError ? err(s.macError) : ok(s.mac ?? 'aa:bb:cc:dd:ee:ff')
  }

  getHostname() {
    rec('getHostname')
    return sc().hostname
  }

  getIpConfig() {
    rec('getIpConfig')
    const s = sc()
    if (s.ipConfigBareUndefined) return undefined
    return ok(s.ipConfig ?? {ip: '10.0.0.2', netmask: '255.255.255.0', gateway: '10.0.0.1', dns: '10.0.0.1'})
  }

  setIpConfig(opts) {
    rec('setIpConfig', opts)
    return ok(undefined)
  }

  apStart(opts) {
    rec('apStart', opts)
    return ok(undefined)
  }

  apStop() {
    rec('apStop')
    return ok(undefined)
  }

  apIsActive() {
    rec('apIsActive')
    return sc().apIsActive ?? false
  }

  apIp() {
    rec('apIp')
    return sc().apIp
  }

  apStations() {
    rec('apStations')
    return sc().apStations ?? []
  }

  apDeauthStation(mac) {
    rec('apDeauthStation', mac)
    return ok(undefined)
  }

  apGetInactiveTimeout() {
    rec('apGetInactiveTimeout')
    const s = sc()
    return s.apInactiveTimeoutError ? err(s.apInactiveTimeoutError) : ok(s.apInactiveTimeout ?? 300)
  }

  apSetInactiveTimeout(seconds) {
    rec('apSetInactiveTimeout', seconds)
    return ok(undefined)
  }

  getTxPower() {
    rec('getTxPower')
    const s = sc()
    return s.txPowerError ? err(s.txPowerError) : ok(s.txPower ?? 20)
  }

  setTxPower(dbm) {
    rec('setTxPower', dbm)
    const s = sc()
    return s.setTxPowerError ? err(s.setTxPowerError) : ok(undefined)
  }

  getRssiThreshold() {
    rec('getRssiThreshold')
    return sc().rssiThreshold ?? 0
  }

  setRssiThreshold(threshold) {
    rec('setRssiThreshold', threshold)
    return ok(undefined)
  }

  getPowerSave() {
    rec('getPowerSave')
    return sc().powerSave ?? 'min'
  }

  setPowerSave(mode) {
    rec('setPowerSave', mode)
    return ok(undefined)
  }

  getCountry() {
    rec('getCountry')
    return sc().country
  }
}
)JS";

/* Eval a JS module string; errors are dumped to stderr. Caller frees. */
static JSValue eval_module(JSContext* ctx, const char* src, const char* filename) {
    std::string code = src;
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), filename, JS_EVAL_TYPE_MODULE);
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

static int read_global_int(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    int32_t i = -1;
    JS_ToInt32(ctx, &i, v);
    JS_FreeValue(ctx, v);
    return i;
}

/* JSON.stringify(globalThis[name]); "<unset>" when undefined. */
static std::string read_global_json(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    JSValue json = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(ctx, v);
    if (!JS_IsString(json)) {
        JS_FreeValue(ctx, json);
        return "<unset>";
    }
    const char* s = JS_ToCString(ctx, json);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, json);
    return out;
}

struct WifiFixture {
    MIKRuntime* rt;
    JSContext* ctx;
    int runs = 0;

    WifiFixture() {
        rt = MIK_NewRuntime();
        ctx = MIK_GetJSContext(rt);
        MIK_RegisterVirtualModule(rt, "native:mikro/wifi", FAKE_WIFI, strlen(FAKE_WIFI));
    }
    ~WifiFixture() { MIK_FreeRuntime(rt); }
    WifiFixture(const WifiFixture&) = delete;
    WifiFixture& operator=(const WifiFixture&) = delete;

    /* Wrap `body_src` in an async driver importing mikro/wifi; pump until the
     * driver sets __done. Returns false on eval error or timeout. */
    bool run(const char* body_src, int max_iter = 3000) {
        std::string code =
            "import {wifi} from 'mikro/wifi'\n"
            "const __calls = () => globalThis.__wifiCalls.calls\n"
            "const __count = (name, ev) =>\n"
            "  __calls().filter((c) => c[0] === name && (ev === undefined || c[1] === ev)).length\n"
            "globalThis.__done = 0\n"
            "const __finish = (v) => { globalThis.__r = v; globalThis.__done = 1 }\n"
            "const __fail = (e) => {\n"
            "  globalThis.__r = 'FAIL:' + (e && e.stack ? e.stack : String(e))\n"
            "  globalThis.__done = 1\n"
            "}\n"
            ";(async () => {\n";
        code += body_src;
        code += "\n})().then(undefined, __fail)\n";
        char filename[64];
        snprintf(filename, sizeof(filename), "/test/wifi_driver_%d.js", runs++);
        JSValue rv = eval_module(ctx, code.c_str(), filename);
        bool ok = !JS_IsException(rv);
        JS_FreeValue(ctx, rv);
        if (!ok) return false;
        if (!pump_until(rt, max_iter, [&] { return read_global_int(ctx, "__done") == 1; })) {
            fprintf(stderr, "[WifiFixture] driver timed out\n");
            return false;
        }
        return true;
    }

    std::string result() { return read_global_json(ctx, "__r"); }
};

}  // namespace

TEST_CASE("importing mikro/wifi constructs the native Wifi exactly once" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {statusCode: 3}
        const status = wifi.status()
        __finish({constructed: globalThis.__wifiCalls.constructed, status})
    )JS"));
    CHECK_EQ(f.result(), R"({"constructed":1,"status":"CONNECTED"})");
}

TEST_CASE("connect happy path passes credentials and resolves the connection info" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          connectionInfo: {ip: '192.168.1.50', netmask: '255.255.255.0', gateway: '192.168.1.1'},
        }
        const result = await wifi.connect({ssid: 'mynet', passphrase: 'hunter22'})
        __finish({
          ok: result.ok,
          info: result.ok ? result.value : undefined,
          connectArgs: __calls().filter((c) => c[0] === 'connect'),
          txPowerCalls: __count('setTxPower'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"ok":true,)"
             R"("info":{"ip":"192.168.1.50","netmask":"255.255.255.0","gateway":"192.168.1.1"},)"
             R"("connectArgs":[["connect","mynet","hunter22"]],"txPowerCalls":0})");
}

TEST_CASE("connect txPower option runs setTxPower before connect and short-circuits on error" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        const first = await wifi.connect({ssid: 's', passphrase: 'p', txPower: 15})
        const orderOk =
          __calls().findIndex((c) => c[0] === 'setTxPower') <
          __calls().findIndex((c) => c[0] === 'connect')
        globalThis.__wifiCalls.calls = []
        globalThis.__wifiScenario = {
          setTxPowerError: {name: 'InvalidArgument', message: 'bad dbm'},
        }
        const second = await wifi.connect({ssid: 's', passphrase: 'p', txPower: 99})
        __finish({
          firstOk: first.ok,
          orderOk,
          secondOk: second.ok,
          secondName: second.ok ? undefined : second.error.name,
          connectsAfterTxError: __count('connect'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"firstOk":true,"orderOk":true,"secondOk":false,)"
             R"("secondName":"InvalidArgument","connectsAfterTxError":0})");
}

TEST_CASE("connect start error Result is returned verbatim without retrying" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          connectStartError: {name: 'ConnectInProgress'},
        }
        const result = await wifi.connect({ssid: 's', passphrase: 'p'})
        __finish({
          ok: result.ok,
          name: result.ok ? undefined : result.error.name,
          connects: __count('connect'),
          disconnects: __count('disconnect'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"ok":false,"name":"ConnectInProgress","connects":1,"disconnects":0})");
}

/* Real time: one 2s retry backoff. */
TEST_CASE("connect retries after a failed attempt and succeeds on the second" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {connectFailures: 1}
        const result = await wifi.connect({ssid: 'mynet', passphrase: 'pw'})
        __finish({
          ok: result.ok,
          connects: __count('connect'),
          radioKeptUp: __calls().some((c) => c[0] === 'disconnect' && c[1] === false),
          disconnects: __count('disconnect'),
        })
    )JS", 10000));
    CHECK_EQ(f.result(), R"({"ok":true,"connects":2,"radioKeptUp":true,"disconnects":1})");
}

TEST_CASE("status maps native codes to strings and unknown codes to DISCONNECTED" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        const at = (code) => {
          globalThis.__wifiScenario = {statusCode: code}
          return [wifi.status(), wifi.isConnected]
        }
        __finish({
          idle: at(0),
          connected: at(3),
          stopped: at(254),
          unknown: at(99),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"idle":["IDLE",false],"connected":["CONNECTED",true],)"
             R"("stopped":["STOPPED",false],"unknown":["DISCONNECTED",false]})");
}

TEST_CASE("ip() maps 0.0.0.0 to undefined and passes real addresses through" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        const unset = wifi.ip()
        globalThis.__wifiScenario = {ip: '192.168.1.7'}
        const set = wifi.ip()
        __finish({unset: String(unset), set})
    )JS"));
    CHECK_EQ(f.result(), R"({"unset":"undefined","set":"192.168.1.7"})");
}

TEST_CASE("disconnect forwards the shutdown flag positionally" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        const bare = wifi.disconnect()
        const shutdown = wifi.disconnect({shutdown: true})
        const keep = wifi.disconnect({shutdown: false})
        __finish({
          bareOk: bare.ok,
          shutdownOk: shutdown.ok,
          keepOk: keep.ok,
          args: __calls().filter((c) => c[0] === 'disconnect').map((c) => String(c[1])),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"bareOk":true,"shutdownOk":true,"keepOk":true,)"
             R"("args":["undefined","true","false"]})");
}

TEST_CASE("scan forwards options and passes results and start errors through" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          scanResults: [{ssid: 'a', bssid: '00:11', channel: 6, rssi: -40,
                         authMode: 'wpa2', hidden: false}],
        }
        const good = await wifi.scan({channel: 6, passive: true})
        globalThis.__wifiScenario = {scanStartError: {name: 'ScanInProgress'}}
        const bad = await wifi.scan()
        __finish({
          goodOk: good.ok,
          ssids: good.ok ? good.value.map((r) => r.ssid) : undefined,
          scanArgs: __calls().filter((c) => c[0] === 'scan').map((c) => c[1]),
          badOk: bad.ok,
          badName: bad.ok ? undefined : bad.error.name,
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"goodOk":true,"ssids":["a"],)"
             R"("scanArgs":[{"channel":6,"passive":true},null],)"
             R"("badOk":false,"badName":"ScanInProgress"})");
}

TEST_CASE("getters swallow err Results into defaults; setters discard Results" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          mac: '11:22:33:44:55:66', hostname: 'device-7', txPower: 18,
          rssiThreshold: -70, powerSave: 'max', country: 'NO',
        }
        const populated = {
          mac: wifi.mac, hostname: wifi.hostname, txPower: wifi.txPower,
          rssiThreshold: wifi.rssiThreshold, powerSave: wifi.powerSave,
          country: wifi.country,
        }
        globalThis.__wifiScenario = {
          macError: {name: 'NotInitialized'},
          txPowerError: {name: 'NotInitialized'},
        }
        const fallback = {
          mac: wifi.mac, txPower: wifi.txPower,
          hostname: String(wifi.hostname), country: String(wifi.country),
        }
        wifi.rssiThreshold = -80
        wifi.powerSave = 'none'
        __finish({
          populated,
          fallback,
          setCalls: __calls().filter(
            (c) => c[0] === 'setRssiThreshold' || c[0] === 'setPowerSave'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"populated":{"mac":"11:22:33:44:55:66","hostname":"device-7","txPower":18,)"
             R"("rssiThreshold":-70,"powerSave":"max","country":"NO"},)"
             R"("fallback":{"mac":"","txPower":0,"hostname":"undefined","country":"undefined"},)"
             R"("setCalls":[["setRssiThreshold",-80],["setPowerSave","none"]]})");
}

TEST_CASE("rssi passes the native Result through" * doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {rssi: -42}
        const r = wifi.rssi()
        __finish({ok: r.ok, value: r.ok ? r.value : undefined})
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":true,"value":-42})");
}

TEST_CASE("ipConfig() passes getIpConfig through including the bare-undefined quirk" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          ipConfig: {ip: '10.0.0.9', netmask: '255.255.255.0', gateway: '10.0.0.1',
                     dns: '1.1.1.1'},
        }
        const got = wifi.ipConfig()
        globalThis.__wifiScenario = {ipConfigBareUndefined: true}
        /* Quirk: native returns bare undefined (no Result) when the netif is
         * missing, and wifi.ipConfig() passes that straight through. */
        const quirk = wifi.ipConfig()
        globalThis.__wifiScenario = {}
        const set = wifi.ipConfig({ip: '10.0.0.9', dhcp: false})
        __finish({
          gotOk: got.ok,
          dns: got.ok ? got.value.dns : undefined,
          quirk: String(quirk),
          setOk: set.ok,
          setArgs: __calls().filter((c) => c[0] === 'setIpConfig').map((c) => c[1]),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"gotOk":true,"dns":"1.1.1.1","quirk":"undefined","setOk":true,)"
             R"("setArgs":[{"ip":"10.0.0.9","dhcp":false}]})");
}

TEST_CASE("ap namespace forwards calls and swallows inactiveTimeout errors" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {
          apIsActive: true, apIp: '192.168.4.1',
          apStations: [{mac: 'aa:aa', rssi: -30}],
          apInactiveTimeout: 120,
        }
        const start = wifi.ap.start({ssid: 'ap-net', passphrase: 'pw', channel: 11})
        const stop = wifi.ap.stop()
        const deauth = wifi.ap.deauthStation('aa:aa')
        const snapshot = {
          isActive: wifi.ap.isActive,
          ip: wifi.ap.ip,
          stations: wifi.ap.stations,
          inactiveTimeout: wifi.ap.inactiveTimeout,
        }
        globalThis.__wifiScenario = {apInactiveTimeoutError: {name: 'NotInitialized'}}
        const timeoutFallback = wifi.ap.inactiveTimeout
        wifi.ap.inactiveTimeout = 60
        __finish({
          startOk: start.ok, stopOk: stop.ok, deauthOk: deauth.ok,
          snapshot,
          timeoutFallback,
          startArgs: __calls().filter((c) => c[0] === 'apStart').map((c) => c[1]),
          deauthArgs: __calls().filter((c) => c[0] === 'apDeauthStation').map((c) => c[1]),
          setTimeoutArgs: __calls().filter((c) => c[0] === 'apSetInactiveTimeout').map((c) => c[1]),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"startOk":true,"stopOk":true,"deauthOk":true,)"
             R"("snapshot":{"isActive":true,"ip":"192.168.4.1",)"
             R"("stations":[{"mac":"aa:aa","rssi":-30}],"inactiveTimeout":120},)"
             R"("timeoutFallback":0,)"
             R"("startArgs":[{"ssid":"ap-net","passphrase":"pw","channel":11}],)"
             R"("deauthArgs":["aa:aa"],"setTimeoutArgs":[60]})");
}

TEST_CASE("onConnect registers one native listener, fans out, and detaches on last unsubscribe" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        const seen1 = []
        const seen2 = []
        const s1 = wifi.onConnect.subscribe((v) => seen1.push(v))
        const s2 = wifi.onConnect.subscribe((v) => seen2.push(v))
        const onsAfterSubscribe = __count('on', 'connect')
        globalThis.__wifiEmit('connect', {ip: '1.2.3.4'})
        await new Promise((resolve) => setTimeout(resolve, 20))
        s1.unsubscribe()
        const offsAfterFirst = __count('off', 'connect')
        s2.unsubscribe()
        const offsAfterBoth = __count('off', 'connect')
        globalThis.__wifiEmit('connect', {ip: '5.6.7.8'})
        await new Promise((resolve) => setTimeout(resolve, 20))
        __finish({onsAfterSubscribe, seen1, seen2, offsAfterFirst, offsAfterBoth})
    )JS"));
    CHECK_EQ(f.result(),
             R"({"onsAfterSubscribe":1,"seen1":[{"ip":"1.2.3.4"}],)"
             R"("seen2":[{"ip":"1.2.3.4"}],"offsAfterFirst":0,"offsAfterBoth":1})");
}

TEST_CASE("ap.onStationConnect delivers the event payload" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        const seen = []
        const sub = wifi.ap.onStationConnect.subscribe((v) => seen.push(v))
        const eventName = __calls().find((c) => c[0] === 'on')[1]
        globalThis.__wifiEmit('station-connect', {mac: 'bb:bb'})
        await new Promise((resolve) => setTimeout(resolve, 20))
        sub.unsubscribe()
        __finish({eventName, seen})
    )JS"));
    CHECK_EQ(f.result(), R"({"eventName":"station-connect","seen":[{"mac":"bb:bb"}]})");
}

TEST_CASE("a rejecting inner connect promise rejects wifi.connect with the same reason" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {connectInnerReject: 'boom'}
        let msg = ''
        try {
          await wifi.connect({ssid: 's', passphrase: 'p'})
        } catch (e) {
          msg = String(e && e.message)
        }
        __finish({msg, connects: __count('connect'), disconnects: __count('disconnect')})
    )JS"));
    /* TS parity: `await startResult.value` rethrew, so no retry runs. */
    CHECK_EQ(f.result(), R"({"msg":"boom","connects":1,"disconnects":0})");
}

TEST_CASE("a rejecting inner scan promise rejects wifi.scan with the same reason" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {scanInnerReject: 'radio gone'}
        let msg = ''
        try {
          await wifi.scan()
        } catch (e) {
          msg = String(e && e.message)
        }
        __finish({msg, scans: __count('scan')})
    )JS"));
    CHECK_EQ(f.result(), R"({"msg":"radio gone","scans":1})");
}

TEST_CASE("wifi.connect() without options rejects asynchronously instead of throwing" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {}
        let syncThrew = false
        let p
        try {
          p = wifi.connect()
        } catch (e) {
          syncThrew = true
        }
        let rejected = false
        let isTypeError = false
        try {
          await p
        } catch (e) {
          rejected = true
          isTypeError = e instanceof TypeError
        }
        __finish({syncThrew, isPromise: p instanceof Promise, rejected, isTypeError,
                  connects: __count('connect')})
    )JS"));
    /* TS parity: destructuring `options` inside the async function made a
     * missing argument reject, never throw synchronously. */
    CHECK_EQ(f.result(),
             R"({"syncThrew":false,"isPromise":true,"rejected":true,"isTypeError":true,)"
             R"("connects":0})");
}

TEST_CASE("a virtual module can override mikro/wifi" * doctest::test_suite("wifi_client")) {
    WifiFixture f;
    static const char* OVERRIDE = "export const wifi = 'virtual'\n";
    MIK_RegisterVirtualModule(f.rt, "mikro/wifi", OVERRIDE, strlen(OVERRIDE));
    JSValue rv = eval_module(f.ctx,
                             "import {wifi} from 'mikro/wifi'\n"
                             "globalThis.__r = wifi\n",
                             "/test/wifi_virtual_override.js");
    REQUIRE(!JS_IsException(rv));
    JS_FreeValue(f.ctx, rv);
    pump_until(f.rt, 100, [&] { return f.result() != "<unset>"; });
    CHECK_EQ(f.result(), R"("virtual")");
}

TEST_CASE("freeing the runtime while a retry backoff timer is armed does not crash" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {connectFailures: 100}
        void wifi.connect({ssid: 's', passphrase: 'p'})
        __finish('kicked')
    )JS"));
    /* Pump until the first attempt failed and armed the 2s retry timer
     * (disconnect(false) precedes the arm), then tear down mid-backoff via
     * the fixture destructor. Passing means no crash and no leak report. */
    bool armed = pump_until(f.rt, 2000, [&] {
        return read_global_json(f.ctx, "__wifiCalls").find("\"disconnect\"") != std::string::npos;
    });
    CHECK(armed);
}

/* Real time: exhaustion walks all 6 attempts with 5 x 2s backoffs (~10s).
 * Kept last so the slow case doesn't sit in the middle of the suite. */
TEST_CASE("connect exhaustion returns the last native error after six attempts" *
          doctest::test_suite("wifi_client")) {
    WifiFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__wifiScenario = {connectFailures: 100}
        const result = await wifi.connect({ssid: 'mynet', passphrase: 'pw'})
        __finish({
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          connects: __count('connect'),
          disconnects: __count('disconnect'),
        })
    )JS", 30000));
    /* Note: wifi.ts:99 returns the final native err verbatim; the
     * 'max retries exceeded' fallback at wifi.ts:107 is unreachable. */
    CHECK_EQ(f.result(),
             R"({"ok":false,"error":{"name":"ConnectFailed","message":"assoc failed"},)"
             R"("connects":6,"disconnects":5})");
}

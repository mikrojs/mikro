/* Conformance tests for the mikro/test runner: the event stream a test file
 * produces (codes, fields, order), only/skip/todo filtering, .each name
 * interpolation, hook ordering and failure handling, timeouts, assertion
 * messages, and the heap/timer figures in run_done. */

#include <ctime>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

namespace {

struct RunnerFixture {
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;
    std::vector<std::string> events;
    std::string eval_error;

    static void capture(const char* json, size_t len, void* opaque) {
        static_cast<RunnerFixture*>(opaque)->events.emplace_back(json, len);
    }

    RunnerFixture() {
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
        /* mikro/sys and the runner import ESP-only natives; stub what the
         * host lacks. pendingCount reads a global so a test can fake a leak. */
        static const char* SLEEP = "export function getWakeupCause() { return 'undefined' }\n"
                                   "export function deepSleep() {}\n"
                                   "export function lightSleep() {}\n";
        static const char* HTTP = "export function pendingCount() { return globalThis.__pending ?? 0 }\n";
        MIK_RegisterVirtualModule(rt, "native:mikro/sleep", SLEEP, strlen(SLEEP));
        MIK_RegisterVirtualModule(rt, "native:mikro/http", HTTP, strlen(HTTP));
        MIK_EnableTestHelpers(rt);
        MIK_SetTestEmitHandler(rt, capture, this);
    }

    ~RunnerFixture() { MIK_FreeRuntime(rt); }

    /* Evaluate a test file. Returns false (with eval_error set) when module
     * evaluation itself rejects, e.g. test() outside describe(). */
    bool eval(const char* src) {
        std::string code = "import {describe, test, assert, beforeAll, afterAll, beforeEach, "
                           "afterEach} from 'mikro/test'\n";
        code += src;
        JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "/test/runner_driver.test.js",
                             JS_EVAL_TYPE_MODULE);
        if (JS_IsException(rv)) {
            JSValue exc = JS_GetException(ctx);
            const char* s = JS_ToCString(ctx, exc);
            std::string msg = s ? s : "?";
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, exc);
            FAIL("eval threw: " << msg);
        }
        MIK_Loop(rt); /* drain the evaluation's microtasks */
        JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
        if (state == JS_PROMISE_REJECTED) {
            JSValue reason = JS_PromiseResult(ctx, rv);
            const char* s = JS_ToCString(ctx, reason);
            eval_error = s ? s : "";
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, reason);
        }
        JS_FreeValue(ctx, rv);
        return state == JS_PROMISE_FULFILLED;
    }

    bool done() const { return !events.empty() && code(events.back()) == 6; }

    /* Evaluate and pump the loop until run_done. */
    void run(const char* src, int max_ms = 3000) {
        REQUIRE(eval(src));
        for (int i = 0; i < max_ms && !done(); i++) {
            MIK_Loop(rt);
            struct timespec ts = {0, 1 * 1000 * 1000};
            nanosleep(&ts, nullptr);
        }
        REQUIRE(done());
    }

    static int code(const std::string& ev) {
        REQUIRE(ev.rfind("{\"e\":", 0) == 0);
        return atoi(ev.c_str() + 5);
    }

    /* Event codes in order, e.g. "8,1,8,2,5,6". */
    std::string codes() const {
        std::string out;
        for (const auto& ev : events) {
            if (!out.empty()) out += ',';
            out += std::to_string(code(ev));
        }
        return out;
    }

    int count(int c) const {
        int n = 0;
        for (const auto& ev : events) n += code(ev) == c;
        return n;
    }

    /* First event containing `needle`, or "" when none does. */
    std::string find(const char* needle) const {
        for (const auto& ev : events) {
            if (ev.find(needle) != std::string::npos) return ev;
        }
        return "";
    }

    const std::string& last() const { return events.back(); }

    static bool has(const std::string& ev, const char* key) {
        return ev.find(std::string("\"") + key + "\":") != std::string::npos;
    }

    static long num(const std::string& ev, const char* key) {
        std::string k = std::string("\"") + key + "\":";
        size_t at = ev.find(k);
        REQUIRE(at != std::string::npos);
        return atol(ev.c_str() + at + k.size());
    }

    /* Raw (still JSON-escaped) string value of `key`. */
    static std::string str(const std::string& ev, const char* key) {
        std::string k = std::string("\"") + key + "\":\"";
        size_t at = ev.find(k);
        REQUIRE(at != std::string::npos);
        size_t start = at + k.size();
        size_t end = start;
        while (end < ev.size() && ev[end] != '"') {
            if (ev[end] == '\\') end++;
            end++;
        }
        return ev.substr(start, end - start);
    }

    std::string global(const char* name) const {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue v = JS_GetPropertyStr(ctx, g, name);
        JS_FreeValue(ctx, g);
        const char* s = JS_ToCString(ctx, v);
        std::string out = s ? s : "";
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, v);
        return out;
    }
};

}  // namespace

TEST_CASE_FIXTURE(RunnerFixture, "a passing and a failing test produce the event stream" *
                                     doctest::test_suite("test-runner")) {
    run("describe('math', () => {\n"
        "  test('adds', () => { assert.equal(1 + 1, 2) })\n"
        "  test('fails', () => { assert.equal(1, 2) })\n"
        "})\n");
    CHECK(codes() == "8,1,8,2,8,3,5,6");
    CHECK(events[1] == "{\"e\":1,\"s\":\"math\",\"n\":2}");
    const std::string pass = find("\"e\":2");
    CHECK(str(pass, "s") == "math");
    CHECK(str(pass, "t") == "adds");
    CHECK(has(pass, "d"));
    const std::string fail = find("\"e\":3");
    CHECK(str(fail, "t") == "fails");
    CHECK(str(fail, "m") == "expected 2, got 1");
    CHECK(num(last(), "p") == 1);
    CHECK(num(last(), "f") == 1);
    CHECK(num(last(), "k") == 0);
    CHECK(num(last(), "o") == 0);
    CHECK(has(last(), "d"));
    CHECK(has(last(), "hb"));
    CHECK(has(last(), "ha"));
    CHECK(has(last(), "hr"));
    CHECK(num(last(), "tb") == 0);
    CHECK(num(last(), "ta") == 0);
    /* Nothing loaded the http module, so nothing can be pending. */
    CHECK(num(last(), "pb") == 0);
    CHECK(num(last(), "pa") == 0);
    /* No system heap on the host: the su/sf figures are omitted. */
    CHECK_FALSE(has(last(), "su"));
    CHECK_FALSE(has(last(), "sf"));
    /* The heap event carries QuickJS figures only on the host. */
    CHECK(has(events[0], "u"));
    CHECK(has(events[0], "t"));
    CHECK_FALSE(has(events[0], "f"));
}

TEST_CASE_FIXTURE(RunnerFixture, "suite_end carries the suite's retained bytes" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => { test('t', () => {}) })\n");
    const std::string end = find("\"e\":5");
    CHECK(has(end, "hr"));
    CHECK_FALSE(has(end, "su"));
}

TEST_CASE_FIXTURE(RunnerFixture, "an empty file still reports run_done" *
                                     doctest::test_suite("test-runner")) {
    run("globalThis.__x = 1\n");
    CHECK(codes() == "6");
    CHECK(num(last(), "p") == 0);
    CHECK(has(last(), "hr"));
    CHECK(num(last(), "ta") == 0);
}

TEST_CASE_FIXTURE(RunnerFixture, "names are JSON-escaped" * doctest::test_suite("test-runner")) {
    run("describe('su\"ite\\\\', () => {\n"
        "  test('q\"uo\\te\\nñ\\u0001', () => {})\n"
        "})\n");
    const std::string pass = find("\"e\":2");
    CHECK(str(pass, "s") == "su\\\"ite\\\\");
    CHECK(str(pass, "t") == "q\\\"uo\\te\\nñ\\u0001");
    CHECK(str(events[1], "s") == "su\\\"ite\\\\");
}

TEST_CASE_FIXTURE(RunnerFixture, "assertion failure messages" *
                                     doctest::test_suite("test-runner")) {
    run("import {ok, err} from 'mikro/result'\n"
        "class Foo {}\n"
        "describe('assert', () => {\n"
        "  test('equal msg', () => { assert.equal(1, 2, 'ctx') })\n"
        "  test('equal str', () => { assert.equal('a', 'b') })\n"
        "  test('equal undef', () => { assert.equal(undefined, null) })\n"
        "  test('equal u8', () => { assert.equal(new Uint8Array([1, 2]), 3) })\n"
        "  test('notEqual', () => { assert.notEqual(1, 1) })\n"
        "  test('truthy', () => { assert.truthy(0) })\n"
        "  test('deepEqual', () => { assert.deepEqual([1, 2], [1, 3]) })\n"
        "  test('throws', () => { assert.throws(() => {}) })\n"
        "  test('rejects', async () => { await assert.rejects(async () => {}) })\n"
        "  test('type', () => { assert.type(1, 'string') })\n"
        "  test('instance', () => { assert.instance({}, Foo) })\n"
        "  test('ok', () => { assert.ok(err({name: 'Net', message: 'down'})) })\n"
        "  test('ok err instance', () => { assert.ok(err(new Error('bad'))) })\n"
        "  test('err', () => { assert.err(ok(5)) })\n"
        "  test('err msg', () => { assert.err(ok({a: 1}), 'why') })\n"
        "  test('nan equal', () => { assert.equal(NaN, NaN); assert.notEqual(0, -0) })\n"
        "  test('throws returns', () => {\n"
        "    const e = assert.throws(() => { throw 'str' })\n"
        "    assert.instance(e, Error); assert.equal(e.message, 'str')\n"
        "    const e2 = assert.throws(() => { throw new TypeError('te') })\n"
        "    assert.instance(e2, TypeError)\n"
        "  })\n"
        "  test('rejects returns', async () => {\n"
        "    const e = await assert.rejects(() => Promise.reject(new RangeError('re')))\n"
        "    assert.instance(e, RangeError)\n"
        "    const e2 = await assert.rejects(async () => { throw 7 })\n"
        "    assert.equal(e2.message, '7')\n"
        "  })\n"
        "  test('assert error shape', () => {\n"
        "    const e = assert.throws(() => assert.equal(1, 2))\n"
        "    assert.equal(e.name, 'AssertError'); assert.instance(e, Error)\n"
        "  })\n"
        "})\n");
    auto msg = [&](const char* name) {
        std::string needle = std::string("\"t\":\"") + name + "\"";
        const std::string ev = find(needle.c_str());
        REQUIRE(ev != "");
        return code(ev) == 3 ? str(ev, "m") : std::string("<passed>");
    };
    CHECK(msg("equal msg") == "ctx: expected 2, got 1");
    CHECK(msg("equal str") == "expected \\\"b\\\", got \\\"a\\\"");
    CHECK(msg("equal undef") == "expected null, got undefined");
    CHECK(msg("equal u8") == "expected 3, got Uint8Array[1, 2]");
    CHECK(msg("notEqual") == "expected value to differ from 1");
    CHECK(msg("truthy") == "expected truthy, got 0");
    CHECK(msg("deepEqual") == "expected [1,3], got [1,2]");
    CHECK(msg("throws") == "expected function to throw");
    CHECK(msg("rejects") == "expected promise to reject");
    CHECK(msg("type") == "expected typeof string, got number");
    CHECK(msg("instance") == "expected instanceof Foo, got {}");
    CHECK(msg("ok") == "expected ok result, got error: Net: down");
    CHECK(msg("ok err instance") == "expected ok result, got error: bad");
    CHECK(msg("err") == "expected error result, got ok: 5");
    CHECK(msg("err msg") == "why: expected error result, got ok: {\\\"a\\\":1}");
    CHECK(msg("nan equal") == "<passed>");
    CHECK(msg("throws returns") == "<passed>");
    CHECK(msg("rejects returns") == "<passed>");
    CHECK(msg("assert error shape") == "<passed>");
    CHECK(num(last(), "p") == 4);
    CHECK(num(last(), "f") == 15);
}

TEST_CASE_FIXTURE(RunnerFixture, "thrown values are formatted for the failure message" *
                                     doctest::test_suite("test-runner")) {
    run("describe('throws', () => {\n"
        "  test('string', () => { throw 'boom' })\n"
        "  test('shape', () => { throw {name: 'Net', message: 'down'} })\n"
        "  test('message only', () => { throw {message: 'only'} })\n"
        "  test('name only', () => { throw {name: 'OnlyName'} })\n"
        "  test('number', () => { throw 42 })\n"
        "  test('error', () => { throw new TypeError('typed') })\n"
        "  test('rejected', () => Promise.reject(new Error('later')) )\n"
        "  test('async', async () => { await 0; throw new Error('after await') })\n"
        "})\n");
    auto msg = [&](const char* name) {
        std::string needle = std::string("\"t\":\"") + name + "\"";
        return str(find(needle.c_str()), "m");
    };
    CHECK(msg("string") == "boom");
    CHECK(msg("shape") == "Net: down");
    CHECK(msg("message only") == "only");
    CHECK(msg("name only") == "OnlyName");
    CHECK(msg("number") == "42");
    CHECK(msg("error") == "typed");
    CHECK(msg("rejected") == "later");
    CHECK(msg("async") == "after await");
    CHECK(num(last(), "f") == 8);
}

TEST_CASE_FIXTURE(RunnerFixture, "skip, todo and fixme at test level" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  test('run', () => {})\n"
        "  test.skip('skipped', () => { throw new Error('never') })\n"
        "  test.fixme('fixme', () => { throw new Error('never') })\n"
        "  test.todo('later')\n"
        "  test.skipIf(true)('skipIf true', () => { throw new Error('never') })\n"
        "  test.skipIf(0)('skipIf false', () => {})\n"
        "  test.runIf(false)('runIf false', () => { throw new Error('never') })\n"
        "  test.runIf('yes')('runIf true', () => {})\n"
        "})\n");
    CHECK(codes() == "8,1,8,2,4,4,9,4,8,2,4,8,2,5,6");
    CHECK(find("\"e\":9") == "{\"e\":9,\"s\":\"s\",\"t\":\"later\"}");
    CHECK(find("\"e\":4") == "{\"e\":4,\"s\":\"s\",\"t\":\"skipped\"}");
    CHECK(num(last(), "p") == 3);
    CHECK(num(last(), "k") == 4);
    CHECK(num(last(), "o") == 1);
}

TEST_CASE_FIXTURE(RunnerFixture, "skipped and todo suites" * doctest::test_suite("test-runner")) {
    run("describe.skip('sk', () => {\n"
        "  test('a', () => { throw new Error('never') })\n"
        "  test.todo('b')\n"
        "  beforeAll(() => { throw new Error('never') })\n"
        "})\n"
        "describe.todo('td', () => { test('c', () => { throw new Error('never') }) })\n"
        "describe.fixme('fx', () => { test('d', () => {}) })\n"
        "describe.skipIf(true)('si', () => { test('e', () => {}) })\n"
        "describe.skipIf(false)('sf', () => { test('f', () => {}) })\n"
        "describe.runIf(false)('rf', () => { test('g', () => {}) })\n"
        "describe.runIf(true)('rt', () => { test('h', () => {}) })\n");
    CHECK(codes() == "8,1,4,9,5,8,1,9,5,8,1,4,5,8,1,4,5,8,1,8,2,5,8,1,4,5,8,1,8,2,5,6");
    /* A suite that did not run has no retention figure. */
    CHECK(find("\"e\":5") == "{\"e\":5,\"s\":\"sk\"}");
    CHECK(str(find("\"e\":9"), "t") == "b");
    CHECK(num(last(), "p") == 2);
    CHECK(num(last(), "k") == 4);
    CHECK(num(last(), "o") == 2);
}

TEST_CASE_FIXTURE(RunnerFixture, "only filters across suites" *
                                     doctest::test_suite("test-runner")) {
    run("const log = []\n"
        "globalThis.__log = log\n"
        "describe('a', () => {\n"
        "  test('a1', () => { log.push('a1') })\n"
        "  test.only('a2', () => { log.push('a2') })\n"
        "  test.todo('a3')\n"
        "})\n"
        "describe('b', () => {\n"
        "  test('b1', () => { log.push('b1') })\n"
        "  test.todo('b2')\n"
        "  beforeAll(() => { log.push('b-before') })\n"
        "})\n"
        "describe.only('c', () => {\n"
        "  test('c1', () => { log.push('c1') })\n"
        "  test('c2', () => { log.push('c2') })\n"
        "})\n"
        "describe.only('d', () => {\n"
        "  test('d1', () => { log.push('d1') })\n"
        "  test.only('d2', () => { log.push('d2') })\n"
        "})\n"
        "describe.only('e', () => {\n"
        "  test.skip('e1', () => { log.push('e1') })\n"
        "})\n"
        "globalThis.__after = () => JSON.stringify(log)\n");
    CHECK(codes() == "8,1,4,8,2,9,5,8,1,4,9,5,8,1,8,2,8,2,5,8,1,4,8,2,5,8,1,4,5,6");
    CHECK(global("__log") == "a2,c1,c2,d2");
    CHECK(num(last(), "p") == 4);
    CHECK(num(last(), "k") == 4);
    CHECK(num(last(), "o") == 2);
}

TEST_CASE_FIXTURE(RunnerFixture, "each interpolates names" * doctest::test_suite("test-runner")) {
    run("describe.each([1, 2])('suite %s #%#', (v, i) => {\n"
        "  test('idx', () => { assert.equal(v, i + 1) })\n"
        "})\n"
        "describe('t', () => {\n"
        "  test.each([{a: 1}, 'x', null])('case %s|%o|%#', (v, i) => {\n"
        "    if (i === 1) assert.equal(v, 'x')\n"
        "  })\n"
        "  test.skip.each([1])('skip %s', () => { throw new Error('never') })\n"
        "  test.fixme.each([1])('fixme %s', () => { throw new Error('never') })\n"
        "  test.each([[1, 2]])('arr %s %o', (v) => { assert.deepEqual(v, [1, 2]) })\n"
        "})\n"
        "describe.skip.each(['q'])('sk %s', () => { test('z', () => {}) })\n"
        "describe.todo.each(['q'])('td %s', () => { test('z', () => {}) })\n"
        "describe.fixme.each(['q'])('fx %s', () => { test('z', () => {}) })\n"
        "describe.only.each(['o'])('only %s', () => { test('y', () => {}) })\n");
    CHECK(find("\"s\":\"suite 1 #0\"") != "");
    CHECK(find("\"s\":\"suite 2 #1\"") != "");
    CHECK(str(find("\"t\":\"case [object Object]"), "t") == "case [object Object]|{\\\"a\\\":1}|0");
    CHECK(find("\"t\":\"case x|%o|1\"") != "");
    CHECK(find("\"t\":\"case null|%o|2\"") != "");
    CHECK(find("\"t\":\"skip 1\"") != "");
    CHECK(find("\"t\":\"fixme 1\"") != "");
    CHECK(find("\"t\":\"arr 1,2 [1,2]\"") != "");
    CHECK(find("\"s\":\"sk q\"") != "");
    CHECK(find("\"s\":\"td q\"") != "");
    CHECK(find("\"s\":\"fx q\"") != "");
    CHECK(find("\"s\":\"only o\"") != "");
    /* The .only suite wins: everything else is skipped. */
    CHECK(num(last(), "p") == 1);
    CHECK(num(last(), "f") == 0);
    CHECK(num(last(), "o") == 1);
    CHECK(num(last(), "k") == 10);
}

TEST_CASE_FIXTURE(RunnerFixture, "hooks run in order and their failures are contained" *
                                     doctest::test_suite("test-runner")) {
    run("const log = []\n"
        "globalThis.__log = log\n"
        "describe('h', () => {\n"
        "  beforeAll(async () => { await 0; log.push('beforeAll') })\n"
        "  afterAll(() => { log.push('afterAll'); throw new Error('ignored') })\n"
        "  beforeEach(() => log.push('be1'))\n"
        "  beforeEach(async () => { await 0; log.push('be2') })\n"
        "  afterEach(() => { log.push('ae1'); throw new Error('ignored') })\n"
        "  afterEach(() => log.push('ae2'))\n"
        "  test('one', () => log.push('one'))\n"
        "  test('two', async () => { await 0; log.push('two') })\n"
        "})\n"
        "describe('be-throws', () => {\n"
        "  beforeEach(() => { throw new Error('hook broke') })\n"
        "  afterEach(() => log.push('ae-after-fail'))\n"
        "  test('never runs', () => log.push('unreachable'))\n"
        "})\n"
        "describe('after', () => { test('x', () => log.push('x')) })\n");
    CHECK(global("__log") ==
          "beforeAll,be1,be2,one,ae1,ae2,be1,be2,two,ae1,ae2,afterAll,ae-after-fail,x");
    CHECK(str(find("\"t\":\"never runs\""), "m") == "hook broke");
    CHECK(num(last(), "p") == 3);
    CHECK(num(last(), "f") == 1);
}

TEST_CASE_FIXTURE(RunnerFixture, "a failing beforeAll fails the suite's tests" *
                                     doctest::test_suite("test-runner")) {
    run("const log = []\n"
        "globalThis.__log = log\n"
        "describe('broken', () => {\n"
        "  beforeAll(async () => { throw new Error('no wifi') })\n"
        "  afterAll(() => log.push('afterAll'))\n"
        "  test('a', () => log.push('a'))\n"
        "  test.todo('b')\n"
        "  test.skip('c', () => log.push('c'))\n"
        "})\n"
        "describe('next', () => { test('d', () => log.push('d')) })\n");
    CHECK(codes() == "8,1,7,3,9,3,5,8,1,8,2,5,6");
    CHECK(find("\"e\":7") == "{\"e\":7,\"s\":\"broken\",\"m\":\"no wifi\"}");
    CHECK(find("\"e\":3") == "{\"e\":3,\"s\":\"broken\",\"t\":\"a\",\"d\":0,\"m\":\"beforeAll failed\"}");
    /* Skipped tests fail too: nothing ran, so nothing was deliberately gated. */
    CHECK(find("\"t\":\"c\"") == "{\"e\":3,\"s\":\"broken\",\"t\":\"c\",\"d\":0,\"m\":\"beforeAll failed\"}");
    CHECK(events[6] == "{\"e\":5,\"s\":\"broken\"}");
    CHECK(global("__log") == "d");
    CHECK(num(last(), "f") == 2);
    CHECK(num(last(), "o") == 1);
    CHECK(num(last(), "p") == 1);
}

TEST_CASE_FIXTURE(RunnerFixture, "a test that never settles times out" *
                                     doctest::test_suite("test-runner")) {
    run("const log = []\n"
        "globalThis.__log = log\n"
        "describe('slow', () => {\n"
        "  afterEach(() => log.push('ae'))\n"
        "  test('hangs', () => new Promise(() => {}), {timeout: 30})\n"
        "  test('after', () => log.push('after'))\n"
        "  test('waits', async () => { await new Promise((r) => setTimeout(r, 5)) })\n"
        "  test('hook hangs', () => {}, {timeout: 20})\n"
        "})\n");
    const std::string hang = find("\"t\":\"hangs\"");
    CHECK(code(hang) == 3);
    CHECK(str(hang, "m") == "timeout (30ms)");
    CHECK(num(hang, "d") >= 25);
    CHECK(global("__log") == "ae,after,ae,ae,ae");
    CHECK(num(find("\"t\":\"waits\""), "d") >= 4);
    CHECK(num(last(), "p") == 3);
    CHECK(num(last(), "f") == 1);
    /* The timeout timers were cleared: none survive the run. */
    CHECK(num(last(), "ta") == 0);
}

TEST_CASE_FIXTURE(RunnerFixture, "a hanging beforeEach counts against the test's timeout" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  beforeEach(() => new Promise(() => {}))\n"
        "  test('t', () => {}, {timeout: 20})\n"
        "})\n");
    CHECK(str(find("\"e\":3"), "m") == "timeout (20ms)");
}

TEST_CASE_FIXTURE(RunnerFixture, "registration outside describe throws" *
                                     doctest::test_suite("test-runner")) {
    CHECK_FALSE(eval("test('x', () => {})\n"));
    CHECK(eval_error == "Error: test() must be inside describe()");
}

TEST_CASE_FIXTURE(RunnerFixture, "registration errors name the variant" *
                                     doctest::test_suite("test-runner")) {
    run("const msgs = []\n"
        "for (const [name, fn] of [\n"
        "  ['test.skip', () => test.skip('x', () => {})],\n"
        "  ['test.only', () => test.only('x', () => {})],\n"
        "  ['test.fixme', () => test.fixme('x', () => {})],\n"
        "  ['test.todo', () => test.todo('x')],\n"
        "  ['test.each', () => test.each([1])('x', () => {})],\n"
        "  ['beforeAll', () => beforeAll(() => {})],\n"
        "  ['afterAll', () => afterAll(() => {})],\n"
        "  ['beforeEach', () => beforeEach(() => {})],\n"
        "  ['afterEach', () => afterEach(() => {})],\n"
        "]) {\n"
        "  try { fn(); msgs.push(name + ':none') } catch (e) { msgs.push(e.message) }\n"
        "}\n"
        "globalThis.__msgs = msgs.join('|')\n");
    CHECK(global("__msgs") ==
          "test.skip() must be inside describe()|test.only() must be inside describe()|"
          "test.fixme() must be inside describe()|test.todo() must be inside describe()|"
          "test() must be inside describe()|beforeAll() must be inside describe()|"
          "afterAll() must be inside describe()|beforeEach() must be inside describe()|"
          "afterEach() must be inside describe()");
}

TEST_CASE_FIXTURE(RunnerFixture, "nested describe registers a sibling suite" *
                                     doctest::test_suite("test-runner")) {
    run("describe('outer', () => {\n"
        "  test('o1', () => {})\n"
        "  describe('inner', () => { test('i1', () => {}) })\n"
        "  test('o2', () => {})\n"
        "})\n");
    CHECK(events[1] == "{\"e\":1,\"s\":\"outer\",\"n\":2}");
    CHECK(str(find("\"t\":\"o2\""), "s") == "outer");
    CHECK(find("\"e\":1,\"s\":\"inner\"") == "{\"e\":1,\"s\":\"inner\",\"n\":1}");
    CHECK(num(last(), "p") == 3);
}

TEST_CASE_FIXTURE(RunnerFixture, "the same fn and options object can back several tests" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  const fn = () => {}\n"
        "  const opts = {timeout: 500}\n"
        "  test('a', fn, opts); test('b', fn, opts); test('c', fn)\n"
        "})\n");
    CHECK(num(last(), "p") == 3);
}

TEST_CASE_FIXTURE(RunnerFixture, "run_done reports leaked timers and retained heap" *
                                     doctest::test_suite("test-runner")) {
    run("import 'mikro/http/request'\n"
        "describe('leaky', () => {\n"
        "  test('interval', () => { setInterval(() => {}, 100000) })\n"
        "  test('retain', () => { globalThis.__keep = new Uint8Array(20000) })\n"
        "  test('pending', () => { globalThis.__pending = 2 })\n"
        "})\n"
        "describe('clean', () => { test('t', () => {}) })\n");
    CHECK(num(last(), "tb") == 0);
    CHECK(num(last(), "ta") == 1);
    CHECK(num(last(), "pb") == 0);
    CHECK(num(last(), "pa") == 2);
    CHECK(num(last(), "hr") >= 15000);
    const std::string leaky = find("\"e\":5,\"s\":\"leaky\"");
    CHECK(num(leaky, "hr") >= 15000);
    const std::string clean = find("\"e\":5,\"s\":\"clean\"");
    CHECK(num(clean, "hr") < 2000);
}

TEST_CASE_FIXTURE(RunnerFixture, "beforeAll allocations are excluded from suite retention" *
                                     doctest::test_suite("test-runner")) {
    run("describe('warm', () => {\n"
        "  beforeAll(async () => { globalThis.__warm = new Uint8Array(30000) })\n"
        "  test('t', () => {})\n"
        "})\n");
    const std::string end = find("\"e\":5");
    CHECK(num(end, "hr") < 8000);
    /* The run total measures the file against its own start, so the
     * warmup counts there (it is memory the file needed). */
    CHECK(num(last(), "hr") < 8000);
    CHECK(num(last(), "ha") - num(last(), "hb") >= 25000);
}

TEST_CASE_FIXTURE(RunnerFixture, "run_done fires __testFileDone" *
                                     doctest::test_suite("test-runner")) {
    run("globalThis.__testFileDone = () => { globalThis.__done = 'yes' }\n"
        "describe('s', () => { test('t', () => {}) })\n");
    CHECK(global("__done") == "yes");
}

TEST_CASE_FIXTURE(RunnerFixture, "exports have the documented shape" *
                                     doctest::test_suite("test-runner")) {
    run("const shape = [\n"
        "  typeof describe, typeof describe.skip, typeof describe.only, typeof describe.todo,\n"
        "  typeof describe.fixme, typeof describe.skipIf, typeof describe.runIf,\n"
        "  typeof describe.each, typeof describe.skip.each, typeof describe.only.each,\n"
        "  typeof describe.todo.each, typeof describe.fixme.each,\n"
        "  typeof test, typeof test.skip, typeof test.only, typeof test.fixme,\n"
        "  typeof test.skipIf, typeof test.runIf, typeof test.todo, typeof test.each,\n"
        "  typeof test.skip.each, typeof test.only.each, typeof test.fixme.each,\n"
        "  describe.skipIf(true) === describe.skip, describe.skipIf(false) === describe,\n"
        "  describe.runIf(true) === describe, describe.runIf(false) === describe.skip,\n"
        "  test.skipIf(true) === test.skip, test.skipIf(false) === test,\n"
        "  test.runIf(true) === test, test.runIf(false) === test.skip,\n"
        "  Object.keys(assert).sort().join(','),\n"
        "]\n"
        "globalThis.__shape = shape.join('|')\n"
        "describe('s', () => { test('t', () => {}) })\n");
    CHECK(global("__shape") ==
          "function|function|function|function|function|function|function|function|function|"
          "function|function|function|function|function|function|function|function|function|"
          "function|function|function|function|function|true|true|true|true|true|true|true|true|"
          "deepEqual,equal,err,instance,notEqual,ok,rejects,throws,truthy,type");
}

/* Registration while the run is in progress appends suites that then run;
 * the runner must not hold references into the suite list across the
 * calls that can do this. */
TEST_CASE_FIXTURE(RunnerFixture, "suites registered during the run are appended and run" *
                                     doctest::test_suite("test-runner")) {
    run("describe('a', () => {\n"
        "  beforeEach(() => { describe('from-beforeEach', () => { test('be', () => {}) }) })\n"
        "  afterAll(() => {\n"
        "    for (let i = 0; i < 64; i++) describe('from-afterAll' + i, () => { test('aa', () => {}) })\n"
        "  })\n"
        "  test('t', () => { describe('from-test', () => { test('tt', () => {}) }) })\n"
        "})\n");
    CHECK(str(find("\"t\":\"t\""), "s") == "a");
    CHECK(find("\"e\":1,\"s\":\"from-beforeEach\"") != "");
    CHECK(find("\"e\":1,\"s\":\"from-test\"") != "");
    CHECK(find("\"e\":1,\"s\":\"from-afterAll63\"") != "");
    CHECK(num(last(), "p") == 67);
    CHECK(num(last(), "f") == 0);
}

TEST_CASE_FIXTURE(RunnerFixture, "a beforeAll rejection whose getter registers suites" *
                                     doctest::test_suite("test-runner")) {
    run("describe('boom', () => {\n"
        "  beforeAll(() => { throw {name: 'Boom', get message() {\n"
        "    for (let i = 0; i < 64; i++) describe('late' + i, () => { test('x', () => {}) })\n"
        "    return 'exploded'\n"
        "  }} })\n"
        "  test('a', () => {}); test('b', () => {}); test('c', () => {})\n"
        "})\n");
    CHECK(find("\"e\":7") == "{\"e\":7,\"s\":\"boom\",\"m\":\"Boom: exploded\"}");
    CHECK(find("\"t\":\"c\"") == "{\"e\":3,\"s\":\"boom\",\"t\":\"c\",\"d\":0,\"m\":\"beforeAll failed\"}");
    CHECK(find("\"e\":5") == "{\"e\":5,\"s\":\"boom\"}");
    CHECK(num(last(), "f") == 3);
    CHECK(num(last(), "p") == 64);
}

TEST_CASE_FIXTURE(RunnerFixture, "a thrown value whose name getter throws" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  test('t', () => { throw {get name() { throw new Error('POISON') }, message: 'real'} })\n"
        "  test('u', () => {})\n"
        "})\n");
    CHECK(str(find("\"e\":3"), "m") == "real");
    CHECK(num(last(), "f") == 1);
    CHECK(num(last(), "p") == 1);
    CHECK_FALSE(JS_HasException(ctx));
}

TEST_CASE_FIXTURE(RunnerFixture, "zero and negative timeouts fail at once" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  test('zero', () => new Promise(() => {}), {timeout: 0})\n"
        "  test('neg', () => new Promise(() => {}), {timeout: -1})\n"
        "})\n",
        500);
    CHECK(str(find("\"t\":\"zero\""), "m") == "timeout (0ms)");
    CHECK(str(find("\"t\":\"neg\""), "m") == "timeout (-1ms)");
    /* The file ends inside the last timeout's own callback. */
    CHECK(num(last(), "ta") == 0);
}

TEST_CASE_FIXTURE(RunnerFixture, "a test settling after its timeout is not reported twice" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => {\n"
        "  test('late', () => new Promise((r) => setTimeout(r, 60)), {timeout: 20})\n"
        "  test('after', async () => { await new Promise((r) => setTimeout(r, 80)) })\n"
        "})\n");
    CHECK(str(find("\"t\":\"late\""), "m") == "timeout (20ms)");
    CHECK(count(2) + count(3) == 2);
    CHECK(num(last(), "f") == 1);
    CHECK(num(last(), "p") == 1);
}

/* A file with nothing to run finishes inside the runner's own start-timer
 * callback, where that timer is still registered: it must not read as a
 * leak. */
TEST_CASE_FIXTURE(RunnerFixture, "an all-skipped file reports no leaked timer" *
                                     doctest::test_suite("test-runner")) {
    run("describe.skipIf(true)('wifi', () => { test('connect', () => {}) })\n");
    CHECK(num(last(), "tb") == 0);
    CHECK(num(last(), "ta") == 0);
    CHECK(num(last(), "k") == 1);
}

TEST_CASE_FIXTURE(RunnerFixture, "each leaves %o alone for functions" *
                                     doctest::test_suite("test-runner")) {
    run("describe('s', () => { test.each([() => 1])('fn %o', () => {}) })\n");
    CHECK(find("\"t\":\"fn %o\"") != "");
}

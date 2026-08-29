#include <cstring>
#include <ctime>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Characterization tests for the mikro/http/request + mikro/http/helpers
 * builtins, pinned before porting them to C++. The real builtin bytecode runs
 * on top of a scripted fake transport registered as a virtual module for
 * native:mikro/http (the same mechanism the simulator uses). Each driver
 * stashes observations on globalThis; assertions read them back as JSON. */

namespace {

/* Scriptable fake of the native:mikro/http transport protocol. Reads the
 * per-test scenario from globalThis.__scenario at request() time and records
 * calls into globalThis.__calls. Mirrors the vitest fake in
 * runtime/http/__test__/native.test.ts. */
static const char* FAKE_HTTP = R"JS(
import {err, ok} from 'mikro/result'

globalThis.__calls = {cancels: [], requests: [], nexts: 0}

let nextId = 1
const queues = new Map()
const waiters = new Map()
const headersResolvers = new Map()

function deliver(id, m) {
  const w = waiters.get(id)
  if (w) {
    waiters.delete(id)
    w(m)
  } else {
    const q = queues.get(id) ?? []
    q.push(m)
    queues.set(id, q)
  }
}

export function request(url, opts) {
  const sc = globalThis.__scenario ?? {messages: [{kind: 'end'}]}
  globalThis.__calls.requests.push({
    url,
    method: opts && opts.method,
    headers: opts && opts.headers,
    bodyLen: opts && opts.body ? opts.body.length : -1,
  })
  if (sc.startError) return err(sc.startError)
  const id = nextId++
  queues.set(id, [])
  Promise.resolve().then(() => {
    for (const m of sc.messages ?? []) deliver(id, m)
  })
  let headers
  if (sc.headersError) {
    headers = Promise.resolve(err(sc.headersError))
  } else if (sc.headersPendingUntilCancel) {
    headers = new Promise((resolve) => headersResolvers.set(id, resolve))
  } else {
    headers = Promise.resolve(ok(sc.headers ?? {status: 200, headers: []}))
  }
  return {ok: true, id, headers}
}

export function nextMessage(id) {
  globalThis.__calls.nexts++
  const q = queues.get(id) ?? []
  const next = q.shift()
  if (next !== undefined) return Promise.resolve(next)
  return new Promise((resolve) => waiters.set(id, resolve))
}

export function cancel(id) {
  globalThis.__calls.cancels.push(id)
  const hr = headersResolvers.get(id)
  if (hr) {
    headersResolvers.delete(id)
    hr(err({name: 'Aborted', message: 'cancelled'}))
  }
  Promise.resolve().then(() => deliver(id, {kind: 'error', cancelled: true, message: 'cancelled'}))
}

export function pendingCount() {
  return globalThis.__pendingCountValue ?? 0
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

struct HttpFixture {
    MIKRuntime* rt;
    JSContext* ctx;
    int runs = 0;

    HttpFixture() {
        rt = MIK_NewRuntime();
        ctx = MIK_GetJSContext(rt);
        MIK_RegisterVirtualModule(rt, "native:mikro/http", FAKE_HTTP, strlen(FAKE_HTTP));
    }
    ~HttpFixture() { MIK_FreeRuntime(rt); }
    HttpFixture(const HttpFixture&) = delete;
    HttpFixture& operator=(const HttpFixture&) = delete;

    /* Wrap `body_src` in an async driver importing the http builtins; pump
     * until the driver sets __done. Returns false on eval error or timeout. */
    bool run(const char* body_src, int max_iter = 3000) {
        std::string code =
            "import {pendingCount, request} from 'mikro/http/request'\n"
            "import {BodyConsumedError, makeResponse, prepareBody, RequestError} "
            "from 'mikro/http/helpers'\n"
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
        snprintf(filename, sizeof(filename), "/test/http_driver_%d.js", runs++);
        JSValue rv = eval_module(ctx, code.c_str(), filename);
        bool ok = !JS_IsException(rv);
        JS_FreeValue(ctx, rv);
        if (!ok) return false;
        if (!pump_until(rt, max_iter, [&] { return read_global_int(ctx, "__done") == 1; })) {
            fprintf(stderr, "[HttpFixture] driver timed out\n");
            return false;
        }
        return true;
    }

    std::string result() { return read_global_json(ctx, "__r"); }
};

}  // namespace

/* ── Transport behavior (createRequestFromNative over the fake) ─────────── */

TEST_CASE("buffered single-chunk response resolves via text()" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {
          headers: {status: 200, headers: [['Content-Type', 'text/plain']]},
          messages: [{kind: 'chunk', data: new TextEncoder().encode('hello')}, {kind: 'end'}],
        }
        const result = await request('https://example.test/')
        if (!result.ok) return __fail('request failed')
        const text = await result.value.text()
        __finish({
          status: result.value.status,
          ok: result.value.ok,
          url: result.value.url,
          contentType: result.value.get('content-type'),
          textOk: text.ok,
          text: text.ok ? text.value : undefined,
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"status":200,"ok":true,"url":"https://example.test/",)"
             R"("contentType":"text/plain","textOk":true,"text":"hello"})");
}

TEST_CASE("multi-chunk body streams through the async iterable" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [
          {kind: 'chunk', data: new Uint8Array([1, 2])},
          {kind: 'chunk', data: new Uint8Array([3, 4])},
          {kind: 'chunk', data: new Uint8Array([5])},
          {kind: 'end'},
        ]}
        const result = await request('https://example.test/')
        if (!result.ok) return __fail('request failed')
        const collected = []
        let sawErr = false
        for await (const chunk of result.value.body) {
          if (chunk.ok) collected.push(...chunk.value)
          else sawErr = true
        }
        __finish({collected, sawErr})
    )JS"));
    CHECK_EQ(f.result(), R"({"collected":[1,2,3,4,5],"sawErr":false})");
}

TEST_CASE("break in for-await fires cancel and drains remaining chunks" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [
          {kind: 'chunk', data: new Uint8Array([1])},
          {kind: 'chunk', data: new Uint8Array([2])},
          {kind: 'end'},
        ]}
        const result = await request('https://example.test/')
        if (!result.ok) return __fail('request failed')
        let first = -1
        for await (const chunk of result.value.body) {
          if (chunk.ok) first = chunk.value[0]
          break
        }
        __finish({
          first,
          cancels: globalThis.__calls.cancels.length,
          nexts: globalThis.__calls.nexts,
        })
    )JS"));
    /* nexts = 1 (loop) + 2 (drain until non-chunk: chunk 2, end). */
    CHECK_EQ(f.result(), R"({"first":1,"cancels":1,"nexts":3})");
}

TEST_CASE("mid-stream transport error yields a Network err item" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [
          {kind: 'chunk', data: new Uint8Array([1, 2])},
          {kind: 'error', cancelled: false, message: 'connection reset by peer'},
        ]}
        const result = await request('https://example.test/')
        if (!result.ok) return __fail('request failed')
        const pulled = []
        let finalErr
        for await (const chunk of result.value.body) {
          if (chunk.ok) pulled.push(...chunk.value)
          else finalErr = chunk.error
        }
        __finish({pulled, finalErr})
    )JS"));
    CHECK_EQ(f.result(),
             R"({"pulled":[1,2],)"
             R"("finalErr":{"name":"Network","message":"connection reset by peer"}})");
}

TEST_CASE("start failure Result is returned verbatim" * doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [], startError: RequestError.TooManyPending()}
        const result = await request('https://example.test/')
        __finish({ok: result.ok, name: result.ok ? undefined : result.error.name})
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":false,"name":"TooManyPending"})");
}

TEST_CASE("error before headers surfaces at the request() level" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {
          messages: [],
          headersError: RequestError.Network('DNS resolution failed'),
        }
        const result = await request('https://example.test/')
        __finish({ok: result.ok, error: result.ok ? undefined : result.error})
    )JS"));
    CHECK_EQ(f.result(),
             R"({"ok":false,"error":{"name":"Network","message":"DNS resolution failed"}})");
}

TEST_CASE("pre-headers cancelled error maps to Aborted" * doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {
          messages: [],
          headersError: RequestError.Aborted('cancelled'),
        }
        const result = await request('https://example.test/')
        __finish({ok: result.ok, name: result.ok ? undefined : result.error.name})
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":false,"name":"Aborted"})");
}

TEST_CASE("pre-aborted signal short-circuits without calling the native module" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [{kind: 'end'}]}
        const controller = new AbortController()
        controller.abort()
        const result = await request('https://example.test/', {signal: controller.signal})
        __finish({
          ok: result.ok,
          name: result.ok ? undefined : result.error.name,
          requests: globalThis.__calls.requests.length,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":false,"name":"Aborted","requests":0})");
}

TEST_CASE("abort while awaiting headers cancels the request" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [], headersPendingUntilCancel: true}
        const controller = new AbortController()
        const promise = request('https://example.test/', {signal: controller.signal})
        await Promise.resolve()
        controller.abort()
        const result = await promise
        __finish({
          ok: result.ok,
          name: result.ok ? undefined : result.error.name,
          cancels: globalThis.__calls.cancels.length,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":false,"name":"Aborted","cancels":1})");
}

TEST_CASE("abort during body iteration yields an Aborted err item" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [{kind: 'chunk', data: new Uint8Array([1])}]}
        const controller = new AbortController()
        const result = await request('https://example.test/', {signal: controller.signal})
        if (!result.ok) return __fail('request failed')
        const pulled = []
        let finalErr
        const drained = (async () => {
          for await (const c of result.value.body) {
            if (c.ok) pulled.push(...c.value)
            else finalErr = c.error
          }
        })()
        await Promise.resolve()
        await Promise.resolve()
        controller.abort()
        await drained
        __finish({
          pulled,
          name: finalErr && finalErr.name,
          cancelled: globalThis.__calls.cancels.length > 0,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"pulled":[1],"name":"Aborted","cancelled":true})");
}

TEST_CASE("timeoutMs during body wait surfaces as Aborted, not Timeout" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: []}
        const result = await request('https://example.test/', {timeoutMs: 10})
        if (!result.ok) return __fail('request failed')
        let finalErr
        for await (const c of result.value.body) {
          if (!c.ok) finalErr = c.error
        }
        __finish({
          name: finalErr && finalErr.name,
          cancels: globalThis.__calls.cancels.length,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"name":"Aborted","cancels":1})");
}

TEST_CASE("timeoutMs before headers arrive cancels and returns Aborted" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [], headersPendingUntilCancel: true}
        const result = await request('https://example.test/', {timeoutMs: 10})
        __finish({
          ok: result.ok,
          name: result.ok ? undefined : result.error.name,
          cancels: globalThis.__calls.cancels.length,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"ok":false,"name":"Aborted","cancels":1})");
}

TEST_CASE("method is uppercased; body and headers reach the transport" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [{kind: 'end'}]}
        const result = await request('https://example.test/', {
          method: 'post',
          body: 'hi',
          headers: {'X-Device-Id': 'abc'},
        })
        if (!result.ok) return __fail('request failed')
        await result.value.close()
        const call = globalThis.__calls.requests[0]
        __finish({method: call.method, bodyLen: call.bodyLen, headers: call.headers})
    )JS"));
    CHECK_EQ(f.result(), R"({"method":"POST","bodyLen":2,"headers":[["X-Device-Id","abc"]]})");
}

TEST_CASE("aborting after completion does not call cancel" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [
          {kind: 'chunk', data: new TextEncoder().encode('x')},
          {kind: 'end'},
        ]}
        const controller = new AbortController()
        const result = await request('https://example.test/', {signal: controller.signal})
        if (!result.ok) return __fail('request failed')
        const text = await result.value.text()
        controller.abort()
        await Promise.resolve()
        __finish({textOk: text.ok, cancels: globalThis.__calls.cancels.length})
    )JS"));
    CHECK_EQ(f.result(), R"({"textOk":true,"cancels":0})");
}

TEST_CASE("close() cancels, drains, and marks the body consumed" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {messages: [
          {kind: 'chunk', data: new Uint8Array([1])},
          {kind: 'chunk', data: new Uint8Array([2])},
          {kind: 'end'},
        ]}
        const result = await request('https://example.test/')
        if (!result.ok) return __fail('request failed')
        await result.value.close()
        let thrown = ''
        try {
          await result.value.text()
        } catch (e) {
          thrown = e.name
        }
        __finish({cancels: globalThis.__calls.cancels.length, thrown})
    )JS"));
    CHECK_EQ(f.result(), R"({"cancels":1,"thrown":"BodyConsumed"})");
}

TEST_CASE("pendingCount forwards to the native module" * doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__pendingCountValue = 3
        __finish({pending: pendingCount()})
    )JS"));
    CHECK_EQ(f.result(), R"({"pending":3})");
}

/* ── mikro/http/helpers: prepareBody ────────────────────────────────────── */

TEST_CASE("prepareBody normalizes headers and encodes bodies" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const empty = prepareBody({})
        const pairs = prepareBody({headers: [['X-A', '1'], ['X-A', '2']]})
        const record = prepareBody({headers: {'X-Device-Id': 'abc'}})
        const str = prepareBody({body: 'hei'})
        const raw = new Uint8Array([1, 2, 3, 4])
        const passthrough = prepareBody({body: raw})
        __finish({
          emptyBodyNull: empty.body === null,
          emptyHeaders: empty.headers,
          pairs: pairs.headers,
          record: record.headers,
          strBytes: Array.from(str.body),
          sameRef: passthrough.body === raw,
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"emptyBodyNull":true,"emptyHeaders":[],)"
             R"("pairs":[["X-A","1"],["X-A","2"]],"record":[["X-Device-Id","abc"]],)"
             R"("strBytes":[104,101,105],"sameRef":true})");
}

/* ── mikro/http/helpers: makeResponse ───────────────────────────────────── */

TEST_CASE("makeResponse computes ok and exposes status fields" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const bodyOf = (bytes) => ({
          async *[Symbol.asyncIterator]() {
            if (bytes.length > 0) yield {ok: true, value: bytes}
          },
        })
        const ok200 = makeResponse({
          status: 200, statusText: 'OK', url: 'https://example.test/final',
          redirected: true, headers: [], body: bodyOf(new Uint8Array(0)),
        })
        const err503 = makeResponse({
          status: 503, statusText: '', url: '', redirected: false,
          headers: [], body: bodyOf(new Uint8Array(0)),
        })
        __finish({
          ok200: ok200.ok,
          statusText: ok200.statusText,
          url: ok200.url,
          redirected: ok200.redirected,
          ok503: err503.ok,
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"ok200":true,"statusText":"OK","url":"https://example.test/final",)"
             R"("redirected":true,"ok503":false})");
}

TEST_CASE("get() and getAll() match headers case-insensitively" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const body = {async *[Symbol.asyncIterator]() {}}
        const r = makeResponse({
          status: 200, statusText: '', url: '', redirected: false,
          headers: [
            ['Content-Type', 'text/plain'],
            ['X-Trace', 'first'],
            ['x-trace', 'second'],
            ['Set-Cookie', 'a=1'],
            ['set-cookie', 'b=2, c=3'],
          ],
          body,
        })
        __finish({
          lower: r.get('content-type'),
          upper: r.get('CONTENT-TYPE'),
          firstMatch: r.get('x-trace'),
          missing: String(r.get('x-missing')),
          all: r.getAll('set-cookie'),
          none: r.getAll('x-missing'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"lower":"text/plain","upper":"text/plain","firstMatch":"first",)"
             R"("missing":"undefined","all":["a=1","b=2, c=3"],"none":[]})");
}

TEST_CASE("bytes() drains a multi-chunk body into a single Uint8Array" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])]
        const body = {
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield {ok: true, value: c}
          },
        }
        const r = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [], body,
        })
        const merged = await r.bytes()
        if (!merged.ok) return __fail('bytes failed')
        __finish({bytes: Array.from(merged.value)})
    )JS"));
    CHECK_EQ(f.result(), R"({"bytes":[1,2,3,4,5]})");
}

TEST_CASE("text() decodes multi-chunk UTF-8 with split codepoints" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const body = {
          async *[Symbol.asyncIterator]() {
            yield {ok: true, value: new Uint8Array([0x68, 0xc3])}
            yield {ok: true, value: new Uint8Array([0xa9, 0x6c, 0x6c, 0x6f])}
          },
        }
        const r = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [], body,
        })
        const text = await r.text()
        if (!text.ok) return __fail('text failed')
        __finish({text: text.value})
    )JS"));
    CHECK_EQ(f.result(), "{\"text\":\"h\xc3\xa9llo\"}");
}

TEST_CASE("body iteration yields each chunk exactly once" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const body = {
          async *[Symbol.asyncIterator]() {
            yield {ok: true, value: new Uint8Array([1])}
            yield {ok: true, value: new Uint8Array([2, 3])}
          },
        }
        const r = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [], body,
        })
        const collected = []
        for await (const chunk of r.body) {
          if (chunk.ok) collected.push(...chunk.value)
        }
        __finish({collected})
    )JS"));
    CHECK_EQ(f.result(), R"({"collected":[1,2,3]})");
}

TEST_CASE("json() parses valid JSON and maps parse failures to InvalidJson" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const bodyOf = (text) => ({
          async *[Symbol.asyncIterator]() {
            yield {ok: true, value: new TextEncoder().encode(text)}
          },
        })
        const good = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [],
          body: bodyOf('{"a":1}'),
        })
        const bad = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [],
          body: bodyOf('{not json'),
        })
        const goodResult = await good.json()
        const badResult = await bad.json()
        __finish({
          goodOk: goodResult.ok,
          value: goodResult.ok ? goodResult.value : undefined,
          badOk: badResult.ok,
          badName: badResult.ok ? undefined : badResult.error.name,
        })
    )JS"));
    CHECK_EQ(f.result(), R"({"goodOk":true,"value":{"a":1},"badOk":false,)"
                         R"("badName":"InvalidJson"})");
}

TEST_CASE("second body consumer throws BodyConsumed in every combination" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const bodyOf = () => ({
          async *[Symbol.asyncIterator]() {
            yield {ok: true, value: new TextEncoder().encode('hello')}
          },
        })
        const make = () => makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [],
          body: bodyOf(),
        })
        const outcomes = {}

        const textTwice = make()
        await textTwice.text()
        try { await textTwice.text(); outcomes.textTwice = 'no-throw' }
        catch (e) { outcomes.textTwice = e instanceof BodyConsumedError ? e.name : 'wrong-type' }

        const textAfterBytes = make()
        await textAfterBytes.bytes()
        try { await textAfterBytes.text(); outcomes.textAfterBytes = 'no-throw' }
        catch (e) {
          outcomes.textAfterBytes = e instanceof BodyConsumedError ? e.name : 'wrong-type'
        }

        const iterateAfterText = make()
        await iterateAfterText.text()
        try {
          iterateAfterText.body[Symbol.asyncIterator]()
          outcomes.iterateAfterText = 'no-throw'
        } catch (e) {
          outcomes.iterateAfterText = e instanceof BodyConsumedError ? e.name : 'wrong-type'
        }

        const iterateTwice = make()
        for await (const _ of iterateTwice.body) { /* drain */ }
        try {
          iterateTwice.body[Symbol.asyncIterator]()
          outcomes.iterateTwice = 'no-throw'
        } catch (e) {
          outcomes.iterateTwice = e instanceof BodyConsumedError ? e.name : 'wrong-type'
        }

        __finish(outcomes)
    )JS"));
    CHECK_EQ(f.result(),
             R"({"textTwice":"BodyConsumed","textAfterBytes":"BodyConsumed",)"
             R"("iterateAfterText":"BodyConsumed","iterateTwice":"BodyConsumed"})");
}

TEST_CASE("makeResponse close() invokes the underlying iterator return()" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        let returned = 0
        const body = {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({done: true, value: undefined}),
              return: async () => { returned++; return {done: true, value: undefined} },
            }
          },
        }
        const r = makeResponse({
          status: 200, statusText: '', url: '', redirected: false, headers: [], body,
        })
        await r.close()
        let thrown = ''
        try { await r.text() } catch (e) { thrown = e.name }
        __finish({returned, thrown})
    )JS"));
    CHECK_EQ(f.result(), R"({"returned":1,"thrown":"BodyConsumed"})");
}

/* ── mikro/http/helpers: error values ───────────────────────────────────── */

TEST_CASE("RequestError factories produce the tagged shapes" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        __finish({
          hardware: RequestError.Hardware('h'),
          network: RequestError.Network('n'),
          timeout: RequestError.Timeout('t'),
          bodyTooLarge: RequestError.BodyTooLarge(10, 4),
          invalidResponse: RequestError.InvalidResponse('i'),
          aborted: RequestError.Aborted('a'),
          tooManyPending: RequestError.TooManyPending(),
          invalidJson: RequestError.InvalidJson('j'),
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"hardware":{"name":"Hardware","message":"h"},)"
             R"("network":{"name":"Network","message":"n"},)"
             R"("timeout":{"name":"Timeout","message":"t"},)"
             R"("bodyTooLarge":{"name":"BodyTooLarge","size":10,"cap":4},)"
             R"("invalidResponse":{"name":"InvalidResponse","message":"i"},)"
             R"("aborted":{"name":"Aborted","message":"a"},)"
             R"("tooManyPending":{"name":"TooManyPending"},)"
             R"("invalidJson":{"name":"InvalidJson","message":"j"}})");
}

TEST_CASE("BodyConsumedError is an Error named BodyConsumed" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const e = new BodyConsumedError()
        __finish({
          isError: e instanceof Error,
          name: e.name,
          message: e.message,
        })
    )JS"));
    CHECK_EQ(f.result(),
             R"({"isError":true,"name":"BodyConsumed",)"
             R"("message":"response body already consumed"})");
}

/* The TS originals were async methods: a second consumer must produce a
 * REJECTED promise from text()/bytes()/json(), never a synchronous throw. */
TEST_CASE("consumed text() rejects asynchronously instead of throwing" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {
          headers: {status: 200, headers: []},
          messages: [{kind: 'chunk', data: new TextEncoder().encode('x')}, {kind: 'end'}],
        }
        const result = await request('https://example.test/')
        await result.value.text()
        let sync = false, isThenable = false, name = ''
        let p
        try { p = result.value.bytes() } catch (e) { sync = true }
        if (p) {
          isThenable = typeof p.then === 'function'
          try { await p } catch (e) { name = e.name }
        }
        __finish({sync, isThenable, name})
    )JS"));
    CHECK_EQ(f.result(), R"({"sync":false,"isThenable":true,"name":"BodyConsumed"})");
}

TEST_CASE("text() on a body without asyncIterator rejects asynchronously" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const res = makeResponse({status: 200, statusText: '', url: 'u', redirected: false,
                                  headers: [], body: {}})
        let sync = false, isThenable = false, rejected = false
        let p
        try { p = res.text() } catch (e) { sync = true }
        if (p) {
          isThenable = typeof p.then === 'function'
          try { await p } catch (e) { rejected = true }
        }
        __finish({sync, isThenable, rejected})
    )JS"));
    CHECK_EQ(f.result(), R"({"sync":false,"isThenable":true,"rejected":true})");
}

/* AsyncIteratorClose parity: stopping the drain on an err item must call the
 * underlying iterator's return() so a foreign transport can free its slot. */
TEST_CASE("drain calls iterator return() when stopping on an err item" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        const {ok, err} = await import('mikro/result')
        let returned = 0
        const body = {
          [Symbol.asyncIterator]() {
            let i = 0
            return {
              async next() {
                i++
                if (i === 1) return {done: false, value: ok(new Uint8Array([1]))}
                return {done: false, value: err(RequestError.Network('boom'))}
              },
              async return() { returned++; return {done: true, value: undefined} },
            }
          },
        }
        const res = makeResponse({status: 200, statusText: '', url: 'u', redirected: false,
                                  headers: [], body})
        const t = await res.text()
        __finish({returned, tOk: t.ok, name: t.ok ? '' : t.error.name})
    )JS"));
    CHECK_EQ(f.result(), R"({"returned":1,"tOk":false,"name":"Network"})");
}

TEST_CASE("malformed header tuple rejects the request without a stale exception" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        let rejected = false
        try {
          await request('https://example.test/', {headers: [null]})
        } catch (e) {
          rejected = true
        }
        globalThis.__scenario = {headers: {status: 200, headers: []}, messages: [{kind: 'end'}]}
        const r2 = await request('https://example.test/')
        __finish({rejected, ok2: r2.ok})
    )JS"));
    CHECK_EQ(f.result(), R"({"rejected":true,"ok2":true})");
}

TEST_CASE("a throwing signal getter rejects the request without a stale exception" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {headers: {status: 200, headers: []}, messages: [{kind: 'end'}]}
        let msg = ''
        /* No try around the call itself: a synchronous throw must fail the test. */
        const p = request('https://example.test/', {get signal() { throw new TypeError('sig boom') }})
        try { await p } catch (e) { msg = e.message }
        const r2 = await request('https://example.test/')
        __finish({msg, requests: globalThis.__calls.requests.length, ok2: r2.ok})
    )JS"));
    /* The transport is never touched for the failing call: one request total
     * from the follow-up, which succeeds because no exception stayed armed. */
    CHECK_EQ(f.result(), R"({"msg":"sig boom","requests":1,"ok2":true})");
}

TEST_CASE("a throwing timeoutMs getter rejects instead of instantly aborting" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    REQUIRE(f.run(R"JS(
        globalThis.__scenario = {headers: {status: 200, headers: []}, messages: [{kind: 'end'}]}
        let msg = ''
        const p = request('https://example.test/', {get timeoutMs() { throw new TypeError('tmo boom') }})
        try { await p } catch (e) { msg = e.message }
        globalThis.__scenario = {headers: {status: 200, headers: []}, messages: [{kind: 'end'}]}
        const r2 = await request('https://example.test/')
        __finish({msg, cancels: globalThis.__calls.cancels.length, ok2: r2.ok})
    )JS"));
    /* A rejection, not an err(Aborted) from a zero-delay cancel timer (msg
     * would be '' and cancels 1 if timeoutMs were misread as 0). TS parity:
     * the started transport request is left uncancelled. */
    CHECK_EQ(f.result(), R"({"msg":"tmo boom","cancels":0,"ok2":true})");
}

/* Lazy C-module registration restores MIK_RegisterVirtualModule precedence
 * for the ported names. */
TEST_CASE("a virtual module can override mikro/http/request" *
          doctest::test_suite("http_client")) {
    HttpFixture f;
    static const char* OVERRIDE =
        "export const request = 'virtual'\n"
        "export const pendingCount = 0\n";
    MIK_RegisterVirtualModule(f.rt, "mikro/http/request", OVERRIDE, strlen(OVERRIDE));
    JSValue rv = eval_module(f.ctx,
                             "import {request} from 'mikro/http/request'\n"
                             "globalThis.__r = request\n",
                             "/test/http_virtual_override.js");
    REQUIRE(!JS_IsException(rv));
    JS_FreeValue(f.ctx, rv);
    pump_until(f.rt, 100, [&] { return f.result() != "<unset>"; });
    CHECK_EQ(f.result(), R"("virtual")");
}

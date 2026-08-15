/* Host-side tests for the C++ Observable primitive (mik_observable.cpp).
 * See .claude/plans/observable.md (worktree branch) for the locked design.
 *
 * Tests cover:
 * - subscribe lifecycle (basic emit + complete, teardown order, closed flag)
 * - sync emission (subscribe-time emit, recursive next-in-next)
 * - throws caught at dispatch boundary, scheduled async via setTimeout(0)
 *   (cleanup runs anyway, sibling subscribers still receive the value)
 * - multicast (idempotent close, late-subscriber immediate complete,
 *   snapshot-on-dispatch survives unsubscribe-during-dispatch)
 * - Observable.from(iterable / promise / observable)
 * - pipe() composition
 * - silent unsubscribe vs natural complete (observer.complete only on natural)
 */

#include <cstring>
#include <ctime>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Clang spells ASan detection __has_feature; GCC defines __SANITIZE_ADDRESS__. */
#ifdef __has_feature
#define MIK_TEST_ASAN __has_feature(address_sanitizer)
#else
#define MIK_TEST_ASAN 0
#endif

namespace {

static JSValue eval_module(JSContext* ctx, const char* src) {
    std::string code = src;
    code += "\n//# sourceURL=/test/observable_driver.js\n";
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "/test/observable_driver.js",
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

static bool read_global_bool(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    bool b = JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return b;
}

}  // namespace

TEST_CASE("Observable module is importable" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "globalThis.__type = typeof Observable\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__type") == "function");

    MIK_FreeRuntime(rt);
}

TEST_CASE("Observable subscribe delivers next + complete" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let log = []\n"
        "new Observable(sub => {\n"
        "  sub.next(1); sub.next(2); sub.next(3); sub.complete()\n"
        "}).subscribe({\n"
        "  next: v => log.push(v),\n"
        "  complete: () => log.push('done')\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,2,3,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("subscribe accepts function shorthand" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let acc = 0\n"
                             "new Observable(sub => { sub.next(5); sub.next(7); sub.complete() })\n"
                             "  .subscribe(v => { acc += v })\n"
                             "globalThis.__acc = acc\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_int(ctx, "__acc") == 12);
    MIK_FreeRuntime(rt);
}

TEST_CASE("subscribe accepts undefined / no args" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* The callback should still run even with no observer — useful for
     * driving producer setup side effects. */
    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let ran = false\n"
                             "new Observable(sub => { ran = true; sub.complete() }).subscribe()\n"
                             "globalThis.__ran = ran\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_bool(ctx, "__ran"));
    MIK_FreeRuntime(rt);
}

TEST_CASE("next() after complete() is a no-op" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let count = 0\n"
        "new Observable(sub => {\n"
        "  sub.next(1); sub.complete(); sub.next(2); sub.next(3)\n"
        "}).subscribe(_ => { count++ })\n"
        "globalThis.__count = count\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_int(ctx, "__count") == 1);
    MIK_FreeRuntime(rt);
}

TEST_CASE("teardowns run in reverse insertion order on complete" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let trace = []\n"
                             "new Observable(sub => {\n"
                             "  sub.addTeardown(() => trace.push('a'))\n"
                             "  sub.addTeardown(() => trace.push('b'))\n"
                             "  sub.addTeardown(() => trace.push('c'))\n"
                             "  sub.complete()\n"
                             "}).subscribe()\n"
                             "globalThis.__trace = trace.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__trace") == "c,b,a");
    MIK_FreeRuntime(rt);
}

TEST_CASE("unsubscribe runs teardowns but NOT observer.complete" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let trace = []\n"
                             "const obs = new Observable(sub => {\n"
                             "  sub.addTeardown(() => trace.push('teardown'))\n"
                             "})\n"
                             "const s = obs.subscribe({\n"
                             "  next: () => {},\n"
                             "  complete: () => trace.push('observerComplete')\n"
                             "})\n"
                             "s.unsubscribe()\n"
                             "globalThis.__trace = trace.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__trace") == "teardown");
    MIK_FreeRuntime(rt);
}

TEST_CASE("unsubscribe is idempotent" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let count = 0\n"
                             "const s = new Observable(sub => {\n"
                             "  sub.addTeardown(() => { count++ })\n"
                             "}).subscribe()\n"
                             "s.unsubscribe(); s.unsubscribe(); s.unsubscribe()\n"
                             "globalThis.__count = count\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_int(ctx, "__count") == 1);
    MIK_FreeRuntime(rt);
}

TEST_CASE("a throwing observer stops the dispatch and panics" *
          doctest::test_suite("observable")) {
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let count = 0\n"
        "new Observable(sub => {\n"
        "  sub.next(1); sub.next(2); sub.next(3); sub.complete()\n"
        "}).subscribe(v => { count++; if (v === 1) throw new Error('boom') })\n"
        "globalThis.__count = count\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* An application crash is an application crash: the first value reaches
     * the handler, then nothing else is delivered. */
    CHECK(read_global_int(ctx, "__count") == 1);
    CHECK(error_count == 1);
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

TEST_CASE("a throwing teardown panics but the remaining teardowns still run" *
          doctest::test_suite("observable")) {
    /* Teardowns release resources for work that is already ending, so the
     * rest of the chain still runs even though the throw panics. */
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let trace = []\n"
        "new Observable(sub => {\n"
        "  sub.addTeardown(() => trace.push('a'))\n"
        "  sub.addTeardown(() => { throw new Error('mid') })\n"
        "  sub.addTeardown(() => trace.push('c'))\n"
        "  sub.complete()\n"
        "}).subscribe()\n"
        "globalThis.__trace = trace.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__trace") == "c,a");
    CHECK(error_count == 1);
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

TEST_CASE("producer setup throw bubbles to caller" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let caught = ''\n"
        "try {\n"
        "  new Observable(sub => { throw new Error('producer-fail') }).subscribe()\n"
        "} catch (err) { caught = err.message }\n"
        "globalThis.__caught = caught\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__caught") == "producer-fail");
    MIK_FreeRuntime(rt);
}

TEST_CASE("Observable.from(iterable) drains synchronously" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let log = []\n"
                             "Observable.from([10, 20, 30]).subscribe({\n"
                             "  next: v => log.push(v),\n"
                             "  complete: () => log.push('done')\n"
                             "})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "10,20,30,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("Observable.from(promise) emits then completes" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let log = []\n"
                             "Observable.from(Promise.resolve('hi')).subscribe({\n"
                             "  next: v => log.push(v),\n"
                             "  complete: () => log.push('done')\n"
                             "})\n"
                             "globalThis.__log = log\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Promise settles asynchronously; pump until log shows both entries. */
    bool ok = pump_until(rt, 100, [&]() {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue log = JS_GetPropertyStr(ctx, g, "__log");
        JSValue len = JS_GetPropertyStr(ctx, log, "length");
        int32_t n = 0;
        JS_ToInt32(ctx, &n, len);
        JS_FreeValue(ctx, len);
        JS_FreeValue(ctx, log);
        JS_FreeValue(ctx, g);
        return n >= 2;
    });
    CHECK(ok);

    JSValue serialize =
        eval_module(ctx, "globalThis.__joined = globalThis.__log.join(',')\n");
    JS_FreeValue(ctx, serialize);
    CHECK(read_global_string(ctx, "__joined") == "hi,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("Observable.from(observable) is passthrough" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const a = new Observable(sub => { sub.next(1); sub.complete() })\n"
        "const b = Observable.from(a)\n"
        "globalThis.__same = (a === b)\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_bool(ctx, "__same"));
    MIK_FreeRuntime(rt);
}

TEST_CASE("Observable.from rejects unsupported sources" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let caught = ''\n"
                             "try { Observable.from(42) } catch (e) { caught = e.message }\n"
                             "globalThis.__caught = caught\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Number (non-object) doesn't satisfy any from() branch — should throw. */
    CHECK(read_global_string(ctx, "__caught").find("Promise, Iterable, or Observable") !=
          std::string::npos);
    MIK_FreeRuntime(rt);
}

TEST_CASE("pipe() composes operator functions" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Trivial operators inline so this test depends only on pipe(), not on
     * the JS operator package. */
    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const inc = src => new Observable(sub => {\n"
        "  const u = src.subscribe({\n"
        "    next: v => sub.next(v + 1),\n"
        "    complete: () => sub.complete(),\n"
        "  })\n"
        "  sub.addTeardown(() => u.unsubscribe())\n"
        "})\n"
        "const dbl = src => new Observable(sub => {\n"
        "  const u = src.subscribe({\n"
        "    next: v => sub.next(v * 2),\n"
        "    complete: () => sub.complete(),\n"
        "  })\n"
        "  sub.addTeardown(() => u.unsubscribe())\n"
        "})\n"
        "let log = []\n"
        "Observable.from([1, 2, 3]).pipe(inc, dbl).subscribe(v => log.push(v))\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* (1+1)*2=4, (2+1)*2=6, (3+1)*2=8 */
    CHECK(read_global_string(ctx, "__log") == "4,6,8");
    MIK_FreeRuntime(rt);
}

TEST_CASE("pipe() with no operators returns the source" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let log = []\n"
                             "Observable.from([1, 2]).pipe().subscribe(v => log.push(v))\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,2");
    MIK_FreeRuntime(rt);
}

TEST_CASE("withEmitters: multicast to multiple subscribers" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "const {observable, next} = Observable.withEmitters()\n"
                             "let a = [], b = []\n"
                             "observable.subscribe(v => a.push(v))\n"
                             "observable.subscribe(v => b.push(v))\n"
                             "next(1); next(2); next(3)\n"
                             "globalThis.__a = a.join(',')\n"
                             "globalThis.__b = b.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__a") == "1,2,3");
    CHECK(read_global_string(ctx, "__b") == "1,2,3");
    MIK_FreeRuntime(rt);
}

TEST_CASE("withEmitters: late subscriber after complete gets immediate complete" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const {observable, next, complete} = Observable.withEmitters()\n"
        "next(1); complete()\n"
        "let log = []\n"
        "observable.subscribe({\n"
        "  next: v => log.push(v),\n"
        "  complete: () => log.push('done')\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* No 'next' values — late subscriber missed the live emission, but
     * received complete immediately. */
    CHECK(read_global_string(ctx, "__log") == "done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("withEmitters: complete() is idempotent" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "const {observable, next, complete} = Observable.withEmitters()\n"
                             "let count = 0\n"
                             "observable.subscribe({\n"
                             "  next: () => {}, complete: () => { count++ }\n"
                             "})\n"
                             "complete(); complete(); complete()\n"
                             "next('after-complete')\n"
                             "globalThis.__count = count\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_int(ctx, "__count") == 1);
    MIK_FreeRuntime(rt);
}

TEST_CASE("withEmitters: unsubscribe during dispatch doesn't break iteration" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Subscriber A unsubscribes itself and B during its first next() call.
     * Subscriber C (registered after) should still receive the value via
     * the dispatch snapshot. */
    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "const {observable, next} = Observable.withEmitters()\n"
                             "let aGot = [], bGot = [], cGot = []\n"
                             "let subA, subB, subC\n"
                             "subA = observable.subscribe(v => {\n"
                             "  aGot.push(v)\n"
                             "  subA.unsubscribe(); subB.unsubscribe()\n"
                             "})\n"
                             "subB = observable.subscribe(v => bGot.push(v))\n"
                             "subC = observable.subscribe(v => cGot.push(v))\n"
                             "next('x')\n"
                             "globalThis.__a = aGot.join(',')\n"
                             "globalThis.__b = bGot.join(',')\n"
                             "globalThis.__c = cGot.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__a") == "x");
    /* B was in the dispatch snapshot but became closed before its turn,
     * so the per-iteration `closed` check skips it. C still receives the
     * value because its closed flag is unchanged. */
    CHECK(read_global_string(ctx, "__b") == "");
    CHECK(read_global_string(ctx, "__c") == "x");
    MIK_FreeRuntime(rt);
}

/* ── Dispatch trampoline ─────────────────────────────────────────── */

TEST_CASE("re-entrant emission depth does not consume stack" *
          doctest::test_suite("observable")) {
    /* A subscriber that re-emits from its own next handler used to recurse
     * one native + one JS frame per value; on a small stack this blew up
     * after a few dozen values. The dispatch queue makes depth O(1). */
    MIKRunOptions options;
    MIK_DefaultOptions(&options);
#if defined(__SANITIZE_ADDRESS__) || MIK_TEST_ASAN
    /* ASan frames are severalfold bigger; scale the deliberately tight stack
     * so the constant-depth property stays provable under instrumentation
     * (a per-emission depth regression would still need ~30x more). */
    options.stack_size = 2 * 1024 * 1024;
#else
    options.stack_size = 64 * 1024;
#endif
    auto* rt = MIK_NewRuntimeOptions(&options);
    REQUIRE(rt != nullptr);
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "const {observable, next} = Observable.withEmitters()\n"
                             "let last = 0\n"
                             "observable.subscribe(v => { last = v; if (v < 2000) next(v + 1) })\n"
                             "next(1)\n"
                             "globalThis.__last = last\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_int(ctx, "__last") == 2000);
    MIK_FreeRuntime(rt);
}

TEST_CASE("deep operator chain delivers values in order" *
          doctest::test_suite("observable")) {
    /* 32 relay layers: per-value dispatch cost must not scale with chain
     * length (subscribe-time nesting still does — that's user recursion). */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const inc = src => new Observable(sub => {\n"
        "  const u = src.subscribe({\n"
        "    next: v => sub.next(v + 1),\n"
        "    complete: () => sub.complete(),\n"
        "  })\n"
        "  sub.addTeardown(() => u.unsubscribe())\n"
        "})\n"
        "const ops = []\n"
        "for (let i = 0; i < 32; i++) ops.push(inc)\n"
        "let log = []\n"
        "Observable.from([1, 2, 3]).pipe(...ops).subscribe({\n"
        "  next: v => log.push(v),\n"
        "  complete: () => log.push('done'),\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "33,34,35,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("handler code after sub.next() runs before downstream delivery" *
          doctest::test_suite("observable")) {
    /* Deliberate semantic pin for the dispatch queue: inside an operator
     * handler, sub.next(v) enqueues — the rest of the handler runs first,
     * then downstream receives the value. (Recursive dispatch delivered
     * downstream before the 'after' line.) Values still arrive in order. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let log = []\n"
        "const relay = src => new Observable(sub => {\n"
        "  const u = src.subscribe({\n"
        "    next: v => { log.push('before:' + v); sub.next(v); log.push('after:' + v) },\n"
        "    complete: () => sub.complete(),\n"
        "  })\n"
        "  sub.addTeardown(() => u.unsubscribe())\n"
        "})\n"
        "new Observable(s => { s.next(1); s.next(2); s.complete() })\n"
        "  .pipe(relay).subscribe(v => log.push('down:' + v))\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") ==
          "before:1,after:1,down:1,before:2,after:2,down:2");
    MIK_FreeRuntime(rt);
}

TEST_CASE("queued delivery is dropped when the subscriber unsubscribes first" *
          doctest::test_suite("observable")) {
    /* A re-entrant emission queues entries for every live subscriber. If one
     * unsubscribes before its entry drains, that entry must be dropped. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const {observable, next} = Observable.withEmitters()\n"
        "let aLog = [], bLog = []\n"
        "let subB\n"
        "observable.subscribe(v => {\n"
        "  if (v === 1) { next(2); subB.unsubscribe() }\n"
        "  aLog.push(v)\n"
        "})\n"
        "subB = observable.subscribe(v => bLog.push(v))\n"
        "next(1)\n"
        "globalThis.__a = aLog.join(',')\n"
        "globalThis.__b = bLog.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__a") == "1,2");
    /* B's queued entry for value 2 (and its later turn for value 1) were
     * both dropped by the closed check. */
    CHECK(read_global_string(ctx, "__b") == "");
    MIK_FreeRuntime(rt);
}

TEST_CASE("take-style completion mid-drain drops the remaining values" *
          doctest::test_suite("observable")) {
    /* sub.next() after sub.complete() is a no-op even when the complete is
     * still queued (complete_pending closes the subscriber at the call
     * site), so the trailing values never reach the observer. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const take2 = src => new Observable(sub => {\n"
        "  let remaining = 2\n"
        "  const u = src.subscribe({\n"
        "    next: v => {\n"
        "      remaining--\n"
        "      sub.next(v)\n"
        "      if (remaining === 0) sub.complete()\n"
        "    },\n"
        "    complete: () => sub.complete(),\n"
        "  })\n"
        "  sub.addTeardown(() => u.unsubscribe())\n"
        "})\n"
        "let log = []\n"
        "Observable.from([1, 2, 3, 4]).pipe(take2).subscribe({\n"
        "  next: v => log.push(v),\n"
        "  complete: () => log.push('done'),\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,2,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("producer that completes then throws still delivers the completion" *
          doctest::test_suite("observable")) {
    /* A producer-setup throw closes the subscriber so deferred dispatch is
     * dropped, but a completion queued before the throw owns the close: its
     * complete handler and teardowns are the resource-release path and must
     * still run. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let log = []\n"
        "new Observable(outer => { outer.next('go'); outer.complete() }).subscribe(() => {\n"
        "  try {\n"
        "    new Observable(sub => {\n"
        "      sub.addTeardown(() => log.push('td'))\n"
        "      sub.complete()\n"
        "      throw new Error('setup-fail')\n"
        "    }).subscribe({complete: () => log.push('c')})\n"
        "  } catch (e) { log.push('caught') }\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* The throw reaches the caller first (the queued completion drains after
     * the handler returns), then the completion and its teardown run. */
    CHECK(read_global_string(ctx, "__log") == "caught,c,td");
    MIK_FreeRuntime(rt);
}

TEST_CASE("subscribing to a sync source inside a handler defers its values" *
          doctest::test_suite("observable")) {
    /* Pins the consequence for whole subscriptions, not just individual
     * emits: a synchronous source subscribed from inside an active dispatch
     * delivers nothing before subscribe() returns. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let log = []\n"
        "new Observable(s => { s.next('go'); s.complete() }).subscribe(() => {\n"
        "  let got = 'none'\n"
        "  Observable.from([7]).subscribe(x => { got = x })\n"
        "  log.push('inline:' + got)\n"
        "  log.push('after:' + got)\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Both reads happen before the queued value drains. */
    CHECK(read_global_string(ctx, "__log") == "inline:none,after:none");
    MIK_FreeRuntime(rt);
}

TEST_CASE("a throw mid-drain abandons the queued deliveries" *
          doctest::test_suite("observable")) {
    /* The queue holds deliveries for subscribers that were live when the
     * value was emitted. Once one of them crashes the app, the rest are
     * dropped rather than delivered against broken state. */
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const {observable, next} = Observable.withEmitters()\n"
        "let cLog = []\n"
        "observable.subscribe(v => { if (v === 1) next(2) })\n"
        "observable.subscribe(v => { if (v === 2) throw new Error('boom') })\n"
        "observable.subscribe(v => cLog.push(v))\n"
        "next(1)\n"
        "globalThis.__c = cLog.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* The third subscriber never sees value 2 (the crash happened first) nor
     * value 1 (its queued turn was abandoned). */
    CHECK(read_global_string(ctx, "__c") == "");
    CHECK(error_count == 1);
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

TEST_CASE("producer setup throw runs the teardowns it already registered" *
          doctest::test_suite("observable")) {
    /* A producer that acquires something, registers its release, then fails
     * leaves that resource unreachable: no Subscription is returned, so
     * nothing can ever unsubscribe to clean it up. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let log = []\n"
                             "try {\n"
                             "  new Observable(subscriber => {\n"
                             "    subscriber.addTeardown(() => log.push('td1'))\n"
                             "    subscriber.addTeardown(() => log.push('td2'))\n"
                             "    throw new Error('setup-fail')\n"
                             "  }).subscribe()\n"
                             "} catch (err) { log.push('caught:' + err.message) }\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Reverse insertion order, then the setup error still reaches the caller. */
    CHECK(read_global_string(ctx, "__log") == "td2,td1,caught:setup-fail");
    MIK_FreeRuntime(rt);
}

TEST_CASE("a teardown that throws during setup cleanup does not lose the setup error" *
          doctest::test_suite("observable")) {
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let log = []\n"
                             "try {\n"
                             "  new Observable(subscriber => {\n"
                             "    subscriber.addTeardown(() => log.push('td'))\n"
                             "    subscriber.addTeardown(() => { throw new Error('cleanup') })\n"
                             "    throw new Error('setup-fail')\n"
                             "  }).subscribe()\n"
                             "} catch (err) { log.push('caught:' + err.message) }\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* The throwing teardown panics, the rest still run, and the caller still
     * sees the original setup failure rather than the cleanup one. */
    CHECK(read_global_string(ctx, "__log") == "td,caught:setup-fail");
    CHECK(error_count == 1);
    MIK_FreeRuntime(rt);
}

TEST_CASE("an uncaught setup throw drops the queued completion with the panic" *
          doctest::test_suite("observable")) {
    /* Same shape as the test above, but the caller does not catch, so the
     * setup error reaches the outer handler and panics. The queued
     * completion goes with it: no complete handler, no teardowns. That is
     * the intended trade, not an oversight. The teardown would release
     * something the restart releases anyway, and resurrecting queued
     * completions after a panic would undo the rule that nothing runs once
     * the app has crashed. The caught variant above is where teardowns
     * matter, because there the app keeps running. */
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "let log = []\n"
        "new Observable(outer => { outer.next(1); outer.complete() }).subscribe(() => {\n"
        "  new Observable(inner => {\n"
        "    inner.addTeardown(() => log.push('td'))\n"
        "    inner.complete()\n"
        "    throw new Error('setup-fail')\n"
        "  }).subscribe({complete: () => log.push('c')})\n"
        "})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "");
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

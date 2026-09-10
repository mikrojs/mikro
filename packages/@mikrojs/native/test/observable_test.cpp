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
 * - from(iterable / promise), of(...values)
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

TEST_CASE("a function returned from the subscribe callback is a teardown" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let trace = []\n"
                             "const s = new Observable(sub => {\n"
                             "  sub.addTeardown(() => trace.push('added'))\n"
                             "  return () => trace.push('returned')\n"
                             "}).subscribe()\n"
                             "globalThis.__before = trace.join(',')\n"
                             "s.unsubscribe()\n"
                             "globalThis.__after = trace.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__before") == "");
    /* Registered last, so it runs first. */
    CHECK(read_global_string(ctx, "__after") == "returned,added");
    MIK_FreeRuntime(rt);
}

TEST_CASE("a returned teardown runs at once when setup already completed" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "let trace = []\n"
                             "new Observable(sub => {\n"
                             "  sub.complete()\n"
                             "  return () => trace.push('returned')\n"
                             "}).subscribe()\n"
                             "globalThis.__trace = trace.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__trace") == "returned");
    MIK_FreeRuntime(rt);
}

TEST_CASE("from(iterable) drains synchronously" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable, from} from 'mikro/observable'\n"
                             "let log = []\n"
                             "from([10, 20, 30]).subscribe({\n"
                             "  next: v => log.push(v),\n"
                             "  complete: () => log.push('done')\n"
                             "})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "10,20,30,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("from(promise) emits then completes" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable, from} from 'mikro/observable'\n"
                             "let log = []\n"
                             "from(Promise.resolve('hi')).subscribe({\n"
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

TEST_CASE("of emits its arguments in order, then completes" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {of} from 'mikro/observable'\n"
                             "let log = []\n"
                             "of('a', 'b', 'c').subscribe({\n"
                             "  next: v => log.push(v),\n"
                             "  complete: () => log.push('done'),\n"
                             "})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "a,b,c,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("of emits an array argument as one value, unlike from" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {from, of} from 'mikro/observable'\n"
                             "let log = []\n"
                             "of([1, 2]).subscribe(v => log.push(Array.isArray(v) ? 'array' : v))\n"
                             "from([1, 2]).subscribe(v => log.push(v))\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "array,1,2");
    MIK_FreeRuntime(rt);
}

TEST_CASE("from rejects unsupported sources" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable, from} from 'mikro/observable'\n"
                             "let caught = ''\n"
                             "try { from(42) } catch (e) { caught = e.message }\n"
                             "globalThis.__caught = caught\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Number (non-object) doesn't satisfy any from() branch — should throw. */
    CHECK(read_global_string(ctx, "__caught").find("Promise or an Iterable") !=
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
        "import {Observable, from} from 'mikro/observable'\n"
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
        "from([1, 2, 3]).pipe(inc, dbl).subscribe(v => log.push(v))\n"
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
                             "import {Observable, from} from 'mikro/observable'\n"
                             "let log = []\n"
                             "from([1, 2]).pipe().subscribe(v => log.push(v))\n"
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
        "import {Observable, from} from 'mikro/observable'\n"
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
        "from([1, 2, 3]).pipe(...ops).subscribe({\n"
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
        "import {Observable, from} from 'mikro/observable'\n"
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
        "from([1, 2, 3, 4]).pipe(take2).subscribe({\n"
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
        "import {Observable, from} from 'mikro/observable'\n"
        "let log = []\n"
        "new Observable(s => { s.next('go'); s.complete() }).subscribe(() => {\n"
        "  let got = 'none'\n"
        "  from([7]).subscribe(x => { got = x })\n"
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

/* ── Native operators (mikro/observable/operators) ─────────────────── */

TEST_CASE("operators: map, filter and tap chain in order" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {from} from 'mikro/observable'\n"
                             "import {filter, map, tap} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "from([1, 2, 3, 4]).pipe(\n"
                             "  tap(v => log.push('t' + v)),\n"
                             "  filter(v => v % 2 === 0),\n"
                             "  map(v => v * 10),\n"
                             ").subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "t1,t2,20,t3,t4,40,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: take completes early and releases the upstream" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {take} from 'mikro/observable/operators'\n"
        "let log = []\n"
        "const source = new Observable(sub => {\n"
        "  sub.next(1); sub.next(2); sub.next(3)\n"
        "  return () => log.push('torn')\n"
        "})\n"
        "source.pipe(take(2)).subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* The third value is dropped: the chain closed before it was delivered. */
    CHECK(read_global_string(ctx, "__log") == "1,2,done,torn");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: take(0) completes without subscribing upstream" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "import {take} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "new Observable(sub => { log.push('setup'); sub.next(1) })\n"
                             "  .pipe(take(0)).subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: skip and scan" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {from} from 'mikro/observable'\n"
                             "import {scan, skip} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "from([1, 2, 3, 4]).pipe(skip(1), scan((acc, v) => acc + v, 10))\n"
                             "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "12,15,19,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: distinctUntilChanged with === and with a comparator" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {from} from 'mikro/observable'\n"
        "import {distinctUntilChanged} from 'mikro/observable/operators'\n"
        "let a = [], b = []\n"
        "from([1, 1, 2, 2, 1, NaN, NaN]).pipe(distinctUntilChanged()).subscribe(v => a.push(v))\n"
        "from([{id: 1}, {id: 1}, {id: 2}]).pipe(distinctUntilChanged((x, y) => x.id === y.id))\n"
        "  .subscribe(v => b.push(v.id))\n"
        "globalThis.__a = a.join(',')\n"
        "globalThis.__b = b.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* NaN !== NaN, so both pass, as with RxJS. */
    CHECK(read_global_string(ctx, "__a") == "1,2,1,NaN,NaN");
    CHECK(read_global_string(ctx, "__b") == "1,2");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: startWith emits first and skips the source once closed" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable, from} from 'mikro/observable'\n"
        "import {startWith, take} from 'mikro/observable/operators'\n"
        "let log = [], setups = 0\n"
        "from([2, 3]).pipe(startWith(1)).subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
        "new Observable(sub => { setups++; sub.next(9) }).pipe(startWith(0), take(1)).subscribe(v => log.push(v))\n"
        "globalThis.__log = log.join(',')\n"
        "globalThis.__setups = setups\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,2,3,done,0");
    CHECK(read_global_int(ctx, "__setups") == 0);
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: finalize runs after the upstream teardown, on complete and unsubscribe" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable, from} from 'mikro/observable'\n"
        "import {finalize} from 'mikro/observable/operators'\n"
        "let log = []\n"
        "from([1]).pipe(finalize(() => log.push('fin'))).subscribe({complete: () => log.push('done')})\n"
        "const sub = new Observable(sub => () => log.push('up')).pipe(finalize(() => log.push('fin2')))\n"
        "  .subscribe({complete: () => log.push('never')})\n"
        "sub.unsubscribe()\n"
        "sub.unsubscribe()\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "done,fin,up,fin2");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: takeUntil with a notifier" * doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {takeUntil} from 'mikro/observable/operators'\n"
        "const source = Observable.withEmitters()\n"
        "const stop = Observable.withEmitters()\n"
        "const quiet = Observable.withEmitters()\n"
        "let log = [], stopTorn = false\n"
        "const stopObs = new Observable(sub => {\n"
        "  const u = stop.observable.subscribe({next: v => sub.next(v)})\n"
        "  return () => { stopTorn = true; u.unsubscribe() }\n"
        "})\n"
        "source.observable.pipe(takeUntil(stopObs))\n"
        "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
        "source.observable.pipe(takeUntil(quiet.observable))\n"
        "  .subscribe({next: v => log.push('q' + v), complete: () => log.push('qdone')})\n"
        "source.next(1)\n"
        "quiet.complete()\n"
        "source.next(2)\n"
        "stop.next('x')\n"
        "source.next(3)\n"
        "globalThis.__log = log.join(',')\n"
        "globalThis.__stopTorn = stopTorn\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* A notifier that completes without emitting does not end the stream;
     * the notifier subscription is released with the chain. */
    CHECK(read_global_string(ctx, "__log") == "1,q1,2,q2,done,q3");
    CHECK(read_global_bool(ctx, "__stopTorn"));
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: takeUntil with a predicate, inclusive or not" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {from} from 'mikro/observable'\n"
        "import {takeUntil} from 'mikro/observable/operators'\n"
        "let a = [], b = []\n"
        "from([1, 2, 3, 4]).pipe(takeUntil(v => v === 3))\n"
        "  .subscribe({next: v => a.push(v), complete: () => a.push('done')})\n"
        "from([1, 2, 3, 4]).pipe(takeUntil(v => v === 3, {inclusive: false}))\n"
        "  .subscribe({next: v => b.push(v), complete: () => b.push('done')})\n"
        "globalThis.__a = a.join(',')\n"
        "globalThis.__b = b.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__a") == "1,2,3,done");
    CHECK(read_global_string(ctx, "__b") == "1,2,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: mergeWith interleaves and completes when all sources have" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "import {mergeWith} from 'mikro/observable/operators'\n"
                             "const a = Observable.withEmitters()\n"
                             "const b = Observable.withEmitters()\n"
                             "let log = []\n"
                             "a.observable.pipe(mergeWith(b.observable))\n"
                             "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "a.next(1); b.next(2); a.complete(); b.next(3); b.complete()\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,2,3,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: withLatestFrom pairs with the latest of the other source" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {withLatestFrom} from 'mikro/observable/operators'\n"
        "const src = Observable.withEmitters()\n"
        "const other = Observable.withEmitters()\n"
        "let log = []\n"
        "src.observable.pipe(withLatestFrom(other.observable))\n"
        "  .subscribe({next: ([a, b]) => log.push(a + b), complete: () => log.push('done')})\n"
        "src.next('a'); other.next(1); src.next('b'); other.next(2); other.complete(); src.next('c'); src.complete()\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* 'a' arrives before `other` has a value and is dropped; `other`
     * completing keeps its last value in play. */
    CHECK(read_global_string(ctx, "__log") == "b1,c2,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: combineLatest emits tuples once every source has a value" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable, from} from 'mikro/observable'\n"
        "import {combineLatest} from 'mikro/observable/operators'\n"
        "const a = Observable.withEmitters()\n"
        "const b = Observable.withEmitters()\n"
        "let log = [], early = [], empty = []\n"
        "combineLatest([a.observable, b.observable])\n"
        "  .subscribe({next: ([x, y]) => log.push(x + y), complete: () => log.push('done')})\n"
        "a.next(1); a.next(2); b.next(10); a.next(3); a.complete(); b.next(20); b.complete()\n"
        "combineLatest([from([1]), from([])])\n"
        "  .subscribe({next: v => early.push(v), complete: () => early.push('done')})\n"
        "combineLatest([])\n"
        "  .subscribe({next: v => empty.push(v.length), complete: () => empty.push('done')})\n"
        "globalThis.__log = log.join(',')\n"
        "globalThis.__early = early.join(',')\n"
        "globalThis.__empty = empty.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "12,13,23,done");
    /* A source that completes without a value ends the stream at once. */
    CHECK(read_global_string(ctx, "__early") == "done");
    CHECK(read_global_string(ctx, "__empty") == "0,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: pipe() composes and an empty pipe() is the identity" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {from} from 'mikro/observable'\n"
                             "import {filter, map, pipe} from 'mikro/observable/operators'\n"
                             "const evensTimesTen = pipe(filter(v => v % 2 === 0), map(v => v * 10))\n"
                             "let log = []\n"
                             "from([1, 2, 3, 4]).pipe(evensTimesTen).subscribe(v => log.push(v))\n"
                             "from([5]).pipe(pipe()).subscribe(v => log.push(v))\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "20,40,5");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: arguments are checked when the operator is built" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {from} from 'mikro/observable'\n"
        "import {combineLatest, map, mergeWith, pipe, take, takeUntil} from 'mikro/observable/operators'\n"
        "const errors = []\n"
        "const attempt = fn => { try { fn() } catch (e) { errors.push(e instanceof TypeError ? e.message : String(e)) } }\n"
        "attempt(() => map('nope'))\n"
        "attempt(() => take('3'))\n"
        "attempt(() => takeUntil(3))\n"
        "attempt(() => mergeWith(from([1]), 4))\n"
        "attempt(() => combineLatest([from([1]), 4]))\n"
        "attempt(() => pipe(map(v => v), 'nope'))\n"
        "attempt(() => map(v => v)({subscribe() {}}))\n"
        "globalThis.__errors = errors.join('|')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__errors") ==
          "map: argument must be a function|take: count must be a number|"
          "takeUntil: argument must be an Observable or a predicate|"
          "mergeWith: arguments must be Observables|"
          "combineLatest: argument must be an array of Observables|"
          "pipe: arguments must be operator functions|map: source must be an Observable");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: a throw inside a transform panics and stops delivery" *
          doctest::test_suite("observable")) {
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(ctx,
                             "import {from} from 'mikro/observable'\n"
                             "import {map} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "from([1, 2, 3]).pipe(map(v => { if (v === 2) throw new Error('boom'); return v }))\n"
                             "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1");
    CHECK(error_count == 1);
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: a chain frees its state once the subscription ends" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Refcounts alone must reclaim a finished chain: the operator state, its
     * upstream subscribers and the downstream subscriber reference each
     * other, and the teardown pass is what breaks the cycle. */
    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {map, scan, take} from 'mikro/observable/operators'\n"
        "globalThis.__run = () => {\n"
        "  const src = Observable.withEmitters()\n"
        "  let seen = 0\n"
        "  const chain = src.observable.pipe(map(v => v + 1), scan((a, v) => a + v, 0), take(2))\n"
        "  chain.subscribe(() => seen++)\n"
        "  src.next(1); src.next(2); src.next(3)\n"
        "  const held = chain.subscribe(() => seen++)\n"
        "  src.next(4)\n"
        "  held.unsubscribe()\n"
        "  return seen\n"
        "}\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    JSRuntime* js_rt = JS_GetRuntime(ctx);
    auto run = [&]() {
        JSValue seen = JS_Eval(ctx, "globalThis.__run()", 18, "<run>", JS_EVAL_TYPE_GLOBAL);
        int32_t count = -1;
        JS_ToInt32(ctx, &count, seen);
        JS_FreeValue(ctx, seen);
        return count;
    };
    /* The first run pays the runtime's one-time lazy allocations. */
    CHECK(run() == 3);
    JSMemoryUsage before;
    JS_ComputeMemoryUsage(js_rt, &before);
    CHECK(run() == 3);
    JSMemoryUsage after;
    JS_ComputeMemoryUsage(js_rt, &after);
    /* Everything the run allocated is already gone, without a GC pass. */
    CHECK(after.obj_count == before.obj_count);
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: timer fires once, or keeps ticking with a period" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {take, timer} from 'mikro/observable/operators'\n"
                             "globalThis.__once = []\n"
                             "globalThis.__ticks = []\n"
                             "timer(2).subscribe({next: v => __once.push(v), complete: () => __once.push('done')})\n"
                             "timer(1, 2).pipe(take(3))\n"
                             "  .subscribe({next: v => __ticks.push(v), complete: () => __ticks.push('done')})\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    bool ok = pump_until(rt, 500, [&]() {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue once = JS_GetPropertyStr(ctx, g, "__once");
        JSValue ticks = JS_GetPropertyStr(ctx, g, "__ticks");
        int64_t a = 0, b = 0;
        JS_GetLength(ctx, once, &a);
        JS_GetLength(ctx, ticks, &b);
        JS_FreeValue(ctx, once);
        JS_FreeValue(ctx, ticks);
        JS_FreeValue(ctx, g);
        return a >= 2 && b >= 4;
    });
    CHECK(ok);
    JSValue serialize = eval_module(ctx,
                                    "globalThis.__a = __once.join(',')\n"
                                    "globalThis.__b = __ticks.join(',')\n");
    JS_FreeValue(ctx, serialize);
    CHECK(read_global_string(ctx, "__a") == "0,done");
    CHECK(read_global_string(ctx, "__b") == "0,1,2,done");
    /* take(3) closed the chain: the interval is gone. */
    CHECK(rt->timers->entries.empty());
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: debounceTime emits after a quiet period, flushes on complete" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {debounceTime} from 'mikro/observable/operators'\n"
        "const src = Observable.withEmitters()\n"
        "const lead = Observable.withEmitters()\n"
        "globalThis.__log = []\n"
        "globalThis.__lead = []\n"
        "src.observable.pipe(debounceTime(3))\n"
        "  .subscribe({next: v => __log.push(v), complete: () => __log.push('done')})\n"
        "lead.observable.pipe(debounceTime(3, {leading: true}))\n"
        "  .subscribe({next: v => __lead.push(v), complete: () => __lead.push('done')})\n"
        "src.next(1); src.next(2); src.next(3)\n"
        "lead.next(1); lead.next(2); lead.next(3)\n"
        "globalThis.__sync = __log.length + ',' + __lead.length\n"
        "globalThis.__src = src\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    /* Nothing yet from the trailing edge; the leading edge fired once. */
    CHECK(read_global_string(ctx, "__sync") == "0,1");

    bool ok = pump_until(rt, 500, [&]() {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue lead = JS_GetPropertyStr(ctx, g, "__lead");
        int64_t n = 0;
        JS_GetLength(ctx, lead, &n);
        JS_FreeValue(ctx, lead);
        JS_FreeValue(ctx, g);
        return n >= 2;
    });
    CHECK(ok);
    /* A value still pending when the source completes is flushed first. */
    JSValue tail = eval_module(ctx,
                               "__src.next(4); __src.complete()\n"
                               "globalThis.__a = __log.join(',')\n"
                               "globalThis.__b = __lead.join(',')\n");
    JS_FreeValue(ctx, tail);
    CHECK(read_global_string(ctx, "__a") == "3,4,done");
    CHECK(read_global_string(ctx, "__b") == "1,3");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: throttleTime keeps one value per window on the chosen edge" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {throttleTime} from 'mikro/observable/operators'\n"
        "const a = Observable.withEmitters()\n"
        "const b = Observable.withEmitters()\n"
        "globalThis.__a = []\n"
        "globalThis.__b = []\n"
        "a.observable.pipe(throttleTime(3)).subscribe(v => __a.push(v))\n"
        "b.observable.pipe(throttleTime(3, {leading: false, trailing: true})).subscribe(v => __b.push(v))\n"
        "a.next(1); a.next(2); a.next(3)\n"
        "b.next(1); b.next(2); b.next(3)\n"
        "globalThis.__sync = __a.join(',') + '|' + __b.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    CHECK(read_global_string(ctx, "__sync") == "1|");

    bool ok = pump_until(rt, 500, [&]() {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue b = JS_GetPropertyStr(ctx, g, "__b");
        int64_t n = 0;
        JS_GetLength(ctx, b, &n);
        JS_FreeValue(ctx, b);
        JS_FreeValue(ctx, g);
        return n >= 1;
    });
    CHECK(ok);
    JSValue tail = eval_module(ctx, "globalThis.__joined = __a.join(',') + '|' + __b.join(',')\n");
    JS_FreeValue(ctx, tail);
    /* Leading: the window opener only. Trailing: the last dropped value. */
    CHECK(read_global_string(ctx, "__joined") == "1|3");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: unsubscribing a timed operator releases its timer" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable} from 'mikro/observable'\n"
                             "import {debounceTime, throttleTime, timer} from 'mikro/observable/operators'\n"
                             "const src = Observable.withEmitters()\n"
                             "const subs = [\n"
                             "  src.observable.pipe(debounceTime(1000)).subscribe(),\n"
                             "  src.observable.pipe(throttleTime(1000)).subscribe(),\n"
                             "  timer(1000, 1000).subscribe(),\n"
                             "]\n"
                             "src.next(1)\n"
                             "for (const s of subs) s.unsubscribe()\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    CHECK(rt->timers->entries.empty());
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: switchMap follows the latest inner stream" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "import {switchMap} from 'mikro/observable/operators'\n"
        "const src = Observable.withEmitters()\n"
        "const inners = {a: Observable.withEmitters(), b: Observable.withEmitters()}\n"
        "let log = []\n"
        "src.observable.pipe(switchMap(k => inners[k].observable))\n"
        "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
        "src.next('a'); inners.a.next('a1')\n"
        "src.next('b'); inners.a.next('a2'); inners.b.next('b1')\n"
        "src.complete(); log.push('src-done')\n"
        "inners.b.next('b2'); inners.b.complete()\n"
        "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* a2 is dropped (a was switched away); the source completing waits for
     * the open inner stream. */
    CHECK(read_global_string(ctx, "__log") == "a1,b1,src-done,b2,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: switchMap ignores a switched-away inner's queued completion" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* The inner switchMap is subscribed inside a dispatch, so of(1, 2)'s
     * values are queued: inner 1 completes while queued, the switch to inner
     * 2 skips its pending close, and its completion must not count as the
     * current inner ending. */
    JSValue rv = eval_module(ctx,
                             "import {of} from 'mikro/observable'\n"
                             "import {switchMap} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "of(0).pipe(switchMap(() => of(1, 2).pipe(switchMap(n => of(n, n * 10)))))\n"
                             "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "1,10,2,20,done");
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: takeUntil subscribes the notifier before the source" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(ctx,
                             "import {Observable, of} from 'mikro/observable'\n"
                             "import {takeUntil} from 'mikro/observable/operators'\n"
                             "let log = [], setups = 0\n"
                             "new Observable(sub => { setups++; sub.next(1) }).pipe(takeUntil(of('x')))\n"
                             "  .subscribe({next: v => log.push(v), complete: () => log.push('done')})\n"
                             "globalThis.__log = log.join(',')\n"
                             "globalThis.__setups = setups\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* A notifier that fires during its own subscribe ends the stream before
     * the source is ever subscribed. */
    CHECK(read_global_string(ctx, "__log") == "done");
    CHECK(read_global_int(ctx, "__setups") == 0);
    MIK_FreeRuntime(rt);
}

TEST_CASE("operators: switchMap panics when project returns no Observable" *
          doctest::test_suite("observable")) {
    static int error_count;
    error_count = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    MIK_SetErrorHandler(
        rt, [](JSContext*, JSValue, void*) { error_count++; }, nullptr);

    JSValue rv = eval_module(ctx,
                             "import {from} from 'mikro/observable'\n"
                             "import {switchMap} from 'mikro/observable/operators'\n"
                             "let log = []\n"
                             "from([1, 2]).pipe(switchMap(v => v)).subscribe(v => log.push(v))\n"
                             "globalThis.__log = log.join(',')\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    CHECK(read_global_string(ctx, "__log") == "");
    CHECK(error_count == 1);
    CHECK(MIK_IsStopRequested(rt));
    MIK_FreeRuntime(rt);
}

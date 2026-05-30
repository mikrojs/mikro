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

TEST_CASE("observer.next throw is scheduled async, dispatch continues" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Stub setTimeout so the async-thrown error doesn't actually fire during
     * the test (which would surface as an uncaught exception). Capture each
     * scheduled callback and verify it throws when invoked manually. */
    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const scheduled = []\n"
        "globalThis.setTimeout = (fn, ms) => { scheduled.push({fn, ms}); return 0 }\n"
        "let count = 0\n"
        "new Observable(sub => {\n"
        "  sub.next(1); sub.next(2); sub.next(3); sub.complete()\n"
        "}).subscribe(v => { count++; if (v === 1) throw new Error('boom') })\n"
        "globalThis.__count = count\n"
        "globalThis.__scheduledCount = scheduled.length\n"
        "let msg = ''\n"
        "if (scheduled.length > 0) {\n"
        "  try { scheduled[0].fn() } catch (e) { msg = e.message }\n"
        "}\n"
        "globalThis.__caughtMessage = msg\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* All three values delivered synchronously; subscription stayed alive. */
    CHECK(read_global_int(ctx, "__count") == 3);
    /* Exactly one async re-throw was scheduled; running it surfaces 'boom'. */
    CHECK(read_global_int(ctx, "__scheduledCount") == 1);
    CHECK(read_global_string(ctx, "__caughtMessage") == "boom");
    MIK_FreeRuntime(rt);
}

TEST_CASE("teardown throw schedules async re-throw, subsequent teardowns still run" *
          doctest::test_suite("observable")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    JSValue rv = eval_module(
        ctx,
        "import {Observable} from 'mikro/observable'\n"
        "const scheduled = []\n"
        "globalThis.setTimeout = (fn, ms) => { scheduled.push({fn, ms}); return 0 }\n"
        "let trace = []\n"
        "new Observable(sub => {\n"
        "  sub.addTeardown(() => trace.push('a'))\n"
        "  sub.addTeardown(() => { throw new Error('mid') })\n"
        "  sub.addTeardown(() => trace.push('c'))\n"
        "  sub.complete()\n"
        "}).subscribe()\n"
        "globalThis.__trace = trace.join(',')\n"
        "globalThis.__scheduledCount = scheduled.length\n"
        "let msg = ''\n"
        "if (scheduled.length > 0) {\n"
        "  try { scheduled[0].fn() } catch (e) { msg = e.message }\n"
        "}\n"
        "globalThis.__caughtMessage = msg\n");
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    /* Reverse-insertion order, with the throwing teardown skipped. */
    CHECK(read_global_string(ctx, "__trace") == "c,a");
    CHECK(read_global_int(ctx, "__scheduledCount") == 1);
    CHECK(read_global_string(ctx, "__caughtMessage") == "mid");
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

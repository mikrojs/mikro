#include <cstdio>
#include <cstring>
#include <string>

#include <mikrojs/mem.h>
#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>
#include <mikrojs/utils.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for the Result prototype methods (mik_result.cpp) via
 * mikro/result, the C helpers in utils.cpp (errno errors, MIKPromise,
 * owned Uint8Array buffers), and the PSRAM heap routing in mem.cpp via
 * platform allocator hooks. */

namespace {

struct RtFixture {
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    RtFixture() {
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~RtFixture() { MIK_FreeRuntime(rt); }
};

static void run(JSContext* ctx, const char* src) {
    std::string code = src;
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-result-driver",
                         JS_EVAL_TYPE_MODULE);
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[result run] rejected: %s\n", s);
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

static const char* PRELUDE =
    "import {ok, err} from 'mikro/result'\n"
    "const attempt = (fn) => { try { return String(fn()) } catch (e) { return 'threw:' + e.name } }\n";

}  // namespace

/* ── Result prototype methods ───────────────────────────────────── */

TEST_CASE_FIXTURE(RtFixture, "ok and err factories" * doctest::test_suite("result")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__void = ok().ok && ok().value === undefined\n"
              "globalThis.__val = ok(5).value\n"
              "globalThis.__errName = err({name: 'Boom'}).error.name\n"
              "globalThis.__errEmpty = String(err().error)\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__void") == "true");
    CHECK(read_global_string(ctx, "__val") == "5");
    CHECK(read_global_string(ctx, "__errName") == "Boom");
    CHECK(read_global_string(ctx, "__errEmpty") == "undefined");
}

TEST_CASE_FIXTURE(RtFixture, "map, mapErr, andThen" * doctest::test_suite("result")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__map = ok(2).map((v) => v * 10).value\n"
              "globalThis.__mapErrPass = err({name: 'E'}).map((v) => v * 10).error.name\n"
              "globalThis.__mapBadArg = attempt(() => ok(1).map('nope'))\n"
              "globalThis.__mapThrows = attempt(() => ok(1).map(() => { throw new RangeError('x') }))\n"
              "globalThis.__mapErr = err({name: 'A'}).mapErr((e) => ({name: e.name + 'B'})).error.name\n"
              "globalThis.__mapErrOkPass = ok(3).mapErr(() => 0).value\n"
              "globalThis.__mapErrBadArg = attempt(() => err({}).mapErr(42))\n"
              "globalThis.__chain = ok(4).andThen((v) => ok(v + 1)).value\n"
              "globalThis.__chainErr = ok(4).andThen(() => err({name: 'Deep'})).error.name\n"
              "globalThis.__chainPass = err({name: 'Early'}).andThen(() => ok(9)).error.name\n"
              "globalThis.__chainBadArg = attempt(() => ok(1).andThen(null))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__map") == "20");
    CHECK(read_global_string(ctx, "__mapErrPass") == "E");
    CHECK(read_global_string(ctx, "__mapBadArg") == "threw:TypeError");
    CHECK(read_global_string(ctx, "__mapThrows") == "threw:RangeError");
    CHECK(read_global_string(ctx, "__mapErr") == "AB");
    CHECK(read_global_string(ctx, "__mapErrOkPass") == "3");
    CHECK(read_global_string(ctx, "__mapErrBadArg") == "threw:TypeError");
    CHECK(read_global_string(ctx, "__chain") == "5");
    CHECK(read_global_string(ctx, "__chainErr") == "Deep");
    CHECK(read_global_string(ctx, "__chainPass") == "Early");
    CHECK(read_global_string(ctx, "__chainBadArg") == "threw:TypeError");
}

TEST_CASE_FIXTURE(RtFixture, "match, orDefault, orPanic" * doctest::test_suite("result")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__matchOk = ok(1).match({ok: (v) => 'v' + v, err: () => 'e'})\n"
              "globalThis.__matchErr = err({name: 'N'}).match({ok: () => 'v', err: (e) => 'e' + e.name})\n"
              "globalThis.__matchBadArg = attempt(() => ok(1).match('nope'))\n"
              "globalThis.__matchMissing = attempt(() => ok(1).match({err: () => 'e'}))\n"
              "globalThis.__orDef = ok('have').orDefault('fallback')\n"
              "globalThis.__orDefErr = err({}).orDefault('fallback')\n"
              "globalThis.__orDefNone = String(err({}).orDefault())\n"
              "globalThis.__panicOk = ok('fine').orPanic('nope')\n"
              "try { err({name: 'Root'}).orPanic('gave up') } catch (e) {\n"
              "  globalThis.__panic = e.name + ':' + e.message + ':' + e.cause.name\n"
              "}\n"
              "try { err({name: 'R2'}).orPanic() } catch (e) {\n"
              "  globalThis.__panicDefault = e.message\n"
              "}\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__matchOk") == "v1");
    CHECK(read_global_string(ctx, "__matchErr") == "eN");
    CHECK(read_global_string(ctx, "__matchBadArg") == "threw:TypeError");
    CHECK(read_global_string(ctx, "__matchMissing") == "threw:TypeError");
    CHECK(read_global_string(ctx, "__orDef") == "have");
    CHECK(read_global_string(ctx, "__orDefErr") == "fallback");
    CHECK(read_global_string(ctx, "__orDefNone") == "undefined");
    CHECK(read_global_string(ctx, "__panicOk") == "fine");
    CHECK(read_global_string(ctx, "__panic") == "PanicError:gave up:Root");
    CHECK(read_global_string(ctx, "__panicDefault") == "panic");
}

TEST_CASE_FIXTURE(RtFixture, "results render as Ok<> and Err<> via inspect" *
                                 doctest::test_suite("result")) {
    run(ctx, (std::string(PRELUDE) +
              "const sym = Symbol.for('mikrojs.inspect')\n"
              "globalThis.__okStr = ok(5)[sym](1, (v) => String(v))\n"
              "globalThis.__errStr = err({name: 'E'})[sym](1, (e) => e.name)\n"
              "globalThis.__okBare = ok(5)[sym]()\n"
              "globalThis.__errBare = err({})[sym]()\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__okStr") == "Ok<5>");
    CHECK(read_global_string(ctx, "__errStr") == "Err<E>");
    CHECK(read_global_string(ctx, "__okBare") == "Ok<?>");
    CHECK(read_global_string(ctx, "__errBare") == "Err<?>");
}

/* ── utils.cpp C helpers ────────────────────────────────────────── */

TEST_CASE_FIXTURE(RtFixture, "errno errors carry message and errno" *
                                 doctest::test_suite("utils")) {
    JSValue thrown = mik_throw_errno(ctx, ENOENT);
    CHECK(JS_IsException(thrown));
    JSValue exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JSValue eno = JS_GetPropertyStr(ctx, exc, "errno");
    int32_t e = 0;
    JS_ToInt32(ctx, &e, eno);
    CHECK(e == ENOENT);
    JSValue msg = JS_GetPropertyStr(ctx, exc, "message");
    const char* s = JS_ToCString(ctx, msg);
    CHECK(std::string(s ? s : "") == strerror(ENOENT));
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, eno);
    JS_FreeValue(ctx, exc);
}

TEST_CASE_FIXTURE(RtFixture, "mik_call_handler invokes and survives throwers" *
                                 doctest::test_suite("utils")) {
    run(ctx,
        "globalThis.__called = 0\n"
        "globalThis.__recorder = (v) => { globalThis.__called = v }\n"
        "globalThis.__thrower = () => { throw new Error('handler boom') }\n");
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue recorder = JS_GetPropertyStr(ctx, g, "__recorder");
    JSValue thrower = JS_GetPropertyStr(ctx, g, "__thrower");
    JS_FreeValue(ctx, g);

    JSValue arg = JS_NewInt32(ctx, 41);
    mik_call_handler(ctx, recorder, 1, &arg);
    JS_FreeValue(ctx, arg);
    CHECK(read_global_string(ctx, "__called") == "41");

    /* the thrower's error is dumped, not propagated */
    mik_call_handler(ctx, thrower, 0, nullptr);
    CHECK_FALSE(JS_HasException(ctx));

    JS_FreeValue(ctx, recorder);
    JS_FreeValue(ctx, thrower);
}

TEST_CASE_FIXTURE(RtFixture, "MIKPromise settles through resolve and reject" *
                                 doctest::test_suite("utils")) {
    MIKPromise p;
    JSValue promise = MIK_InitPromise(ctx, &p);
    REQUIRE(!JS_IsException(promise));
    CHECK(MIK_IsPromisePending(ctx, &p));

    JSValue val = JS_NewInt32(ctx, 7);
    MIK_ResolvePromise(ctx, &p, 1, &val); /* consumes val and frees p's refs */
    MIK_ClearPromise(ctx, &p);
    CHECK_FALSE(MIK_IsPromisePending(ctx, &p));
    CHECK(JS_PromiseState(ctx, promise) == JS_PROMISE_FULFILLED);
    JS_FreeValue(ctx, promise);

    MIKPromise p2;
    JSValue promise2 = MIK_InitPromise(ctx, &p2);
    REQUIRE(!JS_IsException(promise2));
    JSValue reason = JS_NewString(ctx, "denied");
    MIK_RejectPromise(ctx, &p2, 1, &reason);
    MIK_ClearPromise(ctx, &p2);
    CHECK(JS_PromiseState(ctx, promise2) == JS_PROMISE_REJECTED);
    JSValue got = JS_PromiseResult(ctx, promise2);
    const char* s = JS_ToCString(ctx, got);
    CHECK(std::string(s ? s : "") == "denied");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, got);
    JS_FreeValue(ctx, promise2);
}

TEST_CASE_FIXTURE(RtFixture, "pre-settled promises report their state" *
                                 doctest::test_suite("utils")) {
    JSValue v = JS_NewInt32(ctx, 1);
    JSValue resolved = MIK_NewResolvedPromise(ctx, 1, &v); /* consumes v */
    CHECK(JS_PromiseState(ctx, resolved) == JS_PROMISE_FULFILLED);
    JS_FreeValue(ctx, resolved);

    JSValue r = JS_NewString(ctx, "no");
    JSValue rejected = MIK_NewRejectedPromise(ctx, 1, &r); /* consumes r */
    CHECK(JS_PromiseState(ctx, rejected) == JS_PROMISE_REJECTED);
    JSValue reason = JS_PromiseResult(ctx, rejected);
    JS_FreeValue(ctx, reason);
    JS_FreeValue(ctx, rejected);
}

TEST_CASE_FIXTURE(RtFixture, "owned Uint8Array buffers survive transfer" *
                                 doctest::test_suite("utils")) {
    uint8_t* data = static_cast<uint8_t*>(js_malloc(ctx, 4));
    REQUIRE(data != nullptr);
    memcpy(data, "abcd", 4);
    JSValue u8 = MIK_NewUint8Array(ctx, data, 4);
    REQUIRE(!JS_IsException(u8));
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "__u8", u8); /* takes ownership */
    JS_FreeValue(ctx, g);
    /* transfer() exercises the non-zero branch of the backing-store hook */
    run(ctx,
        "const bigger = globalThis.__u8.buffer.transfer(8)\n"
        "globalThis.__view = String.fromCharCode(...new Uint8Array(bigger, 0, 4))\n"
        "globalThis.__len = bigger.byteLength\n");
    CHECK(read_global_string(ctx, "__view") == "abcd");
    CHECK(read_global_string(ctx, "__len") == "8");
}

/* ── mem.cpp PSRAM heap routing ─────────────────────────────────── */

namespace {

static int g_psram_allocs = 0;
static bool g_psram_exhausted = false;

static void* fake_malloc_psram(size_t size) {
    if (g_psram_exhausted) return nullptr;
    g_psram_allocs++;
    return malloc(size);
}

static void* fake_calloc_psram(size_t count, size_t size) {
    if (g_psram_exhausted) return nullptr;
    g_psram_allocs++;
    return calloc(count, size);
}

static void* fake_realloc_psram(void* ptr, size_t size) {
    if (g_psram_exhausted) return nullptr;
    g_psram_allocs++;
    return realloc(ptr, size);
}

}  // namespace

TEST_CASE("PSRAM heap routes JS allocations through the platform" *
          doctest::test_suite("utils")) {
    const MIKPlatform* orig = MIK_GetPlatform();
    MIKPlatform fake = *orig;
    fake.malloc_psram = fake_malloc_psram;
    fake.calloc_psram = fake_calloc_psram;
    fake.realloc_psram = fake_realloc_psram;
    MIK_SetPlatform(&fake);
    g_psram_allocs = 0;
    g_psram_exhausted = false;

    MIKRunOptions options;
    MIK_DefaultOptions(&options);
    options.use_psram_heap = true;
    MIKRuntime* rt = MIK_NewRuntimeOptions(&options);
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);
    const char* src = "globalThis.__x = [1, 2, 3].map((v) => v * 2).join('')";
    JSValue rv = JS_Eval(ctx, src, strlen(src), "main.js", JS_EVAL_TYPE_GLOBAL);
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    CHECK(g_psram_allocs > 0);

    /* Exhausted PSRAM falls back to libc malloc; the runtime keeps working. */
    g_psram_exhausted = true;
    const char* more = "globalThis.__y = 'still-works'";
    rv = JS_Eval(ctx, more, strlen(more), "main.js", JS_EVAL_TYPE_GLOBAL);
    CHECK_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);

    MIK_FreeRuntime(rt);
    mik__set_quickjs_heap_psram(false);
    MIK_SetPlatform(orig);
}

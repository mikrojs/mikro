#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Shared helper: evaluate a module that imports mikro/stream, run
 * async tests, and pin the result on globalThis.__result (a string
 * summary). Check expected is a substring of __result.
 *
 * We use a string summary rather than multiple globals because it
 * keeps each test case's plumbing to two calls (eval + check) and
 * makes the JS side easier to reason about.
 *
 * Note: doctest's CHECK_MESSAGE / REQUIRE_MESSAGE take a single
 * stream-insertable message, not varargs. Building the message as a
 * std::string first avoids a footgun where const char* tokens get
 * stringified as raw pointer addresses in failure output. */
static void run_stream_test(const char* test_name, const char* js_code,
                            const char* expected_substring) {
    const auto mik_rt = MIK_NewRuntime();
    REQUIRE(mik_rt != nullptr);
    const auto ctx = MIK_GetJSContext(mik_rt);

    JSValue ret = MIK_EvalModuleContent(ctx, "/test/stream_test.js", js_code, strlen(js_code));
    {
        std::string msg = std::string("[") + test_name + "] module eval should not throw";
        CHECK_MESSAGE(!JS_IsException(ret), msg);
    }
    JS_FreeValue(ctx, ret);

    /* Drain the microtask queue so async functions run to completion */
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result = JS_GetPropertyStr(ctx, global, "__result");
    const char* result_str = JS_ToCString(ctx, result);
    {
        std::string msg = std::string("[") + test_name + "] expected __result to be a string";
        REQUIRE_MESSAGE(result_str != nullptr, msg);
    }
    std::string actual(result_str);
    JS_FreeCString(ctx, result_str);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);

    {
        std::string msg = std::string("[") + test_name + "] expected '" + expected_substring +
                          "' in result, got: " + actual;
        CHECK_MESSAGE(actual.find(expected_substring) != std::string::npos, msg);
    }

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("decodeUtf8 converts byte chunks to strings" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {decodeUtf8} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok(new Uint8Array([104, 101, 108, 108, 111]))  // "hello"
            yield ok(new Uint8Array([32, 119, 111, 114, 108, 100]))  // " world"
        }

        const out = []
        for await (const r of decodeUtf8(source())) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("decodeUtf8 basic", code, "hello| world");
}

TEST_CASE("decodeUtf8 handles whole multi-byte sequences in a single chunk" *
          doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {decodeUtf8} from 'mikro/stream'
        import {ok} from 'mikro/result'

        // "café" = 63 61 66 c3 a9 — whole sequence in one chunk is fine.
        // Cross-chunk split is documented as NOT supported in V1.
        async function* source() {
            yield ok(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]))
        }

        let out = ''
        for await (const r of decodeUtf8(source())) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out += r.value
        }
        globalThis.__result = out
    )JS";
    run_stream_test("decodeUtf8 whole utf8", code, "café");
}

TEST_CASE("decodeUtf8 short-circuits on source err" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {decodeUtf8} from 'mikro/stream'
        import {ok, err} from 'mikro/result'

        async function* source() {
            yield ok(new Uint8Array([0x61]))
            yield err({name: 'Boom'})
            yield ok(new Uint8Array([0x62]))  // should not be reached
        }

        const out = []
        for await (const r of decodeUtf8(source())) {
            if (!r.ok) { out.push(`err=${r.error.name}`); break }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("decodeUtf8 err propagates", code, "a|err=Boom");
}

TEST_CASE("splitLines splits text on newline" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {splitLines} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('first\n')
            yield ok('second\nthird\n')
            yield ok('fourth')  // no trailing newline
        }

        const out = []
        for await (const r of splitLines(source())) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("splitLines basic", code, "first|second|third|fourth");
}

TEST_CASE("splitLines handles lines spanning chunks" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {splitLines} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('hel')
            yield ok('lo\nwo')
            yield ok('rld\n')
        }

        const out = []
        for await (const r of splitLines(source())) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("splitLines cross-chunk", code, "hello|world");
}

TEST_CASE("splitLines supports custom delimiter" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {splitLines} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('a\r\nb\r\n')
            yield ok('c\r\n')
        }

        const out = []
        for await (const r of splitLines(source(), '\r\n')) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("splitLines crlf", code, "a|b|c");
}

TEST_CASE("splitLines rejects empty delimiter" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {splitLines} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('anything')
        }

        try {
            for await (const _ of splitLines(source(), '')) { /* nope */ }
            globalThis.__result = 'no throw'
        } catch (e) {
            globalThis.__result = `threw=${e.name}`
        }
    )JS";
    run_stream_test("splitLines empty delimiter", code, "threw=RangeError");
}

TEST_CASE("splitLines preserves empty lines" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {splitLines} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('a\n\nb\n')
        }

        const out = []
        for await (const r of splitLines(source())) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|') + ':' + out.length
    )JS";
    run_stream_test("splitLines empty", code, "a||b:3");
}

TEST_CASE("collectUntil collects until predicate matches" *
          doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {collectUntil} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('+CSQ: 15,99')
            yield ok('+CREG: 0,1')
            yield ok('OK')
            yield ok('should not be reached')
        }

        const r = await collectUntil(
            source(),
            line => line === 'OK' || line.startsWith('ERROR'),
        )
        if (!r.ok) {
            globalThis.__result = `err=${r.error.name}`
        } else {
            const {matched, collected} = r.value
            globalThis.__result = `matched=${matched};collected=${collected.join('|')}`
        }
    )JS";
    run_stream_test("collectUntil basic", code,
                    "matched=OK;collected=+CSQ: 15,99|+CREG: 0,1");
}

TEST_CASE("collectUntil returns StreamClosed if no match" *
          doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {collectUntil} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok('a')
            yield ok('b')
        }

        const r = await collectUntil(source(), s => s === 'OK')
        if (r.ok) {
            globalThis.__result = 'no err'
        } else {
            globalThis.__result = `err=${r.error.name}`
        }
    )JS";
    run_stream_test("collectUntil no match", code, "err=StreamClosed");
}

TEST_CASE("collectUntil propagates source err" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {collectUntil} from 'mikro/stream'
        import {ok, err} from 'mikro/result'

        async function* source() {
            yield ok('a')
            yield err({name: 'Boom'})
            yield ok('OK')
        }

        const r = await collectUntil(source(), s => s === 'OK')
        if (r.ok) {
            globalThis.__result = 'no err'
        } else {
            globalThis.__result = `err=${r.error.name}`
        }
    )JS";
    run_stream_test("collectUntil source err", code, "err=Boom");
}

/* NOTE: the "slow source" timeout test is intentionally omitted from
 * the host suite. mik__execute_jobs drains only currently-ready jobs —
 * it doesn't block waiting for setTimeout callbacks — so a test that
 * relies on a real wall-clock delay can't reach its assertion here.
 * Timeout behavior should be verified via `mikro sim profile` /
 * `mikro sim dev` runs against the stream module. The fast-path test
 * below still exercises the happy path (source completes before
 * deadline) because the internal clearTimeout on the race fast-path
 * means the 5000ms deadline timer never has to fire. */

/* BufferedReader tests moved to reader_test.cpp — it lives in its own
 * module (`mikro/reader`) so byte-reader consumers don't have to
 * load the async-generator transforms above. */

TEST_CASE("withTimeout passes through fast items" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {withTimeout} from 'mikro/stream'
        import {ok} from 'mikro/result'

        async function* source() {
            yield ok(1)
            yield ok(2)
            yield ok(3)
        }

        const out = []
        for await (const r of withTimeout(source(), 5000)) {
            if (!r.ok) { globalThis.__result = `err=${r.error.name}`; throw 'stop' }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("withTimeout fast", code, "1|2|3");
}

TEST_CASE("withTimeout propagates source err" * doctest::test_suite("stream")) {
    const char* code = R"JS(
        import {withTimeout} from 'mikro/stream'
        import {ok, err} from 'mikro/result'

        async function* source() {
            yield ok(1)
            yield err({name: 'Boom'})
            yield ok(2)  // should not be reached
        }

        const out = []
        for await (const r of withTimeout(source(), 5000)) {
            if (!r.ok) { out.push(`err=${r.error.name}`); break }
            out.push(r.value)
        }
        globalThis.__result = out.join('|')
    )JS";
    run_stream_test("withTimeout source err", code, "1|err=Boom");
}

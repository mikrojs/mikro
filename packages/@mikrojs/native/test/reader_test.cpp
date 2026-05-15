#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Shared helper: evaluate a module that imports mikrojs/reader, run
 * async tests, and pin the result on globalThis.__result (a string
 * summary). Check expected is a substring of __result.
 *
 * Mirrors the helper in stream_test.cpp — kept duplicated rather than
 * shared so each file is self-contained and doesn't depend on link
 * ordering of helper definitions. */
static void run_reader_test(const char* test_name, const char* js_code,
                            const char* expected_substring) {
    const auto mik_rt = MIK_NewRuntime();
    REQUIRE(mik_rt != nullptr);
    const auto ctx = MIK_GetJSContext(mik_rt);

    JSValue ret = MIK_EvalModuleContent(ctx, "/test/reader_test.js", js_code, strlen(js_code));
    {
        std::string msg = std::string("[") + test_name + "] module eval should not throw";
        CHECK_MESSAGE(!JS_IsException(ret), msg);
    }
    JS_FreeValue(ctx, ret);

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

TEST_CASE("BufferedReader.readUntil returns bytes before delimiter" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([104, 105, 13, 10, 98, 121, 101, 13, 10]))  // "hi\r\nbye\r\n"
        }

        const reader = new BufferedReader(source())
        const crlf = new Uint8Array([13, 10])
        const first = await reader.readUntil(crlf, {timeoutMs: 5000})
        const second = await reader.readUntil(crlf, {timeoutMs: 5000})

        if (!first.ok || !second.ok) {
            globalThis.__result = `err=${(first.error || second.error).name}`
        } else {
            const td = new TextDecoder()
            globalThis.__result = `${td.decode(first.value)}|${td.decode(second.value)}`
        }
    )JS";
    run_reader_test("BufferedReader readUntil basic", code, "hi|bye");
}

TEST_CASE("BufferedReader.readUntil spans multiple source chunks" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([104, 101]))    // "he"
            yield ok(new Uint8Array([108, 108]))    // "ll"
            yield ok(new Uint8Array([111, 13, 10])) // "o\r\n"
        }

        const reader = new BufferedReader(source())
        const r = await reader.readUntil(new Uint8Array([13, 10]), {timeoutMs: 5000})
        globalThis.__result = r.ok ? new TextDecoder().decode(r.value) : `err=${r.error.name}`
    )JS";
    run_reader_test("BufferedReader readUntil multichunk", code, "hello");
}

TEST_CASE("BufferedReader.readUntil rejects empty delimiter" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() { yield ok(new Uint8Array([0])) }

        try {
            await new BufferedReader(source()).readUntil(new Uint8Array(0), {timeoutMs: 100})
            globalThis.__result = 'no throw'
        } catch (e) {
            globalThis.__result = `threw=${e.name}`
        }
    )JS";
    run_reader_test("BufferedReader readUntil empty delim", code, "threw=RangeError");
}

TEST_CASE("BufferedReader.readUntil returns StreamClosed when source ends early" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([1, 2, 3]))  // no delimiter, then end
        }

        const r = await new BufferedReader(source()).readUntil(new Uint8Array([0xff]), {timeoutMs: 100})
        globalThis.__result = r.ok ? 'no err' : `err=${r.error.name}`
    )JS";
    run_reader_test("BufferedReader readUntil closed", code, "err=StreamClosed");
}

TEST_CASE("BufferedReader.readUntil propagates source err" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok, err} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([1, 2]))
            yield err({name: 'Boom'})
        }

        const r = await new BufferedReader(source()).readUntil(new Uint8Array([0xff]), {timeoutMs: 1000})
        globalThis.__result = r.ok ? 'no err' : `err=${r.error.name}`
    )JS";
    run_reader_test("BufferedReader readUntil src err", code, "err=Boom");
}

TEST_CASE("BufferedReader.readBytes returns exactly count bytes" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
        }

        const reader = new BufferedReader(source())
        const a = await reader.readBytes(3, {timeoutMs: 5000})
        const b = await reader.readBytes(5, {timeoutMs: 5000})

        if (!a.ok || !b.ok) {
            globalThis.__result = 'err'
        } else {
            globalThis.__result = `a=${[...a.value].join(',')};b=${[...b.value].join(',')}`
        }
    )JS";
    run_reader_test("BufferedReader readBytes basic", code, "a=1,2,3;b=4,5,6,7,8");
}

TEST_CASE("BufferedReader.readBytes spans multiple source chunks" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([1, 2]))
            yield ok(new Uint8Array([3, 4]))
            yield ok(new Uint8Array([5, 6]))
        }

        const reader = new BufferedReader(source())
        const r = await reader.readBytes(6, {timeoutMs: 5000})
        globalThis.__result = r.ok ? [...r.value].join(',') : `err=${r.error.name}`
    )JS";
    run_reader_test("BufferedReader readBytes multichunk", code, "1,2,3,4,5,6");
}

TEST_CASE("BufferedReader.readBytes of 0 returns empty buffer without pulling" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        let pulled = false
        async function* source() {
            pulled = true
            yield ok(new Uint8Array([]))
        }

        const reader = new BufferedReader(source())
        const r = await reader.readBytes(0, {timeoutMs: 5000})
        globalThis.__result = r.ok ? `len=${r.value.length};pulled=${pulled}` : 'err'
    )JS";
    run_reader_test("BufferedReader readBytes zero", code, "len=0;pulled=false");
}

TEST_CASE("BufferedReader.drain discards buffered bytes" * doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        async function* source() {
            yield ok(new Uint8Array([1, 2, 3, 4, 5]))
            yield ok(new Uint8Array([9, 9, 9]))
        }

        const reader = new BufferedReader(source())
        const first = await reader.readBytes(2, {timeoutMs: 5000})
        reader.drain()
        const second = await reader.readBytes(3, {timeoutMs: 5000})

        if (!first.ok || !second.ok) {
            globalThis.__result = 'err'
        } else {
            globalThis.__result = `first=${[...first.value].join(',')};second=${[...second.value].join(',')}`
        }
    )JS";
    run_reader_test("BufferedReader drain", code, "first=1,2;second=9,9,9");
}

TEST_CASE("BufferedReader readUntil and readBytes interleave on same buffer" *
          doctest::test_suite("reader")) {
    const char* code = R"JS(
        import {BufferedReader} from 'mikrojs/reader'
        import {ok} from 'mikrojs/result'

        // Simulates a modem-style protocol: header line, then length-prefixed
        // binary payload. The header is CRLF-terminated; the payload is raw.
        async function* source() {
            yield ok(new Uint8Array([
                0x4f, 0x4b, 0x0d, 0x0a,  // "OK\r\n"
                0xde, 0xad, 0xbe, 0xef,  // 4-byte payload
            ]))
        }

        const reader = new BufferedReader(source())
        const line = await reader.readUntil(new Uint8Array([13, 10]), {timeoutMs: 5000})
        const body = await reader.readBytes(4, {timeoutMs: 5000})

        if (!line.ok || !body.ok) {
            globalThis.__result = 'err'
        } else {
            globalThis.__result = `line=${new TextDecoder().decode(line.value)};body=${[...body.value].map(b => b.toString(16)).join(',')}`
        }
    )JS";
    run_reader_test("BufferedReader mixed mode", code, "line=OK;body=de,ad,be,ef");
}

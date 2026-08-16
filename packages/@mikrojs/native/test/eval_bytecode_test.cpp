#include <cstring>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for mik__eval_bytecode (eval_bytecode.cpp): the loader for
 * pre-compiled .bjs modules. Bytecode is produced in-test with JS_WriteObject
 * so the runtime and compiler versions always match. */

namespace {

struct BcFixture {
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    BcFixture() {
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        ctx = MIK_GetJSContext(rt);
    }

    ~BcFixture() { MIK_FreeRuntime(rt); }
};

/* Compile `src` (module or global script) to serialized bytecode. */
static uint8_t* compile(JSContext* ctx, const char* src, const char* name, int eval_flags,
                        size_t* out_len) {
    JSValue obj = JS_Eval(ctx, src, strlen(src), name, eval_flags | JS_EVAL_FLAG_COMPILE_ONLY);
    REQUIRE(!JS_IsException(obj));
    uint8_t* buf = JS_WriteObject(ctx, out_len, obj, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, obj);
    REQUIRE(buf != nullptr);
    return buf;
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

}  // namespace

TEST_CASE_FIXTURE(BcFixture, "module bytecode evaluates" * doctest::test_suite("bytecode")) {
    size_t len = 0;
    uint8_t* buf = compile(ctx, "globalThis.__ran = 7\nexport const x = 1\n",
                           "mikro/test-bc-module", JS_EVAL_TYPE_MODULE, &len);
    CHECK(mik__eval_bytecode(ctx, buf, len, true) == 0);
    js_free(ctx, buf);
    CHECK(read_global_int(ctx, "__ran") == 7);
}

TEST_CASE_FIXTURE(BcFixture, "global-script bytecode evaluates" * doctest::test_suite("bytecode")) {
    size_t len = 0;
    uint8_t* buf =
        compile(ctx, "globalThis.__script = 11\n", "test-bc-script.js", JS_EVAL_TYPE_GLOBAL, &len);
    CHECK(mik__eval_bytecode(ctx, buf, len, true) == 0);
    js_free(ctx, buf);
    CHECK(read_global_int(ctx, "__script") == 11);
}

TEST_CASE_FIXTURE(BcFixture, "garbage bytes fail cleanly" * doctest::test_suite("bytecode")) {
    const uint8_t garbage[] = {0xde, 0xad, 0xbe, 0xef};
    CHECK(mik__eval_bytecode(ctx, garbage, sizeof(garbage), true) == -1);
    /* the error was consumed (dumped), not left pending */
    CHECK_FALSE(JS_HasException(ctx));
}

TEST_CASE_FIXTURE(BcFixture, "a missing import binding fails at resolve" *
                                 doctest::test_suite("bytecode")) {
    size_t len = 0;
    uint8_t* buf = compile(ctx,
                           "import {definitely_not_exported} from 'mikro/result'\n"
                           "export const y = definitely_not_exported\n",
                           "mikro/test-bc-badbind", JS_EVAL_TYPE_MODULE, &len);
    CHECK(mik__eval_bytecode(ctx, buf, len, true) == -1);
    js_free(ctx, buf);
    CHECK_FALSE(JS_HasException(ctx)); /* dumped, not left pending */
}

TEST_CASE_FIXTURE(BcFixture, "top-level throw rejects the module promise" *
                                 doctest::test_suite("bytecode")) {
    size_t len = 0;
    uint8_t* buf = compile(ctx, "throw new Error('boot failure')\n", "mikro/test-bc-throws",
                           JS_EVAL_TYPE_MODULE, &len);
    CHECK(mik__eval_bytecode(ctx, buf, len, true) == -1);
    js_free(ctx, buf);
}

TEST_CASE_FIXTURE(BcFixture, "check_promise=false ignores the rejection" *
                                 doctest::test_suite("bytecode")) {
    size_t len = 0;
    uint8_t* buf = compile(ctx, "throw new Error('ignored')\n", "mikro/test-bc-ignored",
                           JS_EVAL_TYPE_MODULE, &len);
    CHECK(mik__eval_bytecode(ctx, buf, len, false) == 0);
    js_free(ctx, buf);
}

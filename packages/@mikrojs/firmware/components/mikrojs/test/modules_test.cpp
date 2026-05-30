#include <string.h>

#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

static void assert_normalizes_to(JSContext* ctx, const char* base, const char* name,
                                 const char* expected) {
    char* result = mik_module_normalizer(ctx, base, name, nullptr);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "mik_module_normalizer returned NULL");
    TEST_ASSERT_EQUAL_STRING(expected, result);
    js_free(ctx, result);
}

TEST_CASE("Bare module names pass through unchanged", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "main.js", "mikrojs/fs", "mikrojs/fs");
    assert_normalizes_to(ctx, "main.js", "lodash", "lodash");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Relative ./import resolves against base dirname", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "lib/foo.js", "./bar.js", "lib/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Parent ../traversal resolves correctly", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "lib/sub/foo.js", "../bar.js", "lib/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Multiple ../traversals resolve correctly", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "a/b/c/foo.js", "../../bar.js", "a/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Root-level relative import", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "foo.js", "./bar.js", "bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Simple module eval works", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "var result = 1 + 2;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    TEST_ASSERT_FALSE(JS_IsException(ret));
    JS_FreeValue(ctx, ret);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Module import.meta.main is true for entry module", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__isMain = import.meta.main;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    /* Execute pending jobs so the module body runs */
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue is_main = JS_GetPropertyStr(ctx, global, "__isMain");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsBool(is_main), "Expected __isMain to be a boolean");
    TEST_ASSERT_EQUAL(1, JS_ToBool(ctx, is_main));
    JS_FreeValue(ctx, is_main);
    JS_FreeValue(ctx, global);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("withUnload() unloads a module after the callback returns", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    /* Virtual leaf module with an eval counter: a second evaluation proves it
     * was genuinely unloaded (re-import re-runs the body). Using a virtual
     * module avoids depending on the LittleFS layout in the test. */
    const char* leaf =
        "globalThis.__leafEvals = (globalThis.__leafEvals || 0) + 1;\n"
        "export const v = 99;\n";
    MIK_RegisterVirtualModule(mik_rt, "/test/leaf.js", leaf, strlen(leaf));

    /* Exercises the real shipped mikrojs/module withUnload() on device. */
    const char* code =
        "import {withUnload} from 'mikrojs/module';\n"
        "globalThis.__first = await withUnload(import('./leaf.js'), (mod) => mod.v);\n"
        "globalThis.__after = true;\n"
        "const b = await import('./leaf.js');\n"
        "globalThis.__second = b.v;\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "disposable e2e module eval threw");
    JS_FreeValue(ctx, ret);
    mik__execute_jobs(ctx);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue first = JS_GetPropertyStr(ctx, g, "__first");
    JSValue after = JS_GetPropertyStr(ctx, g, "__after");
    JSValue second = JS_GetPropertyStr(ctx, g, "__second");
    JSValue evals = JS_GetPropertyStr(ctx, g, "__leafEvals");
    int32_t first_i = 0, second_i = 0, evals_i = 0;
    JS_ToInt32(ctx, &first_i, first);
    JS_ToInt32(ctx, &second_i, second);
    JS_ToInt32(ctx, &evals_i, evals);
    TEST_ASSERT_EQUAL(99, first_i);
    TEST_ASSERT_EQUAL(1, JS_ToBool(ctx, after));
    TEST_ASSERT_EQUAL(99, second_i);
    TEST_ASSERT_EQUAL_MESSAGE(2, evals_i, "leaf should re-evaluate, proving real unload");
    JS_FreeValue(ctx, first);
    JS_FreeValue(ctx, after);
    JS_FreeValue(ctx, second);
    JS_FreeValue(ctx, evals);
    JS_FreeValue(ctx, g);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Bytecode roundtrip: compile then load", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    const char* code = "var x = 40 + 2;";

    /* Compile to bytecode */
    JSValue compiled = JS_Eval(ctx, code, strlen(code), "test.js",
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(compiled), "Compilation should succeed");

    size_t bytecode_len;
    uint8_t* bytecode = JS_WriteObject(ctx, &bytecode_len, compiled, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, compiled);
    TEST_ASSERT_NOT_NULL_MESSAGE(bytecode, "JS_WriteObject should produce bytecode");
    TEST_ASSERT_TRUE_MESSAGE(bytecode_len > 0, "Bytecode should not be empty");

    /* Load from bytecode */
    JSValue loaded = JS_ReadObject(ctx, bytecode, bytecode_len, JS_READ_OBJ_BYTECODE);
    js_free(ctx, bytecode);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(loaded), "JS_ReadObject should succeed");
    TEST_ASSERT_TRUE_MESSAGE(JS_VALUE_GET_TAG(loaded) == JS_TAG_MODULE, "Should be a module");

    /* Execute */
    JSValue result = JS_EvalFunction(ctx, loaded);
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(result), "JS_EvalFunction should succeed");
    JS_FreeValue(ctx, result);

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

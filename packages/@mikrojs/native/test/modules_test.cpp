#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unistd.h>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

namespace {

struct TmpDir {
    std::string path;
    TmpDir() {
        char tmpl[] = "/tmp/mikrojs-unload-XXXXXX";
        const char* d = mkdtemp(tmpl);
        REQUIRE(d != nullptr);
        path = d;
    }
    ~TmpDir() { rmdir(path.c_str()); }
    std::string write(const char* name, const char* content) {
        std::string p = path + "/" + name;
        FILE* f = fopen(p.c_str(), "w");
        REQUIRE(f != nullptr);
        fputs(content, f);
        fclose(f);
        return p;
    }
};

}  // namespace

static void assert_normalizes_to(JSContext* ctx, const char* base, const char* name,
                                 const char* expected) {
    char* result = mik_module_normalizer(ctx, base, name, nullptr);
    CHECK_MESSAGE(result != nullptr, "mik_module_normalizer returned NULL");
    CHECK_EQ(std::string(expected), std::string(result));
    js_free(ctx, result);
}

TEST_CASE("Bare module names pass through unchanged" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "main.js", "mikrojs/fs", "mikrojs/fs");
    assert_normalizes_to(ctx, "main.js", "lodash", "lodash");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Relative ./import resolves against base dirname" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "lib/foo.js", "./bar.js", "lib/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Parent ../traversal resolves correctly" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "lib/sub/foo.js", "../bar.js", "lib/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Multiple ../traversals resolve correctly" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "a/b/c/foo.js", "../../bar.js", "a/bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Root-level relative import" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    assert_normalizes_to(ctx, "foo.js", "./bar.js", "bar.js");

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Simple module eval works" * doctest::test_suite("modules")) {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "var result = 1 + 2;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    CHECK_FALSE(JS_IsException(ret));
    JS_FreeValue(ctx, ret);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Module import.meta.main is true for entry module" * doctest::test_suite("modules")) {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__isMain = import.meta.main;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    CHECK_MESSAGE(!JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    /* Execute pending jobs so the module body runs */
    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue is_main = JS_GetPropertyStr(ctx, global, "__isMain");
    CHECK_MESSAGE(JS_IsBool(is_main), "Expected __isMain to be a boolean");
    CHECK_EQ(1, JS_ToBool(ctx, is_main));
    JS_FreeValue(ctx, is_main);
    JS_FreeValue(ctx, global);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Bytecode roundtrip preserves filename for dynamic import" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    const char* filename = "/app/main.js";
    const char* code = "var x = 1;";

    /* Compile to bytecode */
    JSValue compiled = JS_Eval(ctx, code, strlen(code), filename,
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    CHECK_MESSAGE(!JS_IsException(compiled), "Compilation should succeed");

    /* Serialize with STRIP_SOURCE but NOT STRIP_DEBUG — filenames must survive
       for dynamic import() to resolve relative specifiers (regression test for
       "no function filename for import()" bug) */
    size_t bytecode_len;
    int flags = JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_STRIP_SOURCE;
    uint8_t* bytecode = JS_WriteObject(ctx, &bytecode_len, compiled, flags);
    JS_FreeValue(ctx, compiled);
    CHECK_MESSAGE(bytecode != nullptr, "JS_WriteObject should produce bytecode");

    /* Load from bytecode and verify the module name is preserved */
    JSValue loaded = JS_ReadObject(ctx, bytecode, bytecode_len, JS_READ_OBJ_BYTECODE);
    js_free(ctx, bytecode);
    CHECK_MESSAGE(!JS_IsException(loaded), "JS_ReadObject should succeed");
    CHECK_MESSAGE(JS_VALUE_GET_TAG(loaded) == JS_TAG_MODULE, "Should be a module");

    JSModuleDef* m = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(loaded));
    JSAtom name_atom = JS_GetModuleName(ctx, m);
    const char* name = JS_AtomToCString(ctx, name_atom);
    JS_FreeAtom(ctx, name_atom);
    CHECK_MESSAGE(name != nullptr, "Module name should not be NULL");
    CHECK_EQ(std::string(filename), std::string(name));
    JS_FreeCString(ctx, name);

    JS_FreeValue(ctx, loaded);

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

/* ─── mik__unload_module tests ──────────────────────────────────────── */

/* Drive a dynamic import to completion so the target module gets registered
 * in the context's loaded-modules list. Stashes the imported namespace at
 * globalThis.__ns so the test can hold a ref or drop it. */
static void dyn_import(JSContext* ctx, const std::string& path, const char* stash) {
    std::string src =
        "import('" + path + "').then(m => { globalThis." + stash + " = m; },"
        " e => { globalThis.__ie = String(e) + '\\n' + (e && e.stack || ''); });";
    JSValue rv = JS_Eval(ctx, src.c_str(), src.size(), "/test/driver.js",
                         JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[dyn_import eval] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, exc);
    }
    JS_FreeValue(ctx, rv);
    mik__execute_jobs(ctx);
}

static bool is_loaded(JSContext* ctx, const std::string& name) {
    JSAtom a = JS_NewAtom(ctx, name.c_str());
    JSModuleDef* m = JS_FindLoadedModule(ctx, a);
    JS_FreeAtom(ctx, a);
    return m != nullptr;
}

TEST_CASE("unload: removes a leaf module from loaded_modules"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string leaf = dir.write("leaf.js", "export const v = 42;\n");

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    dyn_import(ctx, leaf, "__ns1");
    REQUIRE(is_loaded(ctx, leaf));

    /* Drop the stashed namespace so nothing holds the module alive */
    const char* clear = "globalThis.__ns1 = undefined;";
    JSValue r = JS_Eval(ctx, clear, strlen(clear), "<clear>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r);

    CHECK_EQ(1, mik__unload_module(ctx, leaf.c_str()));
    CHECK_FALSE(is_loaded(ctx, leaf));

    /* Re-import should succeed and register a fresh module. */
    dyn_import(ctx, leaf, "__ns2");
    CHECK(is_loaded(ctx, leaf));

    MIK_FreeRuntime(rt);
    unlink(leaf.c_str());
}

TEST_CASE("unload: recursively frees orphaned transitive deps"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string dep = dir.write("dep.js", "export const x = 1;\n");
    std::string root_src = std::string("import {x} from '") + dep + "';\n" +
                           "export const y = x + 1;\n";
    std::string root = dir.write("root.js", root_src.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    dyn_import(ctx, root, "__ns1");
    REQUIRE(is_loaded(ctx, root));
    REQUIRE(is_loaded(ctx, dep));

    const char* clear = "globalThis.__ns1 = undefined;";
    JSValue r = JS_Eval(ctx, clear, strlen(clear), "<clear>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r);

    CHECK_EQ(2, mik__unload_module(ctx, root.c_str()));
    CHECK_FALSE(is_loaded(ctx, root));
    CHECK_FALSE(is_loaded(ctx, dep));

    MIK_FreeRuntime(rt);
    unlink(dep.c_str());
    unlink(root.c_str());
}

TEST_CASE("unload: leaves shared deps alone" * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string shared = dir.write("shared.js", "export const v = 7;\n");
    std::string a_src = std::string("import {v} from '") + shared +
                        "'; export const av = v;\n";
    std::string b_src = std::string("import {v} from '") + shared +
                        "'; export const bv = v;\n";
    std::string a = dir.write("a.js", a_src.c_str());
    std::string b = dir.write("b.js", b_src.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    dyn_import(ctx, a, "__a");
    dyn_import(ctx, b, "__b");
    REQUIRE(is_loaded(ctx, shared));
    REQUIRE(is_loaded(ctx, a));
    REQUIRE(is_loaded(ctx, b));

    const char* clear = "globalThis.__a = undefined;";
    JSValue r = JS_Eval(ctx, clear, strlen(clear), "<clear>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r);

    CHECK_EQ(1, mik__unload_module(ctx, a.c_str()));
    CHECK_FALSE(is_loaded(ctx, a));
    CHECK(is_loaded(ctx, shared));   /* b still imports it */
    CHECK(is_loaded(ctx, b));

    MIK_FreeRuntime(rt);
    unlink(shared.c_str());
    unlink(a.c_str());
    unlink(b.c_str());
}

TEST_CASE("unload: rejects builtin prefixes" * doctest::test_suite("modules")) {
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    CHECK_EQ(-1, mik__unload_module(ctx, "mikrojs/fs"));
    JSValue exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    CHECK_EQ(-1, mik__unload_module(ctx, "native:sys"));
    exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    CHECK_EQ(-1, mik__unload_module(ctx, "mikrojs/sleep"));
    exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    MIK_FreeRuntime(rt);
}

TEST_CASE("unload: rejects unknown module" * doctest::test_suite("modules")) {
    MIKRuntime* rt = MIK_NewRuntime();
    JSContext* ctx = MIK_GetJSContext(rt);

    CHECK_EQ(-1, mik__unload_module(ctx, "/no/such/module.js"));
    JSValue exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    MIK_FreeRuntime(rt);
}

TEST_CASE("unload: import.meta.unload evicts a dynamically imported module"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string leaf = dir.write("leaf.js", "export const v = 99;\n");
    std::string entry_src =
        "const a = await import('" + leaf + "');\n"
        "globalThis.__firstLoaded = a.v;\n"
        "await import.meta.unload('" + leaf + "');\n"
        "globalThis.__afterUnload = true;\n"
        "const b = await import('" + leaf + "');\n"
        "globalThis.__secondLoaded = b.v;\n";
    std::string entry = dir.write("entry.js", entry_src.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    /* Drive via a separate module so the entry itself is loaded through
     * the mikrojs loader (which attaches import.meta.unload). */
    std::string driver =
        "import('" + entry + "').then("
        "  () => { globalThis.__ok = 1; },"
        "  e => { globalThis.__err = String(e) + '\\n' + (e && e.stack || ''); });";
    JSValue rv = JS_Eval(ctx, driver.c_str(), driver.size(), "<driver>",
                         JS_EVAL_TYPE_MODULE);
    REQUIRE_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    mik__execute_jobs(ctx);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue err = JS_GetPropertyStr(ctx, g, "__err");
    if (!JS_IsUndefined(err)) {
        const char* s = JS_ToCString(ctx, err);
        if (s) {
            fprintf(stderr, "[im.unload caught] %s\n", s);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, err);
    JSValue first = JS_GetPropertyStr(ctx, g, "__firstLoaded");
    JSValue after = JS_GetPropertyStr(ctx, g, "__afterUnload");
    JSValue second = JS_GetPropertyStr(ctx, g, "__secondLoaded");
    int first_i = 0, second_i = 0;
    JS_ToInt32(ctx, &first_i, first);
    JS_ToInt32(ctx, &second_i, second);
    CHECK_EQ(99, first_i);
    CHECK_EQ(1, JS_ToBool(ctx, after));
    CHECK_EQ(99, second_i);
    JS_FreeValue(ctx, first);
    JS_FreeValue(ctx, after);
    JS_FreeValue(ctx, second);
    JS_FreeValue(ctx, g);

    MIK_FreeRuntime(rt);
    unlink(leaf.c_str());
    unlink(entry.c_str());
}

TEST_CASE("unload: import.meta.unload rejects non-string arg"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string entry = dir.write(
        "entry.js",
        "try { import.meta.unload(42); } catch (e) { globalThis.__msg = e.message; }\n");

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    std::string driver = "import('" + entry + "');";
    JSValue rv = JS_Eval(ctx, driver.c_str(), driver.size(), "<driver>",
                         JS_EVAL_TYPE_MODULE);
    REQUIRE_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    mik__execute_jobs(ctx);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue msg = JS_GetPropertyStr(ctx, g, "__msg");
    const char* s = JS_ToCString(ctx, msg);
    REQUIRE(s != nullptr);
    CHECK(std::string(s).find("specifier must be a string") != std::string::npos);
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, g);

    MIK_FreeRuntime(rt);
    unlink(entry.c_str());
}

TEST_CASE("unload: frees module body bytecode" * doctest::test_suite("modules")) {
    TmpDir dir;
    /* Large module body with inline string literals. After unload we expect
     * the bytecode-held data to be reclaimed. */
    std::string big;
    for (int i = 0; i < 500; i++) {
        big += "const s" + std::to_string(i) +
               " = 'padpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpad';\n";
    }
    big += "export const first = s0;\n";
    std::string mod = dir.write("big.js", big.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    JSMemoryUsage before;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &before);

    dyn_import(ctx, mod, "__ns");
    REQUIRE(is_loaded(ctx, mod));

    const char* clear = "globalThis.__ns = undefined;";
    JSValue r = JS_Eval(ctx, clear, strlen(clear), "<clear>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, r);

    CHECK_EQ(1, mik__unload_module(ctx, mod.c_str()));
    JS_RunGC(JS_GetRuntime(ctx));
    CHECK_FALSE(is_loaded(ctx, mod));

    JSMemoryUsage after;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &after);

    /* Heap shouldn't have grown by more than the driver + bookkeeping
     * overhead. Raw source payload is ~30 KB; anything under 15 KB means
     * the bulk of the module body bytecode was reclaimed. */
    size_t grew = after.malloc_size > before.malloc_size
                      ? (size_t)(after.malloc_size - before.malloc_size)
                      : 0;
    CHECK(grew < 15000);

    MIK_FreeRuntime(rt);
    unlink(mod.c_str());
}
TEST_CASE("Bytecode roundtrip: compile then load" * doctest::test_suite("modules")) {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    const char* code = "var x = 40 + 2;";

    /* Compile to bytecode */
    JSValue compiled = JS_Eval(ctx, code, strlen(code), "test.js",
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    CHECK_MESSAGE(!JS_IsException(compiled), "Compilation should succeed");

    size_t bytecode_len;
    uint8_t* bytecode = JS_WriteObject(ctx, &bytecode_len, compiled, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, compiled);
    CHECK_MESSAGE(bytecode != nullptr, "JS_WriteObject should produce bytecode");
    CHECK_MESSAGE(bytecode_len > 0, "Bytecode should not be empty");

    /* Load from bytecode */
    JSValue loaded = JS_ReadObject(ctx, bytecode, bytecode_len, JS_READ_OBJ_BYTECODE);
    js_free(ctx, bytecode);
    CHECK_MESSAGE(!JS_IsException(loaded), "JS_ReadObject should succeed");
    CHECK_MESSAGE(JS_VALUE_GET_TAG(loaded) == JS_TAG_MODULE, "Should be a module");

    /* Execute */
    JSValue result = JS_EvalFunction(ctx, loaded);
    CHECK_MESSAGE(!JS_IsException(result), "JS_EvalFunction should succeed");
    JS_FreeValue(ctx, result);

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

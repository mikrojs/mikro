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

    assert_normalizes_to(ctx, "main.js", "mikro/fs", "mikro/fs");
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

    CHECK_EQ(-1, mik__unload_module(ctx, "mikro/fs"));
    JSValue exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    CHECK_EQ(-1, mik__unload_module(ctx, "native:mikro/sys"));
    exc = JS_GetException(ctx);
    CHECK(JS_IsError(exc));
    JS_FreeValue(ctx, exc);

    CHECK_EQ(-1, mik__unload_module(ctx, "mikro/sleep"));
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

TEST_CASE("disposable: native helpers reject builtins and no-op on re-dispose"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string leaf = dir.write("leaf.js", "export const v = 7;\n");

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    dyn_import(ctx, leaf, "__ns");
    REQUIRE(is_loaded(ctx, leaf));
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue ns = JS_GetPropertyStr(ctx, g, "__ns");

    /* A file-backed module namespace is unloadable; disposing frees 1 module. */
    CHECK(mik__is_unloadable_namespace(ctx, ns));
    CHECK_EQ(1, mik__unload_namespace(ctx, ns));
    CHECK_FALSE(is_loaded(ctx, leaf));

    /* Re-dispose is a no-op: the module is gone from the registry. */
    CHECK_EQ(0, mik__unload_namespace(ctx, ns));

    /* Anchored namespaces (builtins) are not unloadable. mikro/result is a
     * core builtin that loads on host; importing it fully instantiates its
     * namespace. */
    dyn_import(ctx, "mikro/result", "__res");
    JSValue resns = JS_GetPropertyStr(ctx, g, "__res");
    REQUIRE(JS_IsObject(resns));
    CHECK_FALSE(mik__is_unloadable_namespace(ctx, resns));

    /* Non-object / non-namespace inputs are inert. */
    CHECK_FALSE(mik__is_unloadable_namespace(ctx, JS_UNDEFINED));
    CHECK_EQ(0, mik__unload_namespace(ctx, JS_NewInt32(ctx, 5)));

    JS_FreeValue(ctx, resns);
    JS_FreeValue(ctx, ns);
    JS_FreeValue(ctx, g);
    MIK_FreeRuntime(rt);
    unlink(leaf.c_str());
}

TEST_CASE("withUnload: real mikro/module export unloads (e2e)"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string leaf = dir.write(
        "leaf.js",
        "globalThis.__leafEvals = (globalThis.__leafEvals || 0) + 1;\n"
        "export const v = 99;\n");
    /* The real shipped withUnload() from mikro/module — no inlined
     * copy. mikro/module imports only native:mikro/sys (pure C, host-available), so
     * unlike mikro/sys it needs no native:mikro/sleep stub. */
    std::string entry_src =
        "import {withUnload} from 'mikro/module';\n"
        "globalThis.__firstLoaded = await withUnload(import('" + leaf + "'), m => m.v);\n"
        "globalThis.__afterDispose = true;\n"
        "const b = await import('" + leaf + "');\n"
        "globalThis.__secondLoaded = b.v;\n";
    std::string entry = dir.write("entry.js", entry_src.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    std::string driver =
        "import('" + entry + "').then("
        "  () => { globalThis.__ok = 1; },"
        "  e => { globalThis.__err = String(e) + '\\n' + (e && e.stack || ''); });";
    JSValue rv = JS_Eval(ctx, driver.c_str(), driver.size(), "<driver>", JS_EVAL_TYPE_MODULE);
    REQUIRE_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    mik__execute_jobs(ctx);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue err = JS_GetPropertyStr(ctx, g, "__err");
    if (!JS_IsUndefined(err)) {
        const char* s = JS_ToCString(ctx, err);
        if (s) {
            fprintf(stderr, "[disposable e2e caught] %s\n", s);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, err);
    JSValue first = JS_GetPropertyStr(ctx, g, "__firstLoaded");
    JSValue after = JS_GetPropertyStr(ctx, g, "__afterDispose");
    JSValue second = JS_GetPropertyStr(ctx, g, "__secondLoaded");
    JSValue evals = JS_GetPropertyStr(ctx, g, "__leafEvals");
    int first_i = 0, second_i = 0, evals_i = 0;
    JS_ToInt32(ctx, &first_i, first);
    JS_ToInt32(ctx, &second_i, second);
    JS_ToInt32(ctx, &evals_i, evals);
    CHECK_EQ(99, first_i);
    CHECK_EQ(1, JS_ToBool(ctx, after));
    CHECK_EQ(99, second_i);
    CHECK_EQ(2, evals_i); /* re-evaluated → real unload through the shipped export */
    JS_FreeValue(ctx, first);
    JS_FreeValue(ctx, after);
    JS_FreeValue(ctx, second);
    JS_FreeValue(ctx, evals);
    JS_FreeValue(ctx, g);

    MIK_FreeRuntime(rt);
    unlink(leaf.c_str());
    unlink(entry.c_str());
}

TEST_CASE("withUnload: unloads even when the callback throws"
          * doctest::test_suite("modules")) {
    TmpDir dir;
    std::string leaf = dir.write(
        "leaf.js",
        "globalThis.__leafEvals = (globalThis.__leafEvals || 0) + 1;\n"
        "export const v = 7;\n");
    /* The callback throws; withUnload's finally must still unload the module,
     * and the rejection must propagate to the caller. */
    std::string entry_src =
        "import {withUnload} from 'mikro/module';\n"
        "try {\n"
        "  await withUnload(import('" + leaf + "'), () => { throw new Error('boom'); });\n"
        "} catch (e) {\n"
        "  globalThis.__caught = e.message;\n"
        "}\n"
        "const b = await import('" + leaf + "');\n"
        "globalThis.__reloaded = b.v;\n";
    std::string entry = dir.write("entry.js", entry_src.c_str());

    MIKRuntime* rt = MIK_NewRuntime();
    MIK_SetFSBasePath(rt, "");
    JSContext* ctx = MIK_GetJSContext(rt);

    std::string driver =
        "import('" + entry + "').then("
        "  () => { globalThis.__ok = 1; },"
        "  e => { globalThis.__err = String(e) + '\\n' + (e && e.stack || ''); });";
    JSValue rv = JS_Eval(ctx, driver.c_str(), driver.size(), "<driver>", JS_EVAL_TYPE_MODULE);
    REQUIRE_FALSE(JS_IsException(rv));
    JS_FreeValue(ctx, rv);
    mik__execute_jobs(ctx);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue err = JS_GetPropertyStr(ctx, g, "__err");
    if (!JS_IsUndefined(err)) {
        const char* s = JS_ToCString(ctx, err);
        if (s) {
            fprintf(stderr, "[withUnload throw e2e caught] %s\n", s);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, err);

    /* The callback's error reached the caller. */
    JSValue caught = JS_GetPropertyStr(ctx, g, "__caught");
    const char* cs = JS_ToCString(ctx, caught);
    REQUIRE(cs != nullptr);
    CHECK_EQ(std::string("boom"), std::string(cs));
    JS_FreeCString(ctx, cs);
    JS_FreeValue(ctx, caught);

    /* Re-import re-evaluated the module → it was unloaded despite the throw. */
    JSValue evals = JS_GetPropertyStr(ctx, g, "__leafEvals");
    JSValue reloaded = JS_GetPropertyStr(ctx, g, "__reloaded");
    int evals_i = 0, reloaded_i = 0;
    JS_ToInt32(ctx, &evals_i, evals);
    JS_ToInt32(ctx, &reloaded_i, reloaded);
    CHECK_EQ(2, evals_i);
    CHECK_EQ(7, reloaded_i);
    JS_FreeValue(ctx, evals);
    JS_FreeValue(ctx, reloaded);
    JS_FreeValue(ctx, g);

    MIK_FreeRuntime(rt);
    unlink(leaf.c_str());
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

/* Regression coverage for quickjs patch 0002 (free m->func_obj once a
 * module reaches EVALUATED): the async completion paths and the cached
 * eval-exception path each release the init function through a different
 * hunk, and none of them were exercised anywhere in the repo before. */

/* Multiple fixed rounds rather than until-settled: the entry promise can
 * fulfill before a dynamic import() chain it kicked off has pumped. Extra
 * rounds are no-ops once the queue is empty. */
static void drain_jobs(JSContext* ctx) {
    for (int i = 0; i < 10; i++) {
        mik__execute_jobs(ctx);
    }
}

TEST_CASE("TLA module evaluates once and stays importable after completion" *
          doctest::test_suite("modules")) {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* dep =
        "globalThis.__tlaRuns = (globalThis.__tlaRuns || 0) + 1;\n"
        "export const v = await Promise.resolve(41);\n";
    MIK_RegisterVirtualModule(mik_rt, "/test/tla.js", dep, strlen(dep));

    const char* entry1 = "import {v} from '/test/tla.js'; globalThis.__v1 = v;";
    JSValue p1 = MIK_EvalModuleContent(ctx, "/test/main1.js", entry1, strlen(entry1));
    CHECK_FALSE(JS_IsException(p1));
    drain_jobs(ctx);
    CHECK_EQ(JS_PromiseState(ctx, p1), JS_PROMISE_FULFILLED);
    JS_FreeValue(ctx, p1);

    /* Second entry statically imports the already-EVALUATED TLA module:
     * bindings must resolve from the export var_refs, with the init
     * function long gone and the body not re-run. */
    const char* entry2 = "import {v} from '/test/tla.js'; globalThis.__v2 = v + 1;";
    JSValue p2 = MIK_EvalModuleContent(ctx, "/test/main2.js", entry2, strlen(entry2));
    CHECK_FALSE(JS_IsException(p2));
    drain_jobs(ctx);
    CHECK_EQ(JS_PromiseState(ctx, p2), JS_PROMISE_FULFILLED);
    JS_FreeValue(ctx, p2);

    JSValue global = JS_GetGlobalObject(ctx);
    int32_t v1 = 0, v2 = 0, runs = 0;
    JSValue jv1 = JS_GetPropertyStr(ctx, global, "__v1");
    JSValue jv2 = JS_GetPropertyStr(ctx, global, "__v2");
    JSValue jruns = JS_GetPropertyStr(ctx, global, "__tlaRuns");
    JS_ToInt32(ctx, &v1, jv1);
    JS_ToInt32(ctx, &v2, jv2);
    JS_ToInt32(ctx, &runs, jruns);
    CHECK_EQ(v1, 41);
    CHECK_EQ(v2, 42);
    CHECK_MESSAGE(runs == 1, "TLA module body must run exactly once");
    JS_FreeValue(ctx, jv1);
    JS_FreeValue(ctx, jv2);
    JS_FreeValue(ctx, jruns);
    JS_FreeValue(ctx, global);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Rejected TLA module reports the cached exception on re-import" *
          doctest::test_suite("modules")) {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* dep =
        "globalThis.__badRuns = (globalThis.__badRuns || 0) + 1;\n"
        "await Promise.reject(new Error('tla-nope'));\n";
    MIK_RegisterVirtualModule(mik_rt, "/test/tla-bad.js", dep, strlen(dep));

    /* Dynamic import so the rejection is handled in JS and the test can
     * read the message instead of fighting the unhandled-rejection hook. */
    const char* entry1 =
        "import('/test/tla-bad.js').catch(e => { globalThis.__e1 = e.message; });";
    JSValue p1 = MIK_EvalModuleContent(ctx, "/test/main1.js", entry1, strlen(entry1));
    CHECK_FALSE(JS_IsException(p1));
    drain_jobs(ctx);
    JS_FreeValue(ctx, p1);

    const char* entry2 =
        "import('/test/tla-bad.js').catch(e => { globalThis.__e2 = e.message; });";
    JSValue p2 = MIK_EvalModuleContent(ctx, "/test/main2.js", entry2, strlen(entry2));
    CHECK_FALSE(JS_IsException(p2));
    drain_jobs(ctx);
    JS_FreeValue(ctx, p2);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue e1 = JS_GetPropertyStr(ctx, global, "__e1");
    JSValue e2 = JS_GetPropertyStr(ctx, global, "__e2");
    const char* s1 = JS_ToCString(ctx, e1);
    const char* s2 = JS_ToCString(ctx, e2);
    const bool s1_ok_tla_nope = s1 != nullptr && strcmp(s1, "tla-nope") == 0;
    CHECK_MESSAGE(s1_ok_tla_nope, "First import must reject with the TLA error");
    const bool s2_ok_tla_nope = s2 != nullptr && strcmp(s2, "tla-nope") == 0;
    CHECK_MESSAGE(s2_ok_tla_nope, "Re-import must reject with the cached exception");
    int32_t runs = 0;
    JSValue jruns = JS_GetPropertyStr(ctx, global, "__badRuns");
    JS_ToInt32(ctx, &runs, jruns);
    CHECK_MESSAGE(runs == 1, "Failed TLA module body must not re-run");
    JS_FreeCString(ctx, s1);
    JS_FreeCString(ctx, s2);
    JS_FreeValue(ctx, e1);
    JS_FreeValue(ctx, e2);
    JS_FreeValue(ctx, jruns);
    JS_FreeValue(ctx, global);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Module that throws at top level caches the error across imports" *
          doctest::test_suite("modules")) {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* dep =
        "globalThis.__boomRuns = (globalThis.__boomRuns || 0) + 1;\n"
        "throw new Error('boom');\n";
    MIK_RegisterVirtualModule(mik_rt, "/test/boom.js", dep, strlen(dep));

    const char* entry1 =
        "import('/test/boom.js').catch(e => { globalThis.__e1 = e.message; });";
    JSValue p1 = MIK_EvalModuleContent(ctx, "/test/main1.js", entry1, strlen(entry1));
    CHECK_FALSE(JS_IsException(p1));
    drain_jobs(ctx);
    JS_FreeValue(ctx, p1);

    const char* entry2 =
        "import('/test/boom.js').catch(e => { globalThis.__e2 = e.message; });";
    JSValue p2 = MIK_EvalModuleContent(ctx, "/test/main2.js", entry2, strlen(entry2));
    CHECK_FALSE(JS_IsException(p2));
    drain_jobs(ctx);
    JS_FreeValue(ctx, p2);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue e1 = JS_GetPropertyStr(ctx, global, "__e1");
    JSValue e2 = JS_GetPropertyStr(ctx, global, "__e2");
    const char* s1 = JS_ToCString(ctx, e1);
    const char* s2 = JS_ToCString(ctx, e2);
    const bool s1_ok_boom = s1 != nullptr && strcmp(s1, "boom") == 0;
    CHECK_MESSAGE(s1_ok_boom, "First import must reject with the thrown error");
    const bool s2_ok_boom = s2 != nullptr && strcmp(s2, "boom") == 0;
    CHECK_MESSAGE(s2_ok_boom, "Re-import must reject with the cached error, not re-run the body");
    int32_t runs = 0;
    JSValue jruns = JS_GetPropertyStr(ctx, global, "__boomRuns");
    JS_ToInt32(ctx, &runs, jruns);
    CHECK_MESSAGE(runs == 1, "Throwing module body must run exactly once");
    JS_FreeCString(ctx, s1);
    JS_FreeCString(ctx, s2);
    JS_FreeValue(ctx, e1);
    JS_FreeValue(ctx, e2);
    JS_FreeValue(ctx, jruns);
    JS_FreeValue(ctx, global);

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Builtin bytecode loads zero-copy via the frozen atom table" *
          doctest::test_suite("modules")) {
    /* Every failure mode in the frozen-atom pipeline degrades silently to
     * the classic copying loader (empty table, version mismatch, INPLACE
     * fallback): builds stay green and only the memory win disappears.
     * This pins the path end-to-end: importing a builtin must add real
     * functions while adding (almost) no heap-resident bytecode, which is
     * only true when the instruction streams stay in rodata. mikro/schema
     * carries well over 1 KB of opcodes, so a silent fallback trips the
     * threshold with a wide margin. */
    MIKRuntime* mik_rt = MIK_NewRuntime();
    REQUIRE(mik_rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(mik_rt);
    JSRuntime* rt = JS_GetRuntime(ctx);

    JSMemoryUsage before;
    JS_ComputeMemoryUsage(rt, &before);

    const char* code = "import 'mikro/schema';";
    JSValue ret = MIK_EvalModuleContent(ctx, "/test/main.js", code, strlen(code));
    CHECK_MESSAGE(!JS_IsException(ret), "builtin import should not throw");
    JS_FreeValue(ctx, ret);
    drain_jobs(ctx);

    JSMemoryUsage after;
    JS_ComputeMemoryUsage(rt, &after);

    CHECK_MESSAGE(after.js_func_count > before.js_func_count,
                  "importing the builtin must actually load functions");
    const int64_t code_growth = after.js_func_code_size - before.js_func_code_size;
    CHECK_MESSAGE(code_growth < 256,
                  "builtin instruction streams must stay in rodata (zero-copy), got "
                      << code_growth << " bytes of heap bytecode");

    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("Device bytecode-version probe reports classic despite the frozen table" *
          doctest::test_suite("modules")) {
    /* mikro/sys reports the device's app-bytecode version to the OTA
     * registry by serializing a trivial value and reading byte 0; packs
     * built by the CLI are classic-format, so a frozen-format answer makes
     * the registry reject every push. A blob with no frozen-atom
     * references and no atom table must stay classic (26); anything that
     * carries atoms from a frozen runtime must keep the frozen header. */
    MIKRuntime* mik_rt = MIK_NewRuntime();
    REQUIRE(mik_rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(mik_rt);

    size_t len = 0;
    uint8_t* buf = JS_WriteObject(ctx, &len, JS_NULL, JS_WRITE_OBJ_BYTECODE);
    REQUIRE(buf != nullptr);
    REQUIRE(len > 0);
    CHECK_MESSAGE(buf[0] == 26, "trivial probe blob must be classic-format");
    js_free(ctx, buf);

    const char* code = "export function probe() { return 1; }";
    JSValue compiled = JS_Eval(ctx, code, strlen(code), "/probe.js",
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    REQUIRE(!JS_IsException(compiled));
    uint8_t* mod = JS_WriteObject(ctx, &len, compiled, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, compiled);
    REQUIRE(mod != nullptr);
    CHECK_MESSAGE(mod[0] == (26 | 0x40),
                  "atom-carrying blobs from a frozen runtime must keep the frozen header");
    js_free(ctx, mod);

    MIK_FreeRuntime(mik_rt);
}

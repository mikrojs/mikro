#include <string.h>

#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

TEST_CASE("import.meta.dirname for absolute path module", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__dirname = import.meta.dirname;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/appfs/lib/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue dirname = JS_GetPropertyStr(ctx, global, "__dirname");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsString(dirname), "Expected __dirname to be a string");

    const char* str = JS_ToCString(ctx, dirname);
    TEST_ASSERT_EQUAL_STRING("/appfs/lib", str);
    JS_FreeCString(ctx, str);

    JS_FreeValue(ctx, dirname);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("import.meta.basename for absolute path module", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__basename = import.meta.basename;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/appfs/lib/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue basename = JS_GetPropertyStr(ctx, global, "__basename");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsString(basename), "Expected __basename to be a string");

    const char* str = JS_ToCString(ctx, basename);
    TEST_ASSERT_EQUAL_STRING("main.js", str);
    JS_FreeCString(ctx, str);

    JS_FreeValue(ctx, basename);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("import.meta.path for absolute path module", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__path = import.meta.path;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/appfs/lib/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue path = JS_GetPropertyStr(ctx, global, "__path");
    TEST_ASSERT_TRUE_MESSAGE(JS_IsString(path), "Expected __path to be a string");

    const char* str = JS_ToCString(ctx, path);
    TEST_ASSERT_EQUAL_STRING("/appfs/lib/main.js", str);
    JS_FreeCString(ctx, str);

    JS_FreeValue(ctx, path);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("import.meta.url has file:// prefix", "[modules]") {
    const auto mik_rt = MIK_NewRuntime();
    const auto ctx = MIK_GetJSContext(mik_rt);

    const char* code = "globalThis.__url = import.meta.url;";
    JSValue ret = MIK_EvalModuleContent(ctx, "/appfs/main.js", code, strlen(code));
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");
    JS_FreeValue(ctx, ret);

    mik__execute_jobs(ctx);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue url = JS_GetPropertyStr(ctx, global, "__url");
    const char* str = JS_ToCString(ctx, url);
    TEST_ASSERT_EQUAL_STRING("file:///appfs/main.js", str);
    JS_FreeCString(ctx, str);

    JS_FreeValue(ctx, url);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(mik_rt);
}

TEST_CASE("native:* internal import blocked from user code", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    // User code at "/appfs/main.js" should NOT be able to import native:mikro/sys
    char* result = mik_module_normalizer(ctx, "/appfs/main.js", "native:mikro/sys", nullptr);
    TEST_ASSERT_NULL_MESSAGE(result, "native:mikro/sys should be blocked from user code");

    // But a built-in module should be allowed to import native:mikro/sys
    result = mik_module_normalizer(ctx, "mikro/sys", "native:mikro/sys", nullptr);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "native:mikro/sys should be allowed from mikro/ modules");
    TEST_ASSERT_EQUAL_STRING("native:mikro/sys", result);
    js_free(ctx, result);

    // native: modules should also be allowed to import other native:* modules
    result = mik_module_normalizer(ctx, "native:mikro/sys", "native:mikro/stdio", nullptr);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "native:mikro/stdio should be allowed from native: modules");
    js_free(ctx, result);

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

TEST_CASE("Module normalization: root file with no dir", "[modules]") {
    JSRuntime* rt = JS_NewRuntime();
    JSContext* ctx = JS_NewContext(rt);

    // Edge case: base has no directory component
    char* result = mik_module_normalizer(ctx, "main.js", "./utils.js", nullptr);
    TEST_ASSERT_NOT_NULL(result);
    TEST_ASSERT_EQUAL_STRING("utils.js", result);
    js_free(ctx, result);

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

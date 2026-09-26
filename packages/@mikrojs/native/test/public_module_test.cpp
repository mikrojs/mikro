#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

namespace {

std::string pending_exception_message(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    const char* s = JS_ToCString(ctx, exc);
    std::string msg = s != nullptr ? s : "";
    if (s != nullptr) {
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, exc);
    return msg;
}

}  // namespace

/* A package's C module under its public specifier (MIK_REGISTER_PUBLIC_MODULE):
 * app code imports it by bare name, with no JS layer and no native: name. */
static int mik__test_public_module_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExport(ctx, m, "answer", JS_NewInt32(ctx, 42));
}

static JSModuleDef* mik__test_public_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "@acme/pi/pi", mik__test_public_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "answer");
    return m;
}

TEST_CASE("app code imports a package's public C module by its specifier" *
          doctest::test_suite("modules")) {
    mik_module_desc_t desc = {"@acme/pi/pi", mik__test_public_init, nullptr, nullptr,
                              mik__module_registry_head};
    mik__module_registry_head = &desc;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    /* Imported from a nested dependency: no node_modules lookup takes place. */
    const char* code = "import {answer} from '@acme/pi/pi'\n"
                       "globalThis.__answer = answer\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/node_modules/board/display.js", code,
                                        strlen(code));
    if (JS_IsException(ret)) {
        FAIL_CHECK("eval threw: " << pending_exception_message(ctx));
    }
    JS_FreeValue(ctx, ret);
    MIK_Loop(rt);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue answer = JS_GetPropertyStr(ctx, global, "__answer");
    int32_t value = 0;
    JS_ToInt32(ctx, &value, answer);
    CHECK_EQ(42, value);
    JS_FreeValue(ctx, answer);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(rt);
    mik__module_registry_head = desc.next;
}

/* An app's own C module, which the app imports with a "#" specifier from its
 * package.json "imports": registered under that name as it is. */
static JSModuleDef* mik__test_app_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "#native/fx", mik__test_public_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "answer");
    return m;
}

TEST_CASE("app code imports its own C module by its # specifier" *
          doctest::test_suite("modules")) {
    mik_module_desc_t desc = {"#native/fx", mik__test_app_init, nullptr, nullptr,
                              mik__module_registry_head};
    mik__module_registry_head = &desc;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    const char* code = "import {answer} from '#native/fx'\n"
                       "globalThis.__answer = answer\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/main.js", code, strlen(code));
    if (JS_IsException(ret)) {
        FAIL_CHECK("eval threw: " << pending_exception_message(ctx));
    }
    JS_FreeValue(ctx, ret);
    MIK_Loop(rt);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue answer = JS_GetPropertyStr(ctx, global, "__answer");
    int32_t value = 0;
    JS_ToInt32(ctx, &value, answer);
    CHECK_EQ(42, value);
    JS_FreeValue(ctx, answer);
    JS_FreeValue(ctx, global);
    MIK_FreeRuntime(rt);
    mik__module_registry_head = desc.next;
}

static int s_destroy_only_calls = 0;
static void mik__test_destroy_only(JSContext* ctx) { s_destroy_only_calls++; }

/* A module with hardware to release at teardown but nothing to poll: the
 * loader must register its destroy hook even though it has no consumer. */
TEST_CASE("a registered module's destroy hook runs without a consume hook" *
          doctest::test_suite("modules")) {
    mik_module_desc_t desc = {"@acme/pi/pi", mik__test_public_init, nullptr,
                              mik__test_destroy_only, mik__module_registry_head};
    mik__module_registry_head = &desc;
    s_destroy_only_calls = 0;

    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);
    const char* code = "import '@acme/pi/pi'\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/main.js", code, strlen(code));
    if (JS_IsException(ret)) {
        FAIL_CHECK("eval threw: " << pending_exception_message(ctx));
    }
    JS_FreeValue(ctx, ret);
    MIK_Loop(rt);
    CHECK_EQ(0, s_destroy_only_calls);
    MIK_FreeRuntime(rt);
    CHECK_EQ(1, s_destroy_only_calls);
    mik__module_registry_head = desc.next;
}

TEST_CASE("app code cannot import native: modules directly" *
          doctest::test_suite("modules")) {
    auto* rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(rt);

    const char* code = "import * as sys from 'native:mikro/sys'\n";
    JSValue ret = MIK_EvalModuleContent(ctx, "/app/main.js", code, strlen(code));
    CHECK(JS_IsException(ret));
    JS_FreeValue(ctx, ret);
    std::string msg = pending_exception_message(ctx);
    CHECK_MESSAGE(msg.find("can only be imported by firmware builtins") != std::string::npos,
                  "unexpected error: " << msg);
    MIK_FreeRuntime(rt);
}

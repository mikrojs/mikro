#include <nvs_flash.h>

#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* nvs_kv module is self-registered via MIK_REGISTER_MODULE and lazily
 * initialized. These tests cover the mik.kv / mik.sys namespace split on
 * real NVS flash; each test clears both namespaces it touched. */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    /* The bare test runtime has no MIK_Main; init NVS flash once ourselves. */
    static bool nvs_ready = false;
    if (!nvs_ready) {
        esp_err_t err = nvs_flash_init();
        if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
            nvs_flash_erase();
            nvs_flash_init();
        }
        nvs_ready = true;
    }
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    /* The name must pass the loader's builtin-importer check ("mikro/" prefix)
     * or native: imports are denied. */
    JSValue ret = MIK_EvalModuleContent(ctx, "mikro/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    } else {
        JSValue exc = JS_GetException(ctx);
        const char* msg = JS_ToCString(ctx, exc);
        printf("eval exception: %s\n", msg ? msg : "(unprintable)");
        JS_FreeCString(ctx, msg);
        JS_Throw(ctx, exc);
    }
    return ret;
}

/* ── Module exports ───────────────────────────────────────────────── */

TEST_CASE("native:mikro/nvs_kv exports sys functions and Result-returning clears", "[kv]") {
    setup();

    JSValue ret = eval_module(R"(
        import { clear, sysSet, sysGet, sysRemove, sysClear } from "native:mikro/nvs_kv";
        globalThis.__sysSetIsFunc = typeof sysSet === "function";
        globalThis.__sysGetIsFunc = typeof sysGet === "function";
        globalThis.__sysRemoveIsFunc = typeof sysRemove === "function";
        globalThis.__sysClearIsFunc = typeof sysClear === "function";
        globalThis.__clearOk = clear().ok === true;
        globalThis.__sysClearOk = sysClear().ok === true;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__sysSetIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysSet should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysGetIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysGet should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysRemoveIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysRemove should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysClearIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysClear should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__clearOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear() should return {ok: true}");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysClearOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysClear() should return {ok: true}");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Namespace isolation ──────────────────────────────────────────── */

TEST_CASE("native:mikro/nvs_kv kv and sys namespaces are isolated", "[kv]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, remove, clear, sysSet, sysGet, sysRemove, sysClear }
            from "native:mikro/nvs_kv";
        clear();
        sysClear();
        set("probe", "app");
        sysSet("probe", "sys");
        globalThis.__kvSees = get("probe") === "app";
        globalThis.__sysSees = sysGet("probe") === "sys";
        remove("probe");
        globalThis.__kvGone = get("probe") === undefined;
        globalThis.__sysSurvivesRemove = sysGet("probe") === "sys";
        sysRemove("probe");
        globalThis.__sysGone = sysGet("probe") === undefined;
        clear();
        sysClear();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__kvSees");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "kv should read its own value under a shared key");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysSees");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sys should read its own value under a shared key");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__kvGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "remove should delete the kv entry");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysSurvivesRemove");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "kv remove must not touch the sys entry");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysRemove should delete the sys entry");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Clear scopes ─────────────────────────────────────────────────── */

TEST_CASE("native:mikro/nvs_kv clear() leaves sys, sysClear() leaves kv", "[kv]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, clear, sysSet, sysGet, sysClear } from "native:mikro/nvs_kv";
        clear();
        sysClear();
        set("a", 1);
        sysSet("b", 2);
        clear();
        globalThis.__kvGone = get("a") === undefined;
        globalThis.__sysIntact = sysGet("b") === 2;
        set("a", 1);
        sysClear();
        globalThis.__kvIntact = get("a") === 1;
        globalThis.__sysGone = sysGet("b") === undefined;
        clear();
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__kvGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear should empty the kv namespace");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysIntact");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear must not touch the sys namespace");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__kvIntact");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysClear must not touch the kv namespace");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "sysClear should empty the sys namespace");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── Public API full clear ────────────────────────────────────────── */

TEST_CASE("mikro/kv/nvs clear({full: true}) empties both stores", "[kv]") {
    setup();

    JSValue ret = eval_module(R"(
        import { nvsStorage } from "mikro/kv/nvs";
        import { set, get, clear, sysSet, sysGet, sysClear } from "native:mikro/nvs_kv";
        clear();
        sysClear();
        set("a", 1);
        sysSet("b", 2);
        const partial = nvsStorage.clear();
        globalThis.__partialOk = partial.ok === true;
        globalThis.__kvAfterPartial = get("a") === undefined;
        globalThis.__sysAfterPartial = sysGet("b") === 2;
        set("a", 1);
        const full = nvsStorage.clear({full: true});
        globalThis.__fullOk = full.ok === true;
        globalThis.__kvAfterFull = get("a") === undefined;
        globalThis.__sysAfterFull = sysGet("b") === undefined;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__partialOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear() should return ok");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__kvAfterPartial");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear() should empty app data");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysAfterPartial");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear() must leave the system store intact");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__fullOk");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear({full: true}) should return ok");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__kvAfterFull");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear({full: true}) should empty app data");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__sysAfterFull");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear({full: true}) should empty the system store");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

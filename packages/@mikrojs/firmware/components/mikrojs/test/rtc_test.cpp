#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* RTC module is self-registered via MIK_REGISTER_MODULE and lazily initialized */

static MIKRuntime* rt;
static JSContext* ctx;

static void setup() {
    rt = MIK_NewRuntime();
    ctx = MIK_GetJSContext(rt);
}

static void teardown() { MIK_FreeRuntime(rt); }

static JSValue eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(ctx, ret);
        mik__execute_jobs(ctx);
    }
    return ret;
}

/* ── Module structure tests ───────────────────────────────────────── */

TEST_CASE("native:rtc exports set, get, remove, clear, info", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, remove, clear, info } from "native:rtc";
        globalThis.__setIsFunc = typeof set === "function";
        globalThis.__getIsFunc = typeof get === "function";
        globalThis.__removeIsFunc = typeof remove === "function";
        globalThis.__clearIsFunc = typeof clear === "function";
        globalThis.__infoIsFunc = typeof info === "function";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__setIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "set should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__getIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "get should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__removeIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "remove should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__clearIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "clear should be a function");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__infoIsFunc");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "info should be a function");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── set/get round-trip ───────────────────────────────────────────── */

TEST_CASE("native:rtc set/get round-trip", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, clear } from "native:rtc";
        clear();
        set("hello", "world");
        globalThis.__result = get("hello");
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result = JS_GetPropertyStr(ctx, global, "__result");
    const char* str = JS_ToCString(ctx, result);
    TEST_ASSERT_EQUAL_STRING("world", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── get returns undefined for missing key ────────────────────────── */

TEST_CASE("native:rtc get returns undefined for missing key", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { get, clear } from "native:rtc";
        clear();
        globalThis.__result = get("nonexistent");
        globalThis.__isUndef = get("nonexistent") === undefined;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue isUndef = JS_GetPropertyStr(ctx, global, "__isUndef");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, isUndef), "get should return undefined for missing key");
    JS_FreeValue(ctx, isUndef);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── remove deletes entry ─────────────────────────────────────────── */

TEST_CASE("native:rtc remove deletes entry", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, remove, clear } from "native:rtc";
        clear();
        set("key1", "val1");
        set("key2", "val2");
        const removed = remove("key1");
        globalThis.__removed = removed;
        globalThis.__key1Gone = get("key1") === undefined;
        globalThis.__key2Still = get("key2") === "val2";
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue removed = JS_GetPropertyStr(ctx, global, "__removed");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, removed), "remove should return true");
    JS_FreeValue(ctx, removed);

    JSValue key1Gone = JS_GetPropertyStr(ctx, global, "__key1Gone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, key1Gone), "key1 should be gone after remove");
    JS_FreeValue(ctx, key1Gone);

    JSValue key2Still = JS_GetPropertyStr(ctx, global, "__key2Still");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, key2Still), "key2 should still exist");
    JS_FreeValue(ctx, key2Still);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── remove returns false for missing key ─────────────────────────── */

TEST_CASE("native:rtc remove returns false for missing key", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { remove, clear } from "native:rtc";
        clear();
        globalThis.__result = remove("nonexistent");
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result = JS_GetPropertyStr(ctx, global, "__result");
    TEST_ASSERT_FALSE_MESSAGE(JS_ToBool(ctx, result), "remove should return false for missing key");
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, global);
    teardown();
}

/* ── clear removes all entries ────────────────────────────────────── */

TEST_CASE("native:rtc clear removes all entries", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, clear, info } from "native:rtc";
        clear();
        set("a", "1");
        set("b", "2");
        clear();
        globalThis.__aGone = get("a") === undefined;
        globalThis.__bGone = get("b") === undefined;
        const i = info();
        globalThis.__entries = i.entries;
        globalThis.__used = i.used;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue aGone = JS_GetPropertyStr(ctx, global, "__aGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, aGone), "a should be gone after clear");
    JS_FreeValue(ctx, aGone);

    JSValue bGone = JS_GetPropertyStr(ctx, global, "__bGone");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, bGone), "b should be gone after clear");
    JS_FreeValue(ctx, bGone);

    JSValue entries = JS_GetPropertyStr(ctx, global, "__entries");
    int32_t count;
    JS_ToInt32(ctx, &count, entries);
    TEST_ASSERT_EQUAL_INT(0, count);
    JS_FreeValue(ctx, entries);

    JSValue used = JS_GetPropertyStr(ctx, global, "__used");
    int32_t used_val;
    JS_ToInt32(ctx, &used_val, used);
    TEST_ASSERT_EQUAL_INT(0, used_val);
    JS_FreeValue(ctx, used);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── info returns correct structure ───────────────────────────────── */

TEST_CASE("native:rtc info returns used, total, entries", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, info, clear } from "native:rtc";
        clear();
        set("key", "value");
        const i = info();
        globalThis.__hasUsed = "used" in i;
        globalThis.__hasTotal = "total" in i;
        globalThis.__hasEntries = "entries" in i;
        globalThis.__entries = i.entries;
        globalThis.__totalGt0 = i.total > 0;
        globalThis.__usedGt0 = i.used > 0;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue v;
    v = JS_GetPropertyStr(ctx, global, "__hasUsed");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "info should have 'used'");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasTotal");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "info should have 'total'");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__hasEntries");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "info should have 'entries'");
    JS_FreeValue(ctx, v);

    JSValue entries = JS_GetPropertyStr(ctx, global, "__entries");
    int32_t count;
    JS_ToInt32(ctx, &count, entries);
    TEST_ASSERT_EQUAL_INT(1, count);
    JS_FreeValue(ctx, entries);

    v = JS_GetPropertyStr(ctx, global, "__totalGt0");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "total should be > 0");
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, global, "__usedGt0");
    TEST_ASSERT_TRUE_MESSAGE(JS_ToBool(ctx, v), "used should be > 0 after set");
    JS_FreeValue(ctx, v);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── set overwrites existing key ──────────────────────────────────── */

TEST_CASE("native:rtc set overwrites existing key", "[modules]") {
    setup();

    JSValue ret = eval_module(R"(
        import { set, get, info, clear } from "native:rtc";
        clear();
        set("key", "old");
        set("key", "new");
        globalThis.__result = get("key");
        globalThis.__entries = info().entries;
    )");
    TEST_ASSERT_FALSE_MESSAGE(JS_IsException(ret), "Module eval should not throw");

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue result = JS_GetPropertyStr(ctx, global, "__result");
    const char* str = JS_ToCString(ctx, result);
    TEST_ASSERT_EQUAL_STRING("new", str);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, result);

    JSValue entries = JS_GetPropertyStr(ctx, global, "__entries");
    int32_t count;
    JS_ToInt32(ctx, &count, entries);
    TEST_ASSERT_EQUAL_INT(1, count);
    JS_FreeValue(ctx, entries);

    JS_FreeValue(ctx, global);
    teardown();
}

/* ── set throws on overflow ───────────────────────────────────────── */

TEST_CASE("native:rtc set returns an error Result when storage is full", "[modules]") {
    setup();

    /* native:rtc set returns a Result rather than throwing. A 2100-byte
     * value is well under MIK_RTC_MAX_VAL_LEN (64KB) but larger than the
     * RTC store capacity, so the error is MIK_ERR_KV_STORAGE_FULL
     * (0x8000 + 0xD3 = 0x80D3), not KV_TOO_LARGE. */
    JSValue ret = eval_module(R"(
        import { set, clear } from "native:rtc";
        clear();
        const big = "x".repeat(2100);
        const result = set("big", big);
        globalThis.__ok = result.ok;
        globalThis.__errorCode = result.ok ? 0 : result.error.code;
    )");
    bool evalOk = !JS_IsException(ret);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue okVal = JS_GetPropertyStr(ctx, global, "__ok");
    bool resultOk = JS_ToBool(ctx, okVal);
    JS_FreeValue(ctx, okVal);
    JSValue codeVal = JS_GetPropertyStr(ctx, global, "__errorCode");
    int32_t errorCode = 0;
    JS_ToInt32(ctx, &errorCode, codeVal);
    JS_FreeValue(ctx, codeVal);
    JS_FreeValue(ctx, global);
    teardown();

    TEST_ASSERT_TRUE_MESSAGE(evalOk, "Module eval should not throw");
    TEST_ASSERT_FALSE_MESSAGE(resultOk, "set should return ok=false when over capacity");
    TEST_ASSERT_EQUAL_INT32_MESSAGE(0x80D3, errorCode, "error code should be KV_STORAGE_FULL");
}

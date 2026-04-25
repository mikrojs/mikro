#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/*
 * Tests for the public mikrojs/fs module (throwing API).
 * Requires LittleFS mounted at /littlefs with a dummy.txt containing "Hello World".
 */

static MIKRuntime* mik_rt;
static JSContext* mik_ctx;

/* LittleFS is mounted/unmounted by the global setUp/tearDown in
 * fs_js_test.cpp (shared across all [fs] tests). */

static void pub_fs_setup() {
    mik_rt = MIK_NewRuntime();
    MIK_SetFSBasePath(mik_rt, "/littlefs");
    mik_ctx = MIK_GetJSContext(mik_rt);
}

static void pub_fs_teardown() {
    MIK_FreeRuntime(mik_rt);
}

static JSValue pub_fs_eval(const char* code) {
    JSValue ret = MIK_EvalModuleContent(mik_ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(mik_ctx, ret);
        mik__execute_jobs(mik_ctx);
    }
    return ret;
}

static bool get_global_bool(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    bool result = JS_ToBool(mik_ctx, val);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

static char* get_global_string(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    const char* str = JS_ToCString(mik_ctx, val);
    char* result = str ? strdup(str) : NULL;
    if (str) JS_FreeCString(mik_ctx, str);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

static int32_t get_global_int32(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    int32_t result;
    JS_ToInt32(mik_ctx, &result, val);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

/* ── readFile ────────────────────────────────────────────────────── */

TEST_CASE("mikrojs/fs readFile returns Uint8Array", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { readFile } from "mikrojs/fs";
        const r = readFile("/dummy.txt");
        globalThis.__ok = r.ok;
        if (r.ok) globalThis.__content = new TextDecoder().decode(r.value);
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* content = get_global_string("__content");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("Hello World", content);
    free(content);
}

TEST_CASE("mikrojs/fs readFile with utf-8 returns string", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { readFile } from "mikrojs/fs";
        const r = readFile("/dummy.txt", "utf-8");
        globalThis.__ok = r.ok;
        globalThis.__isString = r.ok && typeof r.value === "string";
        if (r.ok) globalThis.__content = r.value;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    bool is_string = get_global_bool("__isString");
    char* content = get_global_string("__content");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_TRUE_MESSAGE(is_string, "readFile with utf-8 should return string");
    TEST_ASSERT_EQUAL_STRING("Hello World", content);
    free(content);
}

TEST_CASE("mikrojs/fs readFile returns NotFound error for missing file", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { readFile } from "mikrojs/fs";
        const r = readFile("/nonexistent.txt");
        globalThis.__ok = r.ok;
        if (!r.ok) {
            globalThis.__name = r.error.name;
            globalThis.__path = r.error.path;
        }
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* name = get_global_string("__name");
    char* path = get_global_string("__path");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE_MESSAGE(ok, "readFile should fail for missing file");
    TEST_ASSERT_EQUAL_STRING("NotFound", name);
    TEST_ASSERT_EQUAL_STRING("/nonexistent.txt", path);
    free(name);
    free(path);
}

/* ── writeFile ───────────────────────────────────────────────────── */

TEST_CASE("mikrojs/fs writeFile and readFile roundtrip", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { writeFile, readFile } from "mikrojs/fs";
        const w = writeFile("/test_pub_write.txt", "hello from pub fs");
        const r = readFile("/test_pub_write.txt", "utf-8");
        globalThis.__ok = w.ok && r.ok;
        if (r.ok) globalThis.__content = r.value;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* content = get_global_string("__content");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("hello from pub fs", content);
    free(content);
}

TEST_CASE("mikrojs/fs writeFile with Uint8Array", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { writeFile, readFile } from "mikrojs/fs";
        const data = new TextEncoder().encode("binary data");
        const w = writeFile("/test_pub_binary.txt", data);
        const r = readFile("/test_pub_binary.txt", "utf-8");
        globalThis.__ok = w.ok && r.ok;
        if (r.ok) globalThis.__content = r.value;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* content = get_global_string("__content");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("binary data", content);
    free(content);
}

/* ── stat ────────────────────────────────────────────────────────── */

TEST_CASE("mikrojs/fs stat returns file info", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { stat } from "mikrojs/fs";
        const r = stat("/dummy.txt");
        globalThis.__ok = r.ok;
        if (r.ok) {
            globalThis.__size = r.value.size;
            globalThis.__isFile = r.value.isFile;
            globalThis.__isDir = r.value.isDirectory;
        }
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    int32_t size = get_global_int32("__size");
    bool is_file = get_global_bool("__isFile");
    bool is_dir = get_global_bool("__isDir");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_INT(11, size);
    TEST_ASSERT_TRUE(is_file);
    TEST_ASSERT_FALSE(is_dir);
}

TEST_CASE("mikrojs/fs stat returns NotFound for missing path", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { stat } from "mikrojs/fs";
        const r = stat("/nonexistent.txt");
        globalThis.__ok = r.ok;
        if (!r.ok) globalThis.__name = r.error.name;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* name = get_global_string("__name");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE_MESSAGE(ok, "stat should fail for missing path");
    TEST_ASSERT_EQUAL_STRING("NotFound", name);
    free(name);
}

/* ── exists ──────────────────────────────────────────────────────── */

TEST_CASE("mikrojs/fs exists returns true for existing file", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { exists } from "mikrojs/fs";
        globalThis.__exists = exists("/dummy.txt");
    )");
    bool was_exception = JS_IsException(ret);
    bool file_exists = get_global_bool("__exists");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(file_exists);
}

TEST_CASE("mikrojs/fs exists returns false for missing file", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { exists } from "mikrojs/fs";
        globalThis.__exists = exists("/nonexistent.txt");
    )");
    bool was_exception = JS_IsException(ret);
    bool file_exists = get_global_bool("__exists");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(file_exists);
}

/* ── mkdir / readDir / rmdir ─────────────────────────────────────── */

TEST_CASE("mikrojs/fs mkdir, readDir, rmdir roundtrip", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { mkdir, readDir, writeFile, unlink, rmdir } from "mikrojs/fs";
        const m = mkdir("/test_pub_dir");
        const w = writeFile("/test_pub_dir/file.txt", "hi");
        const entries = readDir("/test_pub_dir");
        globalThis.__hasFile = entries.ok &&
            entries.value.some(e => e.name === "file.txt" && e.isFile);
        const u = unlink("/test_pub_dir/file.txt");
        const r = rmdir("/test_pub_dir");
        globalThis.__done = m.ok && w.ok && u.ok && r.ok;
    )");
    bool was_exception = JS_IsException(ret);
    bool has_file = get_global_bool("__hasFile");
    bool done = get_global_bool("__done");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(has_file);
    TEST_ASSERT_TRUE(done);
}

/* ── unlink / rename ─────────────────────────────────────────────── */

TEST_CASE("mikrojs/fs unlink and rename", "[fs]") {
    pub_fs_setup();

    JSValue ret = pub_fs_eval(R"(
        import { writeFile, rename, readFile, unlink } from "mikrojs/fs";
        const w = writeFile("/test_pub_rename_src.txt", "rename me");
        const mv = rename("/test_pub_rename_src.txt", "/test_pub_rename_dst.txt");
        const r = readFile("/test_pub_rename_dst.txt", "utf-8");
        unlink("/test_pub_rename_dst.txt");
        globalThis.__ok = w.ok && mv.ok && r.ok;
        if (r.ok) globalThis.__content = r.value;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = get_global_bool("__ok");
    char* content = get_global_string("__content");
    pub_fs_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("rename me", content);
    free(content);
}

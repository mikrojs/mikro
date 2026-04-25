#include "esp_littlefs.h"
#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/*
 * These tests exercise the native:fs JS module (FileHandle, readFile, stat, etc.)
 * through the mikrojs runtime. They require LittleFS to be mounted at /littlefs
 * with a dummy.txt file containing "Hello World".
 *
 * native:fs returns Result values; tests unwrap via `.value` / check `.ok`
 * explicitly rather than wrapping in try/catch.
 *
 * IMPORTANT: teardown must be called BEFORE any TEST_ASSERT macros, because
 * Unity's assertions use longjmp which would skip teardown and leak the runtime.
 */

/* Unity calls setUp/tearDown automatically before/after each TEST_CASE tagged [fs]. */
void setUp() {
    esp_vfs_littlefs_conf_t conf = {
        .base_path = "/littlefs",
        .partition_label = "littlefs",
        .partition = NULL,
        .format_if_mount_failed = true,
        .read_only = false,
        .dont_mount = false,
        .grow_on_mount = false,
    };
    esp_vfs_littlefs_register(&conf);
}

void tearDown() { esp_vfs_littlefs_unregister("littlefs"); }

static MIKRuntime* mik_rt;
static JSContext* mik_ctx;

static void fs_js_setup() {
    mik_rt = MIK_NewRuntime();
    MIK_SetFSBasePath(mik_rt, "/littlefs");
    mik_ctx = MIK_GetJSContext(mik_rt);
}

static void fs_js_teardown() { MIK_FreeRuntime(mik_rt); }

static JSValue fs_eval_module(const char* code) {
    JSValue ret = MIK_EvalModuleContent(mik_ctx, "mikrojs/test", code, strlen(code));
    if (!JS_IsException(ret)) {
        JS_FreeValue(mik_ctx, ret);
        mik__execute_jobs(mik_ctx);
    }
    return ret;
}

static char* fs_get_global_string(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    const char* str = JS_ToCString(mik_ctx, val);
    char* result = str ? strdup(str) : nullptr;
    JS_FreeCString(mik_ctx, str);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

static bool fs_get_global_bool(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    bool result = JS_ToBool(mik_ctx, val);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

static int32_t fs_get_global_int32(const char* name) {
    JSValue global = JS_GetGlobalObject(mik_ctx);
    JSValue val = JS_GetPropertyStr(mik_ctx, global, name);
    int32_t result;
    JS_ToInt32(mik_ctx, &result, val);
    JS_FreeValue(mik_ctx, val);
    JS_FreeValue(mik_ctx, global);
    return result;
}

TEST_CASE("native:fs open + FileHandle.read returns file contents", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open } from "native:fs";
        const r = open("/dummy.txt");
        globalThis.__ok = r.ok;
        if (r.ok) {
            const fh = r.value;
            const data = fh.read(11);
            if (data.ok) globalThis.__content = new TextDecoder().decode(data.value);
            fh.close();
        }
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    char* content = fs_get_global_string("__content");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(ok);
    TEST_ASSERT_EQUAL_STRING("Hello World", content);
    free(content);
}

TEST_CASE("native:fs open returns NotFound for non-existent file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open } from "native:fs";
        const r = open("/nonexistent.txt");
        globalThis.__ok = r.ok;
        if (!r.ok) globalThis.__name = r.error.name;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    char* name = fs_get_global_string("__name");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(ok);
    TEST_ASSERT_EQUAL_STRING("NotFound", name);
    free(name);
}

TEST_CASE("native:fs FileHandle.write and readFile roundtrip", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, readFile } from "native:fs";
        const fh = open("/test_write.txt", "w").value;
        fh.write("test content");
        fh.close();
        const r = readFile("/test_write.txt");
        if (r.ok) globalThis.__readback = new TextDecoder().decode(r.value);
    )");
    bool was_exception = JS_IsException(ret);
    char* readback = fs_get_global_string("__readback");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("test content", readback);
    free(readback);
}

TEST_CASE("native:fs FileHandle.stat returns size and type flags", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open } from "native:fs";
        const fh = open("/dummy.txt").value;
        const st = fh.stat().value;
        globalThis.__size = st.size;
        globalThis.__isFile = st.isFile;
        globalThis.__isDir = st.isDirectory;
        fh.close();
    )");
    bool was_exception = JS_IsException(ret);
    int32_t size = fs_get_global_int32("__size");
    bool is_file = fs_get_global_bool("__isFile");
    bool is_dir = fs_get_global_bool("__isDir");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_INT32(11, size);
    TEST_ASSERT_TRUE(is_file);
    TEST_ASSERT_FALSE(is_dir);
}

TEST_CASE("native:fs FileHandle.path returns the virtual path", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open } from "native:fs";
        const fh = open("/dummy.txt").value;
        globalThis.__path = fh.path;
        fh.close();
    )");
    bool was_exception = JS_IsException(ret);
    char* path = fs_get_global_string("__path");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("/dummy.txt", path);
    free(path);
}

TEST_CASE("native:fs FileHandle.seek absolute and relative", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, writeFile, unlink } from "native:fs";
        writeFile("/seek.txt", "0123456789");
        const fh = open("/seek.txt").value;
        const dec = new TextDecoder();
        const p1 = fh.seek(4).value;
        const d1 = dec.decode(fh.read(2).value);
        const p2 = fh.seek(-1, "current").value;
        const d2 = dec.decode(fh.read(2).value);
        const p3 = fh.seek(-3, "end").value;
        const d3 = dec.decode(fh.read(3).value);
        fh.close();
        unlink("/seek.txt");
        globalThis.__p1 = p1; globalThis.__p2 = p2; globalThis.__p3 = p3;
        globalThis.__d = d1 + "|" + d2 + "|" + d3;
    )");
    bool was_exception = JS_IsException(ret);
    int32_t p1 = fs_get_global_int32("__p1");
    int32_t p2 = fs_get_global_int32("__p2");
    int32_t p3 = fs_get_global_int32("__p3");
    char* d = fs_get_global_string("__d");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_INT32(4, p1);
    TEST_ASSERT_EQUAL_INT32(5, p2);
    TEST_ASSERT_EQUAL_INT32(7, p3);
    TEST_ASSERT_EQUAL_STRING("45|56|789", d);
    free(d);
}

TEST_CASE("native:fs FileHandle after close returns BadFileDescriptor", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, writeFile, unlink } from "native:fs";
        writeFile("/bad.txt", "x");
        const fh = open("/bad.txt").value;
        fh.close();
        const r = fh.read(1);
        unlink("/bad.txt");
        globalThis.__ok = r.ok;
        if (!r.ok) globalThis.__name = r.error.name;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    char* name = fs_get_global_string("__name");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(ok);
    TEST_ASSERT_EQUAL_STRING("BadFileDescriptor", name);
    free(name);
}

TEST_CASE("native:fs FileHandle.read returns undefined at EOF", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open } from "native:fs";
        const fh = open("/dummy.txt").value;
        fh.read(11);
        const after = fh.read(1);
        globalThis.__atEof = after.ok && after.value === undefined;
        fh.close();
    )");
    bool was_exception = JS_IsException(ret);
    bool at_eof = fs_get_global_bool("__atEof");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE_MESSAGE(at_eof, "read past EOF should return ok(undefined)");
}

TEST_CASE("native:fs stat on path returns correct info", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { stat } from "native:fs";
        const st = stat("/dummy.txt").value;
        globalThis.__size = st.size;
        globalThis.__isFile = st.isFile;
    )");
    bool was_exception = JS_IsException(ret);
    int32_t size = fs_get_global_int32("__size");
    bool is_file = fs_get_global_bool("__isFile");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_INT32(11, size);
    TEST_ASSERT_TRUE(is_file);
}

TEST_CASE("native:fs unlink removes a file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, unlink, stat } from "native:fs";
        const fh = open("/to_delete.txt", "w").value;
        fh.write("delete me");
        fh.close();
        unlink("/to_delete.txt");
        const r = stat("/to_delete.txt");
        globalThis.__deleted = !r.ok;
    )");
    bool was_exception = JS_IsException(ret);
    bool deleted = fs_get_global_bool("__deleted");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(deleted);
}

TEST_CASE("native:fs rename moves a file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, rename, readFile } from "native:fs";
        const fh = open("/rename_src.txt", "w").value;
        fh.write("renamed content");
        fh.close();
        rename("/rename_src.txt", "/rename_dst.txt");
        const r = readFile("/rename_dst.txt");
        if (r.ok) globalThis.__content = new TextDecoder().decode(r.value);
    )");
    bool was_exception = JS_IsException(ret);
    char* content = fs_get_global_string("__content");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("renamed content", content);
    free(content);
}

TEST_CASE("native:fs mkdir and readDir", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { mkdir, readDir, open, rmdir, unlink } from "native:fs";
        mkdir("/testdir");
        const fh = open("/testdir/file.txt", "w").value;
        fh.write("hi");
        fh.close();
        const entries = readDir("/testdir").value;
        globalThis.__hasFile = entries.some(e => e.name === "file.txt" && e.isFile);
        globalThis.__entryCount = entries.length;
        unlink("/testdir/file.txt");
        rmdir("/testdir");
    )");
    bool was_exception = JS_IsException(ret);
    bool has_file = fs_get_global_bool("__hasFile");
    int32_t count = fs_get_global_int32("__entryCount");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE_MESSAGE(has_file, "readDir should list the file");
    TEST_ASSERT_GREATER_OR_EQUAL_INT32_MESSAGE(1, count,
                                               "Directory should have at least 1 entry");
}

TEST_CASE("native:fs open with mode=w creates a new file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { open, unlink } from "native:fs";
        const fh = open("/create_true.txt", "w").value;
        fh.write("created");
        fh.close();
        const fh2 = open("/create_true.txt").value;
        const data = fh2.read(7).value;
        globalThis.__content = new TextDecoder().decode(data);
        fh2.close();
        unlink("/create_true.txt");
    )");
    bool was_exception = JS_IsException(ret);
    char* content = fs_get_global_string("__content");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_EQUAL_STRING("created", content);
    free(content);
}

TEST_CASE("native:fs exists returns true for existing file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { exists } from "native:fs";
        globalThis.__exists = exists("/dummy.txt");
    )");
    bool was_exception = JS_IsException(ret);
    bool exists = fs_get_global_bool("__exists");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_TRUE(exists);
}

TEST_CASE("native:fs exists returns false for non-existent file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { exists } from "native:fs";
        globalThis.__exists = exists("/no_such_file.txt");
    )");
    bool was_exception = JS_IsException(ret);
    bool exists = fs_get_global_bool("__exists");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(exists);
}

TEST_CASE("native:fs unlink returns NotFound for missing file", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { unlink } from "native:fs";
        const r = unlink("/no_such_file.txt");
        globalThis.__ok = r.ok;
        if (!r.ok) globalThis.__name = r.error.name;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    char* name = fs_get_global_string("__name");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(ok);
    TEST_ASSERT_EQUAL_STRING("NotFound", name);
    free(name);
}

TEST_CASE("native:fs readDir returns error for missing directory", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { readDir } from "native:fs";
        const r = readDir("/no_such_dir");
        globalThis.__ok = r.ok;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(ok);
}

TEST_CASE("native:fs rmdir returns error for missing directory", "[fs]") {
    fs_js_setup();

    JSValue ret = fs_eval_module(R"(
        import { rmdir } from "native:fs";
        const r = rmdir("/no_such_dir");
        globalThis.__ok = r.ok;
    )");
    bool was_exception = JS_IsException(ret);
    bool ok = fs_get_global_bool("__ok");
    fs_js_teardown();

    TEST_ASSERT_FALSE_MESSAGE(was_exception, "Module eval should not throw");
    TEST_ASSERT_FALSE(ok);
}

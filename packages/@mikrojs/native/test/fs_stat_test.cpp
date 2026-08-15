#include <ftw.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Regression test for File.stat() on an open write handle: fstat must see
 * bytes still sitting in the stdio buffer, so stat() flushes first. */

namespace {

static int rm_cb(const char* path, const struct stat*, int, struct FTW*) {
    return remove(path);
}

struct FsStatFixture {
    char root[64];
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    FsStatFixture() {
        snprintf(root, sizeof(root), "/tmp/mik_fs_stat_test_XXXXXX");
        REQUIRE(mkdtemp(root) != nullptr);
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        MIK_SetFSRoot(rt, root);
        ctx = MIK_GetJSContext(rt);
    }

    ~FsStatFixture() {
        MIK_FreeRuntime(rt);
        nftw(root, rm_cb, 8, FTW_DEPTH | FTW_PHYS);
    }
};

static void run(JSContext* ctx, const char* src) {
    JSValue rv = JS_Eval(ctx, src, strlen(src), "mikro/test-fs-stat-driver",
                         JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[fs_stat run] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, exc);
    }
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[fs_stat run] rejected: %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, rv);
    REQUIRE(state == JS_PROMISE_FULFILLED);
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

TEST_CASE_FIXTURE(FsStatFixture,
                  "stat on an open write handle sees unflushed writes" *
                      doctest::test_suite("fs")) {
    run(ctx,
        "import {open} from 'native:mikro/fs'\n"
        "const w = open('/f.bin', 'w').value\n"
        "w.write('abcdef')\n"
        "w.write(new Uint8Array([65, 66]))\n"
        "globalThis.__size = w.stat().value.size\n"
        "w.close()\n");
    CHECK(read_global_int(ctx, "__size") == 8);
}

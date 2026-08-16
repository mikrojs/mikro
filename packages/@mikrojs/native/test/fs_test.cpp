#include <ftw.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Host-side tests for the fs native module (src/fs.cpp) through the public
 * `mikro/fs` JS API: round-trips, write options, the File handle, the /app
 * read-only zone, path traversal clamping, the single-shot read cap, and
 * the quota. Each case runs against a fresh mkdtemp root via MIK_SetFSRoot. */

namespace {

static int rm_cb(const char* path, const struct stat*, int, struct FTW*) {
    return remove(path);
}

struct FsFixture {
    char root[64];
    MIKRuntime* rt = nullptr;
    JSContext* ctx = nullptr;

    FsFixture() {
        snprintf(root, sizeof(root), "/tmp/mik_fs_test_XXXXXX");
        REQUIRE(mkdtemp(root) != nullptr);
        rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        MIK_SetFSRoot(rt, root);
        ctx = MIK_GetJSContext(rt);
    }

    ~FsFixture() {
        MIK_FreeRuntime(rt);
        nftw(root, rm_cb, 8, FTW_DEPTH | FTW_PHYS);
    }
};

static JSValue eval_module(JSContext* ctx, const char* src) {
    std::string code = src;
    JSValue rv = JS_Eval(ctx, code.c_str(), code.size(), "mikro/test-fs-driver",
                         JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue exc = JS_GetException(ctx);
        const char* s = JS_ToCString(ctx, exc);
        if (s) {
            fprintf(stderr, "[fs eval_module] %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, exc);
    }
    return rv;
}

static void run(JSContext* ctx, const char* src) {
    JSValue rv = eval_module(ctx, src);
    REQUIRE(!JS_IsException(rv));
    JSPromiseStateEnum state = JS_PromiseState(ctx, rv);
    if (state == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx, rv);
        const char* s = JS_ToCString(ctx, reason);
        if (s) {
            fprintf(stderr, "[fs run] rejected: %s\n", s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, reason);
    }
    JS_FreeValue(ctx, rv);
    REQUIRE(state == JS_PROMISE_FULFILLED);
}

static std::string read_global_string(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    const char* s = JS_ToCString(ctx, v);
    std::string out = s ? s : "";
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return out;
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

static bool read_global_bool(JSContext* ctx, const char* name) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, g, name);
    JS_FreeValue(ctx, g);
    bool b = JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return b;
}

/* `tag(result)` → "ok" on success, the FSError name otherwise. The public
 * wrapper exposes readStream() instead of open(), so File-handle tests import
 * open() from the native module directly. */
static const char* PRELUDE =
    "import * as fs from 'mikro/fs'\n"
    "import {open} from 'native:mikro/fs'\n"
    "const tag = (r) => r.ok ? 'ok' : r.error.name\n";

}  // namespace

TEST_CASE_FIXTURE(FsFixture, "writeFile and readFile round-trip" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__w = tag(fs.writeFile('/data.txt', 'hello'))\n"
              "globalThis.__r = fs.readFile('/data.txt', 'utf-8').value\n"
              "const bin = fs.readFile('/data.txt').value\n"
              "globalThis.__len = bin.byteLength\n"
              "globalThis.__first = bin[0]\n"
              "globalThis.__exists = fs.exists('/data.txt')\n"
              "const st = fs.stat('/data.txt').value\n"
              "globalThis.__size = st.size\n"
              "globalThis.__isFile = st.isFile\n"
              "globalThis.__isDir = st.isDirectory\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__w") == "ok");
    CHECK(read_global_string(ctx, "__r") == "hello");
    CHECK(read_global_int(ctx, "__len") == 5);
    CHECK(read_global_int(ctx, "__first") == 'h');
    CHECK(read_global_bool(ctx, "__exists"));
    CHECK(read_global_int(ctx, "__size") == 5);
    CHECK(read_global_bool(ctx, "__isFile"));
    CHECK_FALSE(read_global_bool(ctx, "__isDir"));
}

TEST_CASE_FIXTURE(FsFixture, "writeFile Uint8Array, empty files, and options" *
                                 doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "fs.writeFile('/bin.dat', new Uint8Array([1, 2, 3]))\n"
              "globalThis.__bin = fs.readFile('/bin.dat').value.join(',')\n"
              "fs.writeFile('/empty.txt', '')\n"
              "globalThis.__emptyStr = fs.readFile('/empty.txt', 'utf-8').value\n"
              "globalThis.__emptyLen = fs.readFile('/empty.txt').value.byteLength\n"
              "fs.writeFile('/log.txt', 'a')\n"
              "fs.writeFile('/log.txt', 'b', {append: true})\n"
              "globalThis.__appended = fs.readFile('/log.txt', 'utf-8').value\n"
              "fs.writeFile('/log.txt', 'c')\n"
              "globalThis.__truncated = fs.readFile('/log.txt', 'utf-8').value\n"
              "const nc = fs.writeFile('/missing.txt', 'x', {create: false})\n"
              "globalThis.__noCreate = tag(nc)\n"
              "globalThis.__noCreatePath = nc.ok ? '' : nc.error.path\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__bin") == "1,2,3");
    CHECK(read_global_string(ctx, "__emptyStr") == "");
    CHECK(read_global_int(ctx, "__emptyLen") == 0);
    CHECK(read_global_string(ctx, "__appended") == "ab");
    CHECK(read_global_string(ctx, "__truncated") == "c");
    CHECK(read_global_string(ctx, "__noCreate") == "NotFound");
    CHECK(read_global_string(ctx, "__noCreatePath") == "/missing.txt");
}

TEST_CASE_FIXTURE(FsFixture, "readFile and stat errors carry name and path" *
                                 doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "const r = fs.readFile('/nope.txt')\n"
              "globalThis.__read = tag(r)\n"
              "globalThis.__readPath = r.error.path\n"
              "globalThis.__stat = tag(fs.stat('/nope.txt'))\n"
              "globalThis.__exists = fs.exists('/nope.txt')\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__read") == "NotFound");
    CHECK(read_global_string(ctx, "__readPath") == "/nope.txt");
    CHECK(read_global_string(ctx, "__stat") == "NotFound");
    CHECK_FALSE(read_global_bool(ctx, "__exists"));
}

TEST_CASE_FIXTURE(FsFixture, "readFile respects the single-shot read cap" *
                                 doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) + "fs.writeFile('/big.dat', 'x'.repeat(64))\n").c_str());
    MIK_SetFSReadMax(rt, 16);
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__big = tag(fs.readFile('/big.dat'))\n"
              /* open() streaming stays available past the cap */
              "const f = open('/big.dat').value\n"
              "globalThis.__chunk = f.read(64).value.byteLength\n"
              "f.close()\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__big") == "TooLarge");
    CHECK(read_global_int(ctx, "__chunk") == 64);
    MIK_SetFSReadMax(rt, 0); /* back to default */
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__again = tag(fs.readFile('/big.dat'))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__again") == "ok");
}

TEST_CASE_FIXTURE(FsFixture, "mkdir, readDir, rmdir" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__mk = tag(fs.mkdir('/d'))\n"
              "globalThis.__mkAgain = tag(fs.mkdir('/d'))\n"
              "fs.writeFile('/d/f.txt', 'x')\n"
              "const entries = fs.readDir('/d').value\n"
              "globalThis.__names = entries.map((e) => e.name).join(',')\n"
              "globalThis.__entIsFile = entries[0].isFile\n"
              "globalThis.__rmFull = tag(fs.rmdir('/d'))\n"
              "fs.unlink('/d/f.txt')\n"
              "globalThis.__rmEmpty = tag(fs.rmdir('/d'))\n"
              "globalThis.__rmGone = tag(fs.rmdir('/d'))\n"
              "globalThis.__deep = tag(fs.mkdir('/a/b/c', {recursive: true}))\n"
              "globalThis.__deepExists = fs.exists('/a/b/c')\n"
              "globalThis.__flat = tag(fs.mkdir('/x/y/z'))\n"
              "globalThis.__readDirGone = tag(fs.readDir('/nope'))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__mk") == "ok");
    CHECK(read_global_string(ctx, "__mkAgain") == "AlreadyExists");
    CHECK(read_global_string(ctx, "__names") == "f.txt");
    CHECK(read_global_bool(ctx, "__entIsFile"));
    /* ENOTEMPTY has no dedicated variant: surfaces as Unknown with errno */
    CHECK(read_global_string(ctx, "__rmFull") == "Unknown");
    CHECK(read_global_string(ctx, "__rmEmpty") == "ok");
    CHECK(read_global_string(ctx, "__rmGone") == "NotFound");
    CHECK(read_global_string(ctx, "__deep") == "ok");
    CHECK(read_global_bool(ctx, "__deepExists"));
    CHECK(read_global_string(ctx, "__flat") == "NotFound");
    CHECK(read_global_string(ctx, "__readDirGone") == "NotFound");
}

TEST_CASE_FIXTURE(FsFixture, "unlink and rename" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "fs.writeFile('/from.txt', 'payload')\n"
              "globalThis.__mv = tag(fs.rename('/from.txt', '/to.txt'))\n"
              "globalThis.__oldGone = fs.exists('/from.txt')\n"
              "globalThis.__moved = fs.readFile('/to.txt', 'utf-8').value\n"
              "globalThis.__mvGone = tag(fs.rename('/from.txt', '/elsewhere.txt'))\n"
              "globalThis.__rm = tag(fs.unlink('/to.txt'))\n"
              "globalThis.__rmGone = tag(fs.unlink('/to.txt'))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__mv") == "ok");
    CHECK_FALSE(read_global_bool(ctx, "__oldGone"));
    CHECK(read_global_string(ctx, "__moved") == "payload");
    CHECK(read_global_string(ctx, "__mvGone") == "NotFound");
    CHECK(read_global_string(ctx, "__rm") == "ok");
    CHECK(read_global_string(ctx, "__rmGone") == "NotFound");
}

TEST_CASE_FIXTURE(FsFixture, "open modes and File handle methods" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__missing = tag(open('/nope.bin'))\n"
              "const w = open('/f.bin', 'w').value\n"
              "globalThis.__path = w.path\n"
              "globalThis.__w1 = w.write('abcdef').value\n"
              "globalThis.__w2 = w.write(new Uint8Array([65, 66])).value\n"
              "globalThis.__wstat = w.stat().value.size\n" /* flushed before fstat */
              "w.close()\n"
              "const r = open('/f.bin', 'r').value\n"
              "globalThis.__seekEnd = r.seek(0, 'end').value\n"
              "globalThis.__seekBack = r.seek(-2, 'current').value\n"
              "globalThis.__tail = String.fromCharCode(...r.read(16).value)\n"
              "globalThis.__eof = r.read(16).value === undefined ? 'eof' : 'data'\n"
              "r.seek(2)\n"
              "globalThis.__mid = String.fromCharCode(...r.read(2).value)\n"
              "globalThis.__badWhence = tag(r.seek(0, 'sideways'))\n"
              "globalThis.__close1 = tag(r.close())\n"
              "globalThis.__close2 = tag(r.close())\n"
              "globalThis.__afterClose = tag(r.read(1))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__missing") == "NotFound");
    CHECK(read_global_string(ctx, "__path") == "/f.bin");
    CHECK(read_global_int(ctx, "__w1") == 6);
    CHECK(read_global_int(ctx, "__w2") == 2);
    CHECK(read_global_int(ctx, "__wstat") == 8);
    CHECK(read_global_int(ctx, "__seekEnd") == 8);
    CHECK(read_global_int(ctx, "__seekBack") == 6);
    CHECK(read_global_string(ctx, "__tail") == "AB");
    CHECK(read_global_string(ctx, "__eof") == "eof");
    CHECK(read_global_string(ctx, "__mid") == "cd");
    /* EINVAL has no dedicated variant: surfaces as Unknown */
    CHECK(read_global_string(ctx, "__badWhence") == "Unknown");
    CHECK(read_global_string(ctx, "__close1") == "ok");
    CHECK(read_global_string(ctx, "__close2") == "ok");
    CHECK(read_global_string(ctx, "__afterClose") == "BadFileDescriptor");
}

TEST_CASE_FIXTURE(FsFixture, "handle misuse and OS permission errors map to FSError" *
                                 doctest::test_suite("fs")) {
    /* a locked directory produces real EACCES from the OS */
    std::string locked = std::string(root) + "/locked";
    mkdir(locked.c_str(), 0755);
    {
        FILE* f = fopen((locked + "/inside.txt").c_str(), "w");
        REQUIRE(f != nullptr);
        fputs("x", f);
        fclose(f);
    }
    chmod(locked.c_str(), 0000);

    run(ctx, (std::string(PRELUDE) +
              "const name = (r) => r.ok ? 'ok' : r.error.name\n"
              /* writes through the wrong-direction handle fail with errno */
              "fs.writeFile('/rw.txt', 'seed')\n"
              "const r = open('/rw.txt', 'r').value\n"
              "globalThis.__writeOnR = name(r.write('nope'))\n"
              "r.close()\n"
              "const w = open('/rw2.txt', 'w').value\n"
              "const rd = w.read(4)\n"
              "globalThis.__readOnW = rd.ok ? (rd.value === undefined ? 'eof' : 'data') : rd.error.name\n"
              "w.close()\n"
              /* OS-level EACCES surfaces as AccessDenied */
              "globalThis.__wLocked = name(fs.writeFile('/locked/new.txt', 'x'))\n"
              "globalThis.__rLocked = name(fs.readFile('/locked/inside.txt'))\n"
              "globalThis.__lsLocked = name(fs.readDir('/locked'))\n"
              "globalThis.__rmLocked = name(fs.unlink('/locked/inside.txt'))\n"
              "globalThis.__mvLocked = name(fs.rename('/rw.txt', '/locked/moved.txt'))\n"
              /* append mode via open() */
              "const a = open('/rw.txt', 'a').value\n"
              "a.write('+more')\n"
              "a.close()\n"
              "globalThis.__appended = fs.readFile('/rw.txt', 'utf-8').value\n")
                 .c_str());
    chmod(locked.c_str(), 0755); /* restore so cleanup can remove it */

    /* writing to a read-only stream: glibc fails immediately (error result),
     * macOS stdio buffers and only fails at flush — accept both */
    std::string write_on_r = read_global_string(ctx, "__writeOnR");
    CHECK((write_on_r == "ok" || write_on_r == "Unknown" || write_on_r == "BadFileDescriptor"));
    /* reading a write-only stream must not fabricate data */
    CHECK(read_global_string(ctx, "__readOnW") != "data");
    CHECK(read_global_string(ctx, "__wLocked") == "AccessDenied");
    CHECK(read_global_string(ctx, "__rLocked") == "AccessDenied");
    CHECK(read_global_string(ctx, "__lsLocked") == "AccessDenied");
    CHECK(read_global_string(ctx, "__rmLocked") == "AccessDenied");
    CHECK(read_global_string(ctx, "__mvLocked") == "AccessDenied");
    CHECK(read_global_string(ctx, "__appended") == "seed+more");
}

TEST_CASE_FIXTURE(FsFixture, "the /app zone is read-only" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__wr = tag(fs.writeFile('/app/x.txt', 'y'))\n"
              "globalThis.__rm = tag(fs.unlink('/app/x.txt'))\n"
              "globalThis.__mv = tag(fs.rename('/app/x.txt', '/y.txt'))\n"
              "globalThis.__mvInto = tag(fs.rename('/y.txt', '/app/x.txt'))\n"
              "globalThis.__mk = tag(fs.mkdir('/app/sub'))\n"
              "globalThis.__openW = tag(open('/app/x.txt', 'w'))\n"
              /* reads resolve normally: missing file, not access denied */
              "globalThis.__openR = tag(open('/app/x.txt'))\n"
              /* traversal cannot sneak past the prefix check */
              "globalThis.__sneak = tag(fs.writeFile('/data/../app/x.txt', 'y'))\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__wr") == "AccessDenied");
    CHECK(read_global_string(ctx, "__rm") == "AccessDenied");
    CHECK(read_global_string(ctx, "__mv") == "AccessDenied");
    CHECK(read_global_string(ctx, "__mvInto") == "AccessDenied");
    CHECK(read_global_string(ctx, "__mk") == "AccessDenied");
    CHECK(read_global_string(ctx, "__openW") == "AccessDenied");
    CHECK(read_global_string(ctx, "__openR") == "NotFound");
    CHECK(read_global_string(ctx, "__sneak") == "AccessDenied");
}

TEST_CASE_FIXTURE(FsFixture, "path traversal clamps to the fs root" * doctest::test_suite("fs")) {
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__esc = tag(fs.writeFile('../../escape.txt', 'x'))\n"
              "globalThis.__inside = fs.exists('/escape.txt')\n"
              "fs.mkdir('/a')\n"
              "globalThis.__messy = tag(fs.writeFile('/a/.//b.txt', 'x'))\n"
              "globalThis.__clean = fs.exists('/a/b.txt')\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__esc") == "ok");
    CHECK(read_global_bool(ctx, "__inside"));
    CHECK(read_global_string(ctx, "__messy") == "ok");
    CHECK(read_global_bool(ctx, "__clean"));

    /* The escape attempt landed inside the root, not above it. */
    struct stat st;
    std::string inside = std::string(root) + "/escape.txt";
    CHECK(stat(inside.c_str(), &st) == 0);
    std::string outside = std::string(root) + "/../escape.txt";
    CHECK(stat(outside.c_str(), &st) != 0);
}

TEST_CASE_FIXTURE(FsFixture, "quota limits writes and frees on unlink" *
                                 doctest::test_suite("fs")) {
    MIK_SetFSLimit(rt, 100);
    run(ctx, (std::string(PRELUDE) +
              "globalThis.__first = tag(fs.writeFile('/a.dat', 'x'.repeat(60)))\n"
              "globalThis.__over = tag(fs.writeFile('/b.dat', 'x'.repeat(60)))\n"
              /* truncating rewrite of the same file is a no-op for the quota */
              "globalThis.__rewrite = tag(fs.writeFile('/a.dat', 'y'.repeat(60)))\n"
              "globalThis.__append = tag(fs.writeFile('/a.dat', 'x'.repeat(60), {append: true}))\n"
              "fs.unlink('/a.dat')\n"
              "globalThis.__freed = tag(fs.writeFile('/b.dat', 'x'.repeat(60)))\n"
              "const f = open('/c.dat', 'w').value\n"
              "globalThis.__handle = tag(f.write('x'.repeat(60)))\n"
              "f.close()\n")
                 .c_str());
    CHECK(read_global_string(ctx, "__first") == "ok");
    CHECK(read_global_string(ctx, "__over") == "NoSpace");
    CHECK(read_global_string(ctx, "__rewrite") == "ok");
    CHECK(read_global_string(ctx, "__append") == "NoSpace");
    CHECK(read_global_string(ctx, "__freed") == "ok");
    CHECK(read_global_string(ctx, "__handle") == "NoSpace");
}

#include <ftw.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <string>

#include <mikrojs/mem.h>
#include <mikrojs/mikrojs.h>
#include <quickjs.h>

#include <doctest.h>

/* Incremental OOM injection, SQLite-style: run the same module eval while the
 * JS-heap allocator fails at point n, for every n until the eval succeeds.
 * Each round must end in a clean success or a clean JS error, with the
 * runtime still usable afterwards and no leaked allocations. Runtime
 * creation runs with injection disabled: a creation-time OOM aborts by
 * design (CHECK_NOT_NULL), only the JS heap must stay catchable.
 *
 * The sweep runs several workloads because imports happen inside the
 * injected eval: builtin bytecode deserialization, Result construction,
 * and each module's own error paths all get exercised at every failing
 * allocation point. */

namespace {

enum class EvalOutcome { Success, JsError };

EvalOutcome eval_module(JSContext* ctx, const char* name, const char* src) {
    JSValue result = MIK_EvalModuleContent(ctx, name, src, strlen(src));
    EvalOutcome outcome = EvalOutcome::JsError;
    if (!JS_IsException(result) && JS_PromiseState(ctx, result) == JS_PROMISE_FULFILLED) {
        outcome = EvalOutcome::Success;
    }
    JS_FreeValue(ctx, result);
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    return outcome;
}

static int rm_cb(const char* path, const struct stat*, int, struct FTW*) {
    return remove(path);
}

/* Sweep the failure point across the whole allocation range of `src`.
 * Strides widen after the early points: the dense low range hits setup and
 * bytecode-load allocations, the strided tail still samples every region
 * of the workload without quadratic wall-clock. */
static void oom_sweep(const char* label, const char* src, const char* fs_root) {
    /* Warm up process-level lazy state (class ids, registries). */
    {
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        if (fs_root) {
            /* fs ops resolve via fs_root, module loading via base_path */
            MIK_SetFSRoot(rt, fs_root);
            MIK_SetFSBasePath(rt, fs_root);
        }
        JSContext* ctx = MIK_GetJSContext(rt);
        EvalOutcome warm = eval_module(ctx, "<oom-warmup>", src);
        if (warm != EvalOutcome::Success) {
            CAPTURE(label);
            REQUIRE(warm == EvalOutcome::Success);
        }
        MIK_FreeRuntime(rt);
    }

    bool succeeded = false;
    const int64_t max_rounds = 100000;
    for (int64_t n = 0; n < max_rounds && !succeeded; n += (n < 256 ? 1 : 7)) {
        int64_t live_before = mik__oom_inject_live_allocs();
        MIKRuntime* rt = MIK_NewRuntime();
        REQUIRE(rt != nullptr);
        if (fs_root) {
            /* fs ops resolve via fs_root, module loading via base_path */
            MIK_SetFSRoot(rt, fs_root);
            MIK_SetFSBasePath(rt, fs_root);
        }
        JSContext* ctx = MIK_GetJSContext(rt);

        mik__oom_inject_fail_after(n);
        EvalOutcome outcome = eval_module(ctx, "<oom-inject>", src);
        mik__oom_inject_fail_after(-1);

        if (outcome == EvalOutcome::Success) {
            succeeded = true;
        } else {
            /* A JS-heap OOM must not wedge the runtime: with the allocator
             * healthy again, the next eval has to work. */
            EvalOutcome recovery = eval_module(ctx, "<oom-recovery>", "export const ok = 1;\n");
            if (recovery != EvalOutcome::Success) {
                CAPTURE(label);
                CAPTURE(n);
                REQUIRE(recovery == EvalOutcome::Success);
            }
        }

        MIK_FreeRuntime(rt);

        int64_t live_after = mik__oom_inject_live_allocs();
        if (live_after != live_before) {
            CAPTURE(label);
            CAPTURE(n);
            REQUIRE(live_after == live_before);
        }
    }
    CAPTURE(label);
    CHECK_MESSAGE(succeeded, "eval never succeeded; raise max_rounds");
}

}  // namespace

TEST_CASE("module eval fails cleanly at every JS-heap allocation point" *
          doctest::test_suite("oom")) {
    oom_sweep("plain-eval",
              "const parts = [];\n"
              "for (let i = 0; i < 8; i++) parts.push(`chunk-${i}`.repeat(4));\n"
              "export const text = parts.join(',');\n",
              nullptr);
}

TEST_CASE("cbor encode/decode fails cleanly at every allocation point" *
          doctest::test_suite("oom")) {
    oom_sweep("cbor",
              "import {encode, decode} from 'mikro/cbor'\n"
              "const r = encode({a: [1, 2.5, 'x', true, null, {n: 8}], b: 'bytes'})\n"
              "if (r.ok) { decode(r.value) }\n"
              "export const done = 1\n",
              nullptr);
}

TEST_CASE("inspect fails cleanly at every allocation point" * doctest::test_suite("oom")) {
    oom_sweep("inspect",
              "import {inspect} from 'mikro/inspect'\n"
              "inspect({n: 1, s: 'str', arr: [1, [2, [3]]], m: new Map([['k', 1]]),\n"
              "         set: new Set([1]), d: new Date(0), u8: new Uint8Array([1, 2])},\n"
              "        {colors: true, depth: 4})\n"
              "export const done = 1\n",
              nullptr);
}

TEST_CASE("fs operations fail cleanly at every allocation point" * doctest::test_suite("oom")) {
    char root[64];
    snprintf(root, sizeof(root), "/tmp/mik_oom_fs_XXXXXX");
    REQUIRE(mkdtemp(root) != nullptr);
    oom_sweep("fs",
              "import * as fs from 'mikro/fs'\n"
              "fs.writeFile('/o.txt', 'payload-data')\n"
              "fs.readFile('/o.txt', 'utf-8')\n"
              "fs.readDir('/')\n"
              "fs.stat('/o.txt')\n"
              "export const done = 1\n",
              root);
    nftw(root, rm_cb, 8, FTW_DEPTH | FTW_PHYS);
}

TEST_CASE("abort globals fail cleanly at every allocation point" * doctest::test_suite("oom")) {
    /* The lazy getters evaluate the mikro/abort bytecode on first access;
     * under injection that load and the controller wiring must fail clean. */
    oom_sweep("abort",
              "void AbortSignal; void AbortError; void TimeoutError\n"
              "const c = new AbortController()\n"
              "c.abort('why')\n"
              "export const done = String(c.signal.aborted)\n",
              nullptr);
}

TEST_CASE("fs module loading fails cleanly at every allocation point" *
          doctest::test_suite("oom")) {
    char root[64];
    snprintf(root, sizeof(root), "/tmp/mik_oom_mods_XXXXXX");
    REQUIRE(mkdtemp(root) != nullptr);
    auto write = [&](const char* rel, const char* data, size_t len) {
        std::string path = std::string(root) + rel;
        FILE* f = fopen(path.c_str(), "wb");
        REQUIRE(f != nullptr);
        REQUIRE(fwrite(data, 1, len, f) == len);
        fclose(f);
    };
    write("/lib.js", "export const v = 1\n", 19);
    write("/cfg.json", "{\"a\": [1, 2, {\"b\": true}]}", 26);
    write("/note.txt", "text payload", 12);
    {
        /* serialize a .bjs and a .bjson in a scratch runtime */
        MIKRuntime* scratch = MIK_NewRuntime();
        REQUIRE(scratch != nullptr);
        JSContext* sctx = MIK_GetJSContext(scratch);
        const char* msrc = "export const b = 2\n";
        JSValue mod = JS_Eval(sctx, msrc, strlen(msrc), "/pre.bjs",
                              JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
        REQUIRE(!JS_IsException(mod));
        size_t size = 0;
        uint8_t* buf = JS_WriteObject(sctx, &size, mod, JS_WRITE_OBJ_BYTECODE);
        JS_FreeValue(sctx, mod);
        REQUIRE(buf != nullptr);
        write("/pre.bjs", (const char*)buf, size);
        js_free(sctx, buf);
        JSValue val = JS_ParseJSON(sctx, "{\"n\": 7}", 8, "<b>");
        REQUIRE(!JS_IsException(val));
        buf = JS_WriteObject(sctx, &size, val, 0);
        JS_FreeValue(sctx, val);
        REQUIRE(buf != nullptr);
        write("/data.bjson", (const char*)buf, size);
        js_free(sctx, buf);
        MIK_FreeRuntime(scratch);
    }

    /* absolute specifiers: the driver module name has no directory */
    oom_sweep("module-loading",
              "import {v} from '/lib.js'\n"
              "import cfg from '/cfg.json'\n"
              "import note from '/note.txt'\n"
              "import {b} from '/pre.bjs'\n"
              "import data from '/data.bjson'\n"
              "export const done = v + b + data.n + cfg.a.length + note.length\n",
              root);
    nftw(root, rm_cb, 8, FTW_DEPTH | FTW_PHYS);
}

TEST_CASE("result chains and text codecs fail cleanly at every allocation point" *
          doctest::test_suite("oom")) {
    oom_sweep("result-text",
              "import {ok, err} from 'mikro/result'\n"
              "ok(1).map((v) => v + 1).andThen(() => err({name: 'E'}))\n"
              "  .mapErr((e) => e).orDefault(0)\n"
              "const bytes = new TextEncoder().encode('héllo ✓')\n"
              "new TextDecoder().decode(bytes)\n"
              "atob(btoa('abc'))\n"
              "export const done = 1\n",
              nullptr);
}

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

/* Emit benchmark entries for a checkpoint in the customSmallerIsBetter
 * format expected by github-action-benchmark: `{name, unit, value, extra}`.
 * We emit trackable metrics per checkpoint (total heap, live allocs, bytecode)
 * and stash the full JSMemoryUsage breakdown in the `extra` field of the first
 * entry for one-off inspection. */
static void dump(const char* label, JSRuntime* rt, bool last) {
    JSMemoryUsage m;
    JS_ComputeMemoryUsage(rt, &m);

    /* Theoretical savings from per-object tweaks we've analyzed:
     *   weakref_side_table: drop `first_weak_ref` pointer (4 B on 32-bit)
     *     from JSObject and JSString, move to a runtime-level side table.
     *     Atoms are JSStrings and also pay this tax.
     *   shape_shrink: pack JSShape::prop_size/prop_count/deleted_prop_count
     *     to uint16_t and merge is_hashed into GC header slack (~8 B/shape). */
    long long weakref_side_table =
        (m.obj_count + m.str_count + m.atom_count) * 4LL;
    long long shape_shrink = m.shape_count * 8LL;

    printf("  {\"name\": \"%s — Total Memory\", \"unit\": \"KB\", "
           "\"value\": %.2f, \"extra\": \"bytes=%lld mallocs=%lld "
           "obj=%lld/%lld shape=%lld/%lld prop=%lld/%lld str=%lld/%lld "
           "atom=%lld/%lld jsfunc=%lld/%lld pc2line=%lld/%lld "
           "save_weakref=%lld save_shape=%lld\"},\n",
           label, m.memory_used_size / 1024.0,
           (long long)m.memory_used_size, (long long)m.malloc_count,
           (long long)m.obj_count, (long long)m.obj_size,
           (long long)m.shape_count, (long long)m.shape_size,
           (long long)m.prop_count, (long long)m.prop_size,
           (long long)m.str_count, (long long)m.str_size,
           (long long)m.atom_count, (long long)m.atom_size,
           (long long)m.js_func_count, (long long)m.js_func_size,
           (long long)m.js_func_pc2line_count, (long long)m.js_func_pc2line_size,
           weakref_side_table, shape_shrink);
    printf("  {\"name\": \"%s — Bytecode\", \"unit\": \"KB\", "
           "\"value\": %.2f, \"extra\": \"js_func_code_size=%lld bytes, "
           "%lld functions\"},\n",
           label, m.js_func_code_size / 1024.0,
           (long long)m.js_func_code_size, (long long)m.js_func_count);
    printf("  {\"name\": \"%s — Live Allocations\", \"unit\": \"count\", "
           "\"value\": %lld, \"extra\": \"live malloc slots; churn proxy\"}%s\n",
           label, (long long)m.malloc_count, last ? "" : ",");
}

static void eval_or_die(JSContext* ctx, const char* name, const char* code) {
    JSValue ret = MIK_EvalModuleContent(ctx, name, code, strlen(code));
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        const char* msg = JS_ToCString(ctx, exc);
        fprintf(stderr, "eval failed for %s: %s\n", name, msg ? msg : "?");
        if (msg) JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, ret);
        /* Abort so CI fails loudly instead of emitting bogus checkpoints
         * attributed to a step that didn't actually run. */
        exit(1);
    }
    JS_FreeValue(ctx, ret);
}

int main() {
    auto* mik_rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(mik_rt);
    auto* rt = JS_GetRuntime(ctx);

    /* Touch import.meta to make sure the module machinery is warm. */
    eval_or_die(ctx, "/bench/main.js", "import.meta.url");

    printf("[\n");
    dump("runtime_init", rt, false);

    /* Load runtime modules incrementally to attribute per-builtin memory
     * cost. ESP-only modules (wifi, pin, fetch, pwm, spi, i2c, uart, sntp,
     * neopixel, sleep, kv, test) depend on `native:*` modules that only
     * register in the firmware build; on host we link `native_stubs.cpp`
     * which provides no-op replacements so JS module evaluation succeeds.
     * Numbers reflect JS bytecode + intrinsic pull-in only — real on-device
     * cost includes native driver state (WiFi heap, HTTP buffers, …) that
     * the stubs do not allocate. ble is excluded: not in the host bytecode
     * module list (firmware-only build flag). */
    static const struct {
        const char* label;
        const char* code;
    } modules[] = {
        {"+ result", "import {ok, err} from 'mikrojs/result'"},
        {"+ sys", "import {memoryUsage} from 'mikrojs/sys'"},
        {"+ stdio", "import {stdout} from 'mikrojs/stdio'"},
        {"+ cbor", "import {encode, decode} from 'mikrojs/cbor'"},
        {"+ schema", "import {object, string, number} from 'mikrojs/schema'"},
        {"+ env", "import {env} from 'mikrojs/env'"},
        {"+ fs", "import {readFile} from 'mikrojs/fs'"},
        {"+ reader", "import {BufferedReader} from 'mikrojs/reader'"},
        {"+ stream", "import {decodeUtf8, splitLines} from 'mikrojs/stream'"},
        {"+ pin", "import {pinMode, digitalWrite} from 'mikrojs/pin'"},
        {"+ sleep", "import {sleep, deepSleep} from 'mikrojs/sleep'"},
        {"+ sntp", "import {sntp} from 'mikrojs/sntp'"},
        {"+ neopixel", "import {NeoPixel} from 'mikrojs/neopixel'"},
        {"+ pwm", "import {Pwm} from 'mikrojs/pwm'"},
        {"+ spi", "import {Spi} from 'mikrojs/spi'"},
        {"+ i2c", "import {I2c} from 'mikrojs/i2c'"},
        {"+ uart", "import {Uart} from 'mikrojs/uart'"},
        {"+ wifi", "import {wifi} from 'mikrojs/wifi'"},
        {"+ http/request", "import {request} from 'mikrojs/http/request'"},
        {"+ kv/nvs", "import {nvsStorage} from 'mikrojs/kv/nvs'"},
        {"+ kv/rtc", "import {rtcStorage} from 'mikrojs/kv/rtc'"},
        {"+ test", "import {describe, test} from 'mikrojs/test'"},
    };
    int n = sizeof(modules) / sizeof(modules[0]);

    for (int i = 0; i < n; i++) {
        eval_or_die(ctx, "/bench/load.js", modules[i].code);
        dump(modules[i].label, rt, false);
    }

    /* Force a full GC and report steady-state memory after module load.
     * This is the "what you actually pay" number: all load-time garbage
     * reclaimed, intrinsics stabilized. */
    JS_RunGC(rt);
    dump("steady_state (post-GC)", rt, false);

    /* Small JS workload to exercise allocation, property access, closures,
     * and JSON. Measures the incremental cost of "running typical code"
     * beyond just loading modules. */
    /* IIFE so locals are collectable after the workload runs; only the
     * final integer sum escapes into globalThis.__bench_sink. */
    const char* workload =
        "globalThis.__bench_sink = (() => {\n"
        "  const arr = Array.from({length: 200}, (_, i) => ({id: i, s: 'x' + i}));\n"
        "  let acc = 0;\n"
        "  for (const o of arr) acc += o.id + o.s.length;\n"
        "  JSON.parse(JSON.stringify(arr));\n"
        "  return acc;\n"
        "})();\n";
    eval_or_die(ctx, "/bench/workload.js", workload);
    dump("workload_peak", rt, false);

    /* GC again to see the steady-state after workload (objects dropped). */
    JS_RunGC(rt);
    dump("workload_settled (post-GC)", rt, true);

    printf("]\n");

    MIK_FreeRuntime(mik_rt);
    return 0;
}

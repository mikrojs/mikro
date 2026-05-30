#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include <mikrojs/mikrojs.h>
#include <quickjs.h>

static std::string read_file(const char* path) {
    std::ifstream f(path);
    if (!f) {
        fprintf(stderr, "cannot open %s\n", path);
        std::exit(1);
    }
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static void dump(const char* label, JSRuntime* rt) {
    JSMemoryUsage m;
    JS_ComputeMemoryUsage(rt, &m);
    printf("  \"%s\": {\n", label);
    printf("    \"total_bytes\": %lld, \"mallocs\": %lld,\n",
           (long long)m.memory_used_size, (long long)m.malloc_count);
    printf("    \"obj_count\": %lld, \"obj_size\": %lld,\n",
           (long long)m.obj_count, (long long)m.obj_size);
    printf("    \"shape_count\": %lld, \"shape_size\": %lld,\n",
           (long long)m.shape_count, (long long)m.shape_size);
    printf("    \"prop_count\": %lld, \"prop_size\": %lld,\n",
           (long long)m.prop_count, (long long)m.prop_size);
    printf("    \"str_count\": %lld, \"str_size\": %lld,\n",
           (long long)m.str_count, (long long)m.str_size);
    printf("    \"atom_count\": %lld, \"atom_size\": %lld,\n",
           (long long)m.atom_count, (long long)m.atom_size);
    printf("    \"js_func_count\": %lld, \"js_func_size\": %lld, "
           "\"js_func_code_size\": %lld,\n",
           (long long)m.js_func_count, (long long)m.js_func_size,
           (long long)m.js_func_code_size);
    printf("    \"pc2line_count\": %lld, \"pc2line_size\": %lld\n",
           (long long)m.js_func_pc2line_count, (long long)m.js_func_pc2line_size);
    printf("  }");
}

static void run(const char* label, const char* source_path, bool last) {
    std::string source = read_file(source_path);

    auto* mik_rt = MIK_NewRuntime();
    auto* ctx = MIK_GetJSContext(mik_rt);
    auto* rt = JS_GetRuntime(ctx);

    // Warm the module machinery (same as memory_bench.cpp).
    const char* init = "import.meta.url";
    JSValue ret = MIK_EvalModuleContent(ctx, "/bench/main.js", init, strlen(init));
    JS_FreeValue(ctx, ret);

    JSMemoryUsage before;
    JS_ComputeMemoryUsage(rt, &before);

    // Use a "mikro/" prefixed name so the module normalizer treats the
    // entry as a privileged module and allows `native:*` imports — normal
    // user code cannot import native: directly, only the official runtime
    // modules can. For this benchmark we're simulating what a bundled user
    // app WOULD look like if it were allowed to inline runtime modules.
    ret = MIK_EvalModuleContent(ctx, "mikro/bench_app.js", source.c_str(), source.size());
    if (JS_IsException(ret)) {
        JSValue exc = JS_GetException(ctx);
        const char* msg = JS_ToCString(ctx, exc);
        fprintf(stderr, "eval failed: %s\n", msg ? msg : "(unknown)");
        if (msg) JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, ret);
        MIK_FreeRuntime(mik_rt);
        std::exit(1);
    }
    JS_FreeValue(ctx, ret);

    // Force GC so the comparison is fair (unreferenced transient state gone).
    JS_RunGC(rt);

    JSMemoryUsage after;
    JS_ComputeMemoryUsage(rt, &after);

    printf("  \"%s\": {\n", label);
    printf("    \"source_path\": \"%s\", \"source_bytes\": %zu,\n",
           source_path, source.size());
    printf("    \"before_total\": %lld, \"after_total\": %lld, \"delta_total\": %lld,\n",
           (long long)before.memory_used_size, (long long)after.memory_used_size,
           (long long)(after.memory_used_size - before.memory_used_size));
    printf("    \"delta_obj\": %lld, \"delta_obj_size\": %lld,\n",
           (long long)(after.obj_count - before.obj_count),
           (long long)(after.obj_size - before.obj_size));
    printf("    \"delta_shape\": %lld, \"delta_shape_size\": %lld,\n",
           (long long)(after.shape_count - before.shape_count),
           (long long)(after.shape_size - before.shape_size));
    printf("    \"delta_prop\": %lld, \"delta_prop_size\": %lld,\n",
           (long long)(after.prop_count - before.prop_count),
           (long long)(after.prop_size - before.prop_size));
    printf("    \"delta_atom\": %lld, \"delta_atom_size\": %lld,\n",
           (long long)(after.atom_count - before.atom_count),
           (long long)(after.atom_size - before.atom_size));
    printf("    \"delta_str\": %lld, \"delta_str_size\": %lld,\n",
           (long long)(after.str_count - before.str_count),
           (long long)(after.str_size - before.str_size));
    printf("    \"delta_js_func\": %lld, \"delta_js_func_size\": %lld, "
           "\"delta_js_func_code_size\": %lld,\n",
           (long long)(after.js_func_count - before.js_func_count),
           (long long)(after.js_func_size - before.js_func_size),
           (long long)(after.js_func_code_size - before.js_func_code_size));
    printf("    \"delta_pc2line_size\": %lld\n",
           (long long)(after.js_func_pc2line_size - before.js_func_pc2line_size));
    printf("  }%s\n", last ? "" : ",");

    MIK_FreeRuntime(mik_rt);
}

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <unbundled.js> <bundled.js>\n", argv[0]);
        return 1;
    }
    printf("{\n");
    run("unbundled", argv[1], false);
    run("bundled", argv[2], true);
    printf("}\n");
    return 0;
}

#include <napi.h>
#include <quickjs.h>

#include <string>
#include <vector>

#include "runtime_wrap.h"

/**
 * jsonToBjson(jsonString: string): Buffer
 *
 * Parse a JSON string and serialize the resulting value to QuickJS binary JSON (bjson).
 * Uses a temporary QuickJS context — no MIKRuntime needed.
 */
static Napi::Value JsonToBjson(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "jsonToBjson expects a string argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string json = info[0].As<Napi::String>().Utf8Value();

    JSRuntime* rt = JS_NewRuntime();
    if (!rt) {
        Napi::Error::New(env, "Failed to create QuickJS runtime").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    JSContext* ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        Napi::Error::New(env, "Failed to create QuickJS context").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    JSValue val = JS_ParseJSON(ctx, json.c_str(), json.size(), "<json>");
    if (JS_IsException(val)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        Napi::Error::New(env, "Failed to parse JSON").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    size_t len = 0;
    uint8_t* buf = JS_WriteObject(ctx, &len, val, 0);
    JS_FreeValue(ctx, val);

    if (!buf) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        Napi::Error::New(env, "Failed to serialize to bjson").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto result = Napi::Buffer<uint8_t>::Copy(env, buf, len);
    js_free(ctx, buf);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

    return result;
}

/**
 * Dummy init callback for external modules registered during compilation.
 * Should never be called — compilation only parses, it doesn't evaluate.
 */
static int dummy_module_init(JSContext* ctx, JSModuleDef* m) {
    abort();
    return -1;
}

/**
 * compileBytecode(source: string, moduleName: string, externals?: string[]): Buffer
 *
 * Compile a JS module to QuickJS bytecode, stripping source and debug info.
 * External module specifiers (imports that shouldn't be resolved) must be
 * passed in the `externals` array so they're registered as dummy modules.
 */
static Napi::Value CompileBytecode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "compileBytecode(source, moduleName, externals?)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string source = info[0].As<Napi::String>().Utf8Value();
    std::string module_name = info[1].As<Napi::String>().Utf8Value();

    /* Collect external module specifiers */
    std::vector<std::string> externals;
    if (info.Length() > 2 && info[2].IsArray()) {
        Napi::Array arr = info[2].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); i++) {
            Napi::Value v = arr[i];
            if (v.IsString()) {
                externals.push_back(v.As<Napi::String>().Utf8Value());
            }
        }
    }

    JSRuntime* rt = JS_NewRuntime();
    if (!rt) {
        Napi::Error::New(env, "Failed to create QuickJS runtime").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    JSContext* ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        Napi::Error::New(env, "Failed to create QuickJS context").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    /* Register external modules as dummy C modules so the compiler
       doesn't try to load them from the filesystem */
    for (const auto& ext : externals) {
        JSModuleDef* m = JS_NewCModule(ctx, ext.c_str(), dummy_module_init);
        if (!m) {
            JS_FreeContext(ctx);
            JS_FreeRuntime(rt);
            std::string err = "Failed to register external module: " + ext;
            Napi::Error::New(env, err).ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    /* Compile the module (parse only, no evaluation) */
    JSValue obj = JS_Eval(ctx, source.c_str(), source.size(), module_name.c_str(),
                          JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(obj)) {
        JSValue exc = JS_GetException(ctx);
        const char* msg = JS_ToCString(ctx, exc);
        std::string err = msg ? msg : "Compilation failed";
        if (msg) JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        Napi::Error::New(env, err).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    /* Serialize to bytecode, stripping source but keeping debug info (filenames
       are needed for dynamic import() to resolve relative specifiers) */
    size_t len = 0;
    int flags = JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_STRIP_SOURCE;
    uint8_t* buf = JS_WriteObject(ctx, &len, obj, flags);
    JS_FreeValue(ctx, obj);

    if (!buf) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        Napi::Error::New(env, "Failed to serialize bytecode").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto result = Napi::Buffer<uint8_t>::Copy(env, buf, len);
    js_free(ctx, buf);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    RuntimeWrap::Init(env, exports);
    exports.Set("jsonToBjson", Napi::Function::New(env, JsonToBjson));
    exports.Set("compileBytecode", Napi::Function::New(env, CompileBytecode));
    return exports;
}

NODE_API_MODULE(mikrojs_node, Init)

#pragma once

#include <map>
#include <string>
#include <utility>
#include <vector>

#include <napi.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"

/* Bidirectional message bridge between QuickJS (native:mikro/host) and Node.js. */
struct HostBridge {
    std::vector<std::pair<std::string, std::string>> outbound_messages;
    std::vector<std::pair<std::string, std::string>> inbound_messages;
    JSValue on_message_callback = JS_UNDEFINED;

    /* Synchronous RPC handler: called from QuickJS via native:mikro/host.call() */
    Napi::FunctionReference rpc_handler;
    napi_env current_env = nullptr;

    /* Pending async RPC calls: id → {resolve, reject} QuickJS functions */
    struct PendingRpc {
        JSValue resolve;
        JSValue reject;
    };
    std::map<uint32_t, PendingRpc> pending_rpc;
};

class RuntimeWrap : public Napi::ObjectWrap<RuntimeWrap> {
   public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    RuntimeWrap(const Napi::CallbackInfo& info);
    ~RuntimeWrap() override;

   private:
    Napi::Value EvalModule(const Napi::CallbackInfo& info);
    Napi::Value EvalModuleContent(const Napi::CallbackInfo& info);
    Napi::Value EvalScript(const Napi::CallbackInfo& info);
    Napi::Value EvalForRepl(const Napi::CallbackInfo& info);
    Napi::Value Loop(const Napi::CallbackInfo& info);
    Napi::Value LoopOnce(const Napi::CallbackInfo& info);
    void Stop(const Napi::CallbackInfo& info);
    void Dispose(const Napi::CallbackInfo& info);

    /* Virtual module registration */
    void RegisterModuleSource(const Napi::CallbackInfo& info);

    /* Host message channel */
    Napi::Value DrainMessages(const Napi::CallbackInfo& info);
    void PostMessage(const Napi::CallbackInfo& info);

    /* Synchronous RPC handler */
    void SetRpcHandler(const Napi::CallbackInfo& info);

    /* Memory profiling */
    void EnableProfiling(const Napi::CallbackInfo& info);
    Napi::Value GetProfile(const Napi::CallbackInfo& info);
    Napi::Value GetProfileBaseline(const Napi::CallbackInfo& info);

    /* Memory inspection / GC trigger — mirrors what the firmware's REPL
     * directives do directly via JS_ComputeMemoryUsage / JS_RunGC. Lets the
     * sim's /mem and /gc directives run without polluting globalThis with
     * __simMemoryUsage / __simGc shims. */
    Napi::Value MemoryUsage(const Napi::CallbackInfo& info);
    void Gc(const Napi::CallbackInfo& info);

    /* Install the test-helper globals (__testEmit / __testFileDone). Opt-in
     * so ordinary dev runs don't carry the bindings. Mirrors what the
     * firmware's mikro_main.cpp supervisor does per test file. */
    void EnableTestHelpers(const Napi::CallbackInfo& info);

    MIKRuntime* mik_rt_ = nullptr;
    std::string fs_base_path_;
    std::string fs_root_;
    HostBridge* host_bridge_ = nullptr;
    int host_slot_ = -1;

    /* Preprocessor callback (e.g. TypeScript type stripping) */
    void SetPreprocessor(const Napi::CallbackInfo& info);
    Napi::FunctionReference preprocess_fn_;
    napi_env current_env_ = nullptr;
    static char* PreprocessCallback(const char* filename, const char* source, size_t source_len,
                                    size_t* out_len, void* opaque);

    /* Error handler — forwards uncaught errors to the host bridge */
    static void ErrorHandlerCallback(JSContext* ctx, JSValue error, void* opaque);

    /* OOM handler — forwards low-heap events to the host bridge as a
     * dedicated `oom` message. Does not touch QuickJS memory; safe to
     * invoke while the JS heap is exhausted. */
    static void OOMHandlerCallback(const MIKOOMEvent* event, void* opaque);

    /* Test-emit handler — routes __testEmit() payloads to the host bridge
     * as `test` messages, replacing the JS-side globalThis.__testEmit shim
     * the simulator used to install. */
    static void TestEmitHandlerCallback(const char* json, size_t len, void* opaque);

    /* Forward declare — defined in runtime_wrap.cpp */
    class LoopWorker* loop_worker_ = nullptr;
};

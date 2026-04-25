#include "runtime_wrap.h"

#include <atomic>

#include <quickjs.h>

#include "mikrojs/private.h"
#include "mikrojs/utils.h"

#ifndef countof
#define countof(x) (sizeof(x) / sizeof((x)[0]))
#endif

/* Declared in platform_node.cpp */
extern "C" const MIKPlatform* MIK_NodePlatform(void);

/* Dynamic module data slot for the host bridge, set during RuntimeWrap construction */
static int s_host_slot = -1;

/* ── AsyncWorker for MIK_Loop ────────────────────────────────────── */

class LoopWorker : public Napi::AsyncWorker {
   public:
    LoopWorker(Napi::Env env, MIKRuntime* mik_rt)
        : Napi::AsyncWorker(env),
          deferred_(Napi::Promise::Deferred::New(env)),
          mik_rt_(mik_rt) {}

    Napi::Promise::Deferred& Deferred() { return deferred_; }

    void Execute() override {
        while (!stopped_.load()) {
            int rc = MIK_Loop(mik_rt_);
            if (rc != 0) {
                SetError("MIK_Loop returned error");
                break;
            }
            MIK_GetPlatform()->yield();
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        deferred_.Resolve(Env().Undefined());
    }

    void OnError(const Napi::Error& err) override {
        Napi::HandleScope scope(Env());
        deferred_.Reject(err.Value());
    }

    void SignalStop() { stopped_.store(true); }

   private:
    Napi::Promise::Deferred deferred_;
    MIKRuntime* mik_rt_;
    std::atomic<bool> stopped_{false};
};

/* ── native:host C module ──────────────────────────────────────────── */

static JSValue mik__host_send(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* bridge = static_cast<HostBridge*>(MIK_GetModuleData(mik_rt, s_host_slot));
    if (!bridge) {
        return JS_ThrowInternalError(ctx, "native:host bridge not initialized");
    }

    const char* type = JS_ToCString(ctx, argv[0]);
    if (!type) return JS_EXCEPTION;
    const char* data = argc > 1 ? JS_ToCString(ctx, argv[1]) : nullptr;

    bridge->outbound_messages.emplace_back(type, data ? data : "");

    JS_FreeCString(ctx, type);
    if (data) JS_FreeCString(ctx, data);
    return JS_UNDEFINED;
}

static JSValue mik__host_on_message(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* bridge = static_cast<HostBridge*>(MIK_GetModuleData(mik_rt, s_host_slot));
    if (!bridge) {
        return JS_ThrowInternalError(ctx, "native:host bridge not initialized");
    }

    if (!JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "onMessage expects a function");
    }

    if (!JS_IsUndefined(bridge->on_message_callback)) {
        JS_FreeValue(ctx, bridge->on_message_callback);
    }
    bridge->on_message_callback = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

static JSValue mik__host_call(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* bridge = static_cast<HostBridge*>(MIK_GetModuleData(mik_rt, s_host_slot));
    if (!bridge) {
        return JS_ThrowInternalError(ctx, "native:host bridge not initialized");
    }
    if (bridge->rpc_handler.IsEmpty() || !bridge->current_env) {
        return JS_ThrowInternalError(ctx, "native:host RPC handler not set");
    }

    const char* method = JS_ToCString(ctx, argv[0]);
    if (!method) return JS_EXCEPTION;
    const char* args_json = argc > 1 ? JS_ToCString(ctx, argv[1]) : nullptr;

    napi_env nenv = bridge->current_env;
    Napi::Env env(nenv);
    Napi::HandleScope scope(env);

    Napi::Value result;
    try {
        result = bridge->rpc_handler.Call(
            {Napi::String::New(env, method),
             Napi::String::New(env, args_json ? args_json : "[]")});
    } catch (const Napi::Error& e) {
        JS_FreeCString(ctx, method);
        if (args_json) JS_FreeCString(ctx, args_json);
        return JS_ThrowInternalError(ctx, "RPC handler error: %s", e.Message().c_str());
    }

    JS_FreeCString(ctx, method);
    if (args_json) JS_FreeCString(ctx, args_json);

    /* If the N-API result is a Promise, bridge it to a QuickJS Promise */
    bool is_promise = false;
    napi_is_promise(nenv, result, &is_promise);

    if (is_promise) {
        /* Create a QuickJS Promise via JS_NewPromiseCapability */
        JSValue resolving_funcs[2];
        JSValue qjs_promise = JS_NewPromiseCapability(ctx, resolving_funcs);
        if (JS_IsException(qjs_promise)) {
            return JS_EXCEPTION;
        }

        /* Dup the resolve/reject so they survive this scope */
        JSValue resolve = JS_DupValue(ctx, resolving_funcs[0]);
        JSValue reject = JS_DupValue(ctx, resolving_funcs[1]);
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);

        /* Attach .then(onFulfilled, onRejected) to the N-API Promise.
         * The callbacks post inbound messages that resolve/reject the QJS promise
         * on the next loop tick via the existing message channel. */

        /* Generate a unique RPC ID for this async call */
        static uint32_t rpc_id_counter = 0;
        uint32_t rpc_id = rpc_id_counter++;

        /* Store the resolve/reject functions keyed by rpc_id on the bridge.
         * We'll use the inbound message channel to deliver results. */

        /* Create N-API functions for .then() */
        auto* bridge_ptr = bridge;

        Napi::Function on_fulfilled = Napi::Function::New(env, [bridge_ptr, ctx, resolve, reject,
                                                                 rpc_id](const Napi::CallbackInfo& info) {
            std::string result_json;
            if (info.Length() > 0 && info[0].IsString()) {
                result_json = info[0].As<Napi::String>().Utf8Value();
            } else {
                result_json = "null";
            }
            /* Post the result as an inbound message for the QJS side */
            std::string type = "__rpc:resolve:" + std::to_string(rpc_id);
            bridge_ptr->inbound_messages.emplace_back(type, result_json);

            /* Store resolve/reject in a side table on the bridge for pickup */
            bridge_ptr->pending_rpc[rpc_id] = {resolve, reject};
        });

        Napi::Function on_rejected = Napi::Function::New(
            env, [bridge_ptr, ctx, resolve, reject, rpc_id](const Napi::CallbackInfo& info) {
                std::string err_msg = "RPC error";
                if (info.Length() > 0 && info[0].IsString()) {
                    err_msg = info[0].As<Napi::String>().Utf8Value();
                } else if (info.Length() > 0) {
                    Napi::Value val = info[0];
                    if (val.IsObject()) {
                        Napi::Object obj = val.As<Napi::Object>();
                        if (obj.Has("message")) {
                            err_msg = obj.Get("message").As<Napi::String>().Utf8Value();
                        }
                    }
                }
                std::string type = "__rpc:reject:" + std::to_string(rpc_id);
                bridge_ptr->inbound_messages.emplace_back(type, err_msg);
                bridge_ptr->pending_rpc[rpc_id] = {resolve, reject};
            });

        /* Call promise.then(onFulfilled, onRejected) */
        Napi::Object promise_obj = result.As<Napi::Object>();
        promise_obj.Get("then").As<Napi::Function>().Call(promise_obj, {on_fulfilled, on_rejected});

        return qjs_promise;
    }

    /* Synchronous result — return as a JSValue string */
    if (result.IsUndefined() || result.IsNull()) {
        return JS_UNDEFINED;
    }

    std::string result_str = result.As<Napi::String>().Utf8Value();
    return JS_NewString(ctx, result_str.c_str());
}

static const JSCFunctionListEntry mik__host_funcs[] = {
    JS_CFUNC_DEF("send", 2, mik__host_send),
    JS_CFUNC_DEF("onMessage", 1, mik__host_on_message),
    JS_CFUNC_DEF("call", 2, mik__host_call),
};

static int mik__host_module_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExportList(ctx, m, mik__host_funcs, countof(mik__host_funcs));
}

/* Loop consumer: delivers inbound messages to the JS onMessage callback */
static void mik__host_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* bridge = static_cast<HostBridge*>(MIK_GetModuleData(mik_rt, s_host_slot));
    if (!bridge) return;
    if (bridge->inbound_messages.empty()) return;

    /* Move messages out so the callback can safely post new messages */
    auto messages = std::move(bridge->inbound_messages);
    bridge->inbound_messages.clear();

    for (const auto& [type, data] : messages) {
        /* Handle async RPC resolve/reject messages */
        if (type.starts_with("__rpc:resolve:") || type.starts_with("__rpc:reject:")) {
            bool is_resolve = type.starts_with("__rpc:resolve:");
            uint32_t rpc_id = std::stoul(type.substr(is_resolve ? 14 : 13));
            auto it = bridge->pending_rpc.find(rpc_id);
            if (it != bridge->pending_rpc.end()) {
                JSValue func = is_resolve ? it->second.resolve : it->second.reject;
                JSValue other = is_resolve ? it->second.reject : it->second.resolve;
                JSValue arg;
                if (is_resolve) {
                    arg = data.empty() ? JS_UNDEFINED : JS_NewString(ctx, data.c_str());
                } else {
                    arg = JS_NewError(ctx);
                    JS_SetPropertyStr(ctx, arg, "message", JS_NewString(ctx, data.c_str()));
                }
                JSValue ret = JS_Call(ctx, func, JS_UNDEFINED, 1, &arg);
                JS_FreeValue(ctx, arg);
                JS_FreeValue(ctx, ret);
                JS_FreeValue(ctx, func);
                JS_FreeValue(ctx, other);
                bridge->pending_rpc.erase(it);
            }
            continue;
        }

        /* Regular messages — deliver to onMessage callback if set */
        if (!JS_IsUndefined(bridge->on_message_callback)) {
            JSValue args[2] = {
                JS_NewString(ctx, type.c_str()),
                JS_NewString(ctx, data.c_str()),
            };
            JSValue ret = JS_Call(ctx, bridge->on_message_callback, JS_UNDEFINED, 2, args);
            JS_FreeValue(ctx, args[0]);
            JS_FreeValue(ctx, args[1]);
            if (JS_IsException(ret)) {
                mik_dump_error(ctx);
            }
            JS_FreeValue(ctx, ret);
        }
    }
}

static void mik__host_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    auto* bridge = static_cast<HostBridge*>(MIK_GetModuleData(mik_rt, s_host_slot));
    if (!bridge) return;
    if (!JS_IsUndefined(bridge->on_message_callback)) {
        JS_FreeValue(ctx, bridge->on_message_callback);
        bridge->on_message_callback = JS_UNDEFINED;
    }
    /* Free any pending RPC resolve/reject functions */
    for (auto& [id, rpc] : bridge->pending_rpc) {
        JS_FreeValue(ctx, rpc.resolve);
        JS_FreeValue(ctx, rpc.reject);
    }
    bridge->pending_rpc.clear();
    /* Bridge memory is owned by RuntimeWrap, freed in destructor */
}

/* ── RuntimeWrap ─────────────────────────────────────────────────── */

Napi::Object RuntimeWrap::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MikroRuntime",
                                      {
                                          InstanceMethod("evalModule", &RuntimeWrap::EvalModule),
                                          InstanceMethod("evalModuleContent", &RuntimeWrap::EvalModuleContent),
                                          InstanceMethod("evalScript", &RuntimeWrap::EvalScript),
                                          InstanceMethod("loop", &RuntimeWrap::Loop),
                                          InstanceMethod("loopOnce", &RuntimeWrap::LoopOnce),
                                          InstanceMethod("stop", &RuntimeWrap::Stop),
                                          InstanceMethod("dispose", &RuntimeWrap::Dispose),
                                          InstanceMethod("registerModuleSource", &RuntimeWrap::RegisterModuleSource),
                                          InstanceMethod("drainMessages", &RuntimeWrap::DrainMessages),
                                          InstanceMethod("postMessage", &RuntimeWrap::PostMessage),
                                          InstanceMethod("setPreprocessor", &RuntimeWrap::SetPreprocessor),
                                          InstanceMethod("setRpcHandler", &RuntimeWrap::SetRpcHandler),
                                          InstanceMethod("enableProfiling", &RuntimeWrap::EnableProfiling),
                                          InstanceMethod("getProfile", &RuntimeWrap::GetProfile),
                                          InstanceMethod("getProfileBaseline", &RuntimeWrap::GetProfileBaseline),
                                      });

    Napi::FunctionReference* constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("MikroRuntime", func);
    return exports;
}

RuntimeWrap::RuntimeWrap(const Napi::CallbackInfo& info) : Napi::ObjectWrap<RuntimeWrap>(info) {
    Napi::Env env = info.Env();

    /* Set the Node.js platform before creating the runtime */
    MIK_SetPlatform(MIK_NodePlatform());

    MIKRunOptions options;
    MIK_DefaultOptions(&options);

    Napi::Object opts;
    if (info.Length() > 0 && info[0].IsObject()) {
        opts = info[0].As<Napi::Object>();
        if (opts.Has("memLimit")) {
            options.mem_limit = opts.Get("memLimit").As<Napi::Number>().Int32Value();
        }
        if (opts.Has("stackSize")) {
            options.stack_size = opts.Get("stackSize").As<Napi::Number>().Uint32Value();
        }
    }

    mik_rt_ = MIK_NewRuntimeOptions(&options);
    if (!mik_rt_) {
        Napi::Error::New(env, "Failed to create MikroJS runtime").ThrowAsJavaScriptException();
        return;
    }

    /* Register native:host C module + host bridge */
    host_bridge_ = new HostBridge();
    host_slot_ = MIK_AllocModuleSlot(mik_rt_);
    s_host_slot = host_slot_;
    MIK_SetModuleData(mik_rt_, host_slot_, host_bridge_);

    JSContext* ctx = MIK_GetJSContext(mik_rt_);
    JSModuleDef* host_mod = JS_NewCModule(ctx, "native:host", mik__host_module_init);
    if (host_mod) {
        JS_AddModuleExportList(ctx, host_mod, mik__host_funcs, countof(mik__host_funcs));
    }

    MIK_RegisterLoopConsumer(mik_rt_, mik__host_consume, mik__host_destroy);
    MIK_SetErrorHandler(mik_rt_, ErrorHandlerCallback, this);
    MIK_SetOOMHandler(mik_rt_, OOMHandlerCallback, this);

    /* Apply one-time options that must be set before evalModule */
    if (!opts.IsEmpty()) {
        if (opts.Has("fsBasePath") && opts.Get("fsBasePath").IsString()) {
            fs_base_path_ = opts.Get("fsBasePath").As<Napi::String>().Utf8Value();
            MIK_SetFSBasePath(mik_rt_, fs_base_path_.c_str());
        }

        if (opts.Has("fsRoot") && opts.Get("fsRoot").IsString()) {
            fs_root_ = opts.Get("fsRoot").As<Napi::String>().Utf8Value();
            MIK_SetFSRoot(mik_rt_, fs_root_.c_str());
        }

        if (opts.Has("fsLimit") && opts.Get("fsLimit").IsNumber()) {
            MIK_SetFSLimit(mik_rt_, opts.Get("fsLimit").As<Napi::Number>().Uint32Value());
        }

        if (opts.Has("fsReadMax") && opts.Get("fsReadMax").IsNumber()) {
            MIK_SetFSReadMax(mik_rt_, opts.Get("fsReadMax").As<Napi::Number>().Uint32Value());
        }

        if (opts.Has("env") && opts.Get("env").IsObject()) {
            Napi::Object env_obj = opts.Get("env").As<Napi::Object>();
            Napi::Array keys = env_obj.GetPropertyNames();
            for (uint32_t i = 0; i < keys.Length(); i++) {
                Napi::Value key = keys[i];
                Napi::Value val = env_obj.Get(key);
                if (key.IsString() && val.IsString()) {
                    MIK_SetEnvVar(mik_rt_, key.As<Napi::String>().Utf8Value().c_str(),
                                  val.As<Napi::String>().Utf8Value().c_str());
                }
            }
            MIK_RebuildEnv(mik_rt_);
        }

        if (opts.Has("modules") && opts.Get("modules").IsObject()) {
            Napi::Object mods = opts.Get("modules").As<Napi::Object>();
            Napi::Array keys = mods.GetPropertyNames();
            for (uint32_t i = 0; i < keys.Length(); i++) {
                Napi::Value key = keys[i];
                Napi::Value val = mods.Get(key);
                if (key.IsString() && val.IsString()) {
                    std::string name = key.As<Napi::String>().Utf8Value();
                    std::string source = val.As<Napi::String>().Utf8Value();
                    MIK_RegisterVirtualModule(mik_rt_, name.c_str(), source.c_str(), source.size());
                }
            }
        }
    }
}

RuntimeWrap::~RuntimeWrap() {
    if (mik_rt_) {
        MIK_FreeRuntime(mik_rt_);
        mik_rt_ = nullptr;
    }
    delete host_bridge_;
    host_bridge_ = nullptr;
}

Napi::Value RuntimeWrap::EvalModule(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    current_env_ = env;
    if (host_bridge_) host_bridge_->current_env = env;

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "filename must be a string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string filename = info[0].As<Napi::String>().Utf8Value();
    bool is_main = true;
    if (info.Length() > 1 && info[1].IsBoolean()) {
        is_main = info[1].As<Napi::Boolean>().Value();
    }

    JSContext* ctx = MIK_GetJSContext(mik_rt_);
    JSValue result = MIK_EvalModule(ctx, filename.c_str(), is_main);

    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);

        /* Build a descriptive error message with name, message, and stack.
         * Only call JS_GetPropertyStr on object-like values: calling it on
         * a primitive (null, undefined, number, string, etc.) throws an
         * internal TypeError that clobbers the original exception we're
         * trying to report on. */
        std::string err_msg;
        bool is_object = JS_IsObject(exc);
        JSValue name_val = is_object ? JS_GetPropertyStr(ctx, exc, "name") : JS_UNDEFINED;
        JSValue msg_val = is_object ? JS_GetPropertyStr(ctx, exc, "message") : JS_UNDEFINED;
        JSValue stack_val = is_object ? JS_GetPropertyStr(ctx, exc, "stack") : JS_UNDEFINED;

        const char* name = JS_IsString(name_val) ? JS_ToCString(ctx, name_val) : nullptr;
        const char* msg = JS_IsString(msg_val) ? JS_ToCString(ctx, msg_val) : nullptr;
        const char* stack = JS_IsString(stack_val) ? JS_ToCString(ctx, stack_val) : nullptr;

        if (name && name[0]) {
            err_msg = name;
            if (msg && msg[0]) {
                err_msg += ": ";
                err_msg += msg;
            }
        } else if (msg && msg[0]) {
            err_msg = msg;
        } else {
            /* Not an Error object — the module threw a primitive. The most
             * common cause of a null/undefined exception here is *recursive*
             * OOM: QuickJS ran out of budget, called JS_ThrowOutOfMemory,
             * which tried to allocate an InternalError to throw, which
             * itself failed because the runtime is still out of memory. The
             * JS_ThrowOutOfMemory re-entrance guard makes the second call a
             * no-op, so the exception slot keeps whatever it had (often
             * null). A *clean* OOM produces a proper InternalError with
             * message "out of memory" and is handled by the name+message
             * branch above.
             *
             * Detection: if QuickJS's remaining budget is too small to
             * allocate even a trivial object (< ~2 KB, the typical size of
             * an Error + its message atom + stack trace), and we see a
             * primitive exception, it's recursive OOM. This is
             * deterministic regardless of total heap size — it compares
             * absolute headroom, not a percentage. */
            static const long OOM_HEADROOM_THRESHOLD = 2048;
            JSMemoryUsage mem;
            JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);
            long headroom =
                mem.malloc_limit > 0 ? (long)mem.malloc_limit - (long)mem.malloc_size : LONG_MAX;
            bool likely_oom = headroom < OOM_HEADROOM_THRESHOLD;

            if (likely_oom) {
                char stats[96];
                snprintf(stats, sizeof(stats), "%ld / %ld bytes used, %ld bytes free",
                         (long)mem.malloc_size, (long)mem.malloc_limit, headroom);
                err_msg = "Likely out of memory while loading '";
                err_msg += filename;
                err_msg += "' (QuickJS heap: ";
                err_msg += stats;
                err_msg += "). Budget exhausted before an error object could be allocated. ";
                err_msg += "Increase the runtime memory limit (lower `memReserved` in ";
                err_msg += "mikro.config.ts, or raise sim mem-limit) or split the module ";
                err_msg += "graph with dynamic imports.";

                /* Also signal the host so non-addon consumers (host bridge,
                 * telemetry, watchdogs) get notified through the common
                 * MIK_ReportOOM path. Safe to call with JS heap exhausted —
                 * operates on C state only. */
                MIKOOMEvent event = {};
                event.phase = MIK_OOM_POST_EVAL_DETECTED;
                event.filename = filename.c_str();
                event.malloc_size = (size_t)mem.malloc_size;
                event.malloc_limit = (size_t)mem.malloc_limit;
                event.headroom = headroom > 0 ? (size_t)headroom : 0;
                MIK_ReportOOM(mik_rt_, &event);
            } else {
                const char* str = JS_ToCString(ctx, exc);
                err_msg = "Module evaluation threw a non-Error value (";
                err_msg += str ? str : "?";
                err_msg += ") while loading '";
                err_msg += filename;
                err_msg += "'. Check top-level code in the module graph for ";
                err_msg += "`throw null`, `Promise.reject(null)`, or an unhandled ";
                err_msg += "rejection during initialization.";
                if (str) JS_FreeCString(ctx, str);
            }
        }

        if (stack && stack[0]) {
            err_msg += "\n";
            err_msg += stack;
        }

        if (name) JS_FreeCString(ctx, name);
        if (msg) JS_FreeCString(ctx, msg);
        if (stack) JS_FreeCString(ctx, stack);
        JS_FreeValue(ctx, name_val);
        JS_FreeValue(ctx, msg_val);
        JS_FreeValue(ctx, stack_val);
        JS_FreeValue(ctx, exc);

        Napi::Error::New(env, err_msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    JS_FreeValue(ctx, result);
    return env.Undefined();
}

Napi::Value RuntimeWrap::EvalModuleContent(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    current_env_ = env;
    if (host_bridge_) host_bridge_->current_env = env;

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "filename and content must be strings")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string filename = info[0].As<Napi::String>().Utf8Value();
    std::string content = info[1].As<Napi::String>().Utf8Value();

    JSContext* ctx = MIK_GetJSContext(mik_rt_);
    JSValue result = MIK_EvalModuleContent(ctx, filename.c_str(), content.c_str(), content.size());

    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);
        std::string err_msg;

        JSValue name_val = JS_GetPropertyStr(ctx, exc, "name");
        JSValue msg_val = JS_GetPropertyStr(ctx, exc, "message");
        JSValue stack_val = JS_GetPropertyStr(ctx, exc, "stack");

        const char* name = JS_IsString(name_val) ? JS_ToCString(ctx, name_val) : nullptr;
        const char* msg = JS_IsString(msg_val) ? JS_ToCString(ctx, msg_val) : nullptr;
        const char* stack = JS_IsString(stack_val) ? JS_ToCString(ctx, stack_val) : nullptr;

        if (name && name[0]) {
            err_msg = name;
            if (msg && msg[0]) {
                err_msg += ": ";
                err_msg += msg;
            }
        } else if (msg && msg[0]) {
            err_msg = msg;
        } else {
            const char* str = JS_ToCString(ctx, exc);
            err_msg = str ? str : "EvalModuleContent failed";
            if (str) JS_FreeCString(ctx, str);
        }

        if (stack && stack[0]) {
            err_msg += "\n";
            err_msg += stack;
        }

        if (name) JS_FreeCString(ctx, name);
        if (msg) JS_FreeCString(ctx, msg);
        if (stack) JS_FreeCString(ctx, stack);
        JS_FreeValue(ctx, name_val);
        JS_FreeValue(ctx, msg_val);
        JS_FreeValue(ctx, stack_val);
        JS_FreeValue(ctx, exc);

        Napi::Error::New(env, err_msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    JS_FreeValue(ctx, result);
    return env.Undefined();
}

Napi::Value RuntimeWrap::EvalScript(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    current_env_ = env;
    if (host_bridge_) host_bridge_->current_env = env;

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "code must be a string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string code = info[0].As<Napi::String>().Utf8Value();
    JSContext* ctx = MIK_GetJSContext(mik_rt_);
    JSValue result = MIK_EvalScriptContent(ctx, code.c_str(), code.size());

    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);
        std::string err_msg;

        JSValue stack_val = JS_GetPropertyStr(ctx, exc, "stack");
        JSValue msg_val = JS_GetPropertyStr(ctx, exc, "message");
        const char* stack = JS_IsString(stack_val) ? JS_ToCString(ctx, stack_val) : nullptr;
        const char* msg = JS_IsString(msg_val) ? JS_ToCString(ctx, msg_val) : nullptr;

        if (stack && stack[0]) {
            err_msg = stack;
        } else if (msg && msg[0]) {
            err_msg = msg;
        } else {
            const char* str = JS_ToCString(ctx, exc);
            err_msg = str ? str : "EvalScript failed";
            if (str) JS_FreeCString(ctx, str);
        }

        if (msg) JS_FreeCString(ctx, msg);
        if (stack) JS_FreeCString(ctx, stack);
        JS_FreeValue(ctx, msg_val);
        JS_FreeValue(ctx, stack_val);
        JS_FreeValue(ctx, exc);

        Napi::Error::New(env, err_msg).ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Convert result to string for the REPL
    if (JS_IsUndefined(result) || JS_IsNull(result)) {
        JS_FreeValue(ctx, result);
        return env.Undefined();
    }

    const char* str = JS_ToCString(ctx, result);
    JS_FreeValue(ctx, result);
    if (!str) {
        return env.Undefined();
    }
    Napi::String ret = Napi::String::New(env, str);
    JS_FreeCString(ctx, str);
    return ret;
}

Napi::Value RuntimeWrap::Loop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto* worker = new LoopWorker(env, mik_rt_);
    loop_worker_ = worker;
    auto deferred = worker->Deferred();
    worker->Queue();

    return deferred.Promise();
}

Napi::Value RuntimeWrap::LoopOnce(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    current_env_ = env;
    if (host_bridge_) host_bridge_->current_env = env;
    int rc = MIK_Loop(mik_rt_);
    return Napi::Number::New(env, rc);
}

void RuntimeWrap::Stop(const Napi::CallbackInfo& info) {
    if (loop_worker_) {
        loop_worker_->SignalStop();
        loop_worker_ = nullptr;
    }
}

void RuntimeWrap::Dispose(const Napi::CallbackInfo& info) {
    if (mik_rt_) {
        MIK_FreeRuntime(mik_rt_);
        mik_rt_ = nullptr;
    }
}

/* ── Virtual module registration ─────────────────────────────────── */

void RuntimeWrap::RegisterModuleSource(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "name and source must be strings").ThrowAsJavaScriptException();
        return;
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    std::string source = info[1].As<Napi::String>().Utf8Value();

    MIK_RegisterVirtualModule(mik_rt_, name.c_str(), source.c_str(), source.size());
}

/* ── Host message channel ────────────────────────────────────────── */

Napi::Value RuntimeWrap::DrainMessages(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!host_bridge_) return Napi::Array::New(env, 0);

    auto messages = std::move(host_bridge_->outbound_messages);
    host_bridge_->outbound_messages.clear();

    Napi::Array result = Napi::Array::New(env, messages.size());
    for (size_t i = 0; i < messages.size(); i++) {
        Napi::Object msg = Napi::Object::New(env);
        msg.Set("type", Napi::String::New(env, messages[i].first));
        msg.Set("data", Napi::String::New(env, messages[i].second));
        result[i] = msg;
    }
    return result;
}

/* ── Memory profiling ────────────────────────────────────────────── */

void RuntimeWrap::EnableProfiling(const Napi::CallbackInfo& info) {
    if (mik_rt_) {
        MIK_EnableProfiling(mik_rt_);
    }
}

Napi::Value RuntimeWrap::GetProfile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!mik_rt_) return Napi::Array::New(env, 0);

    size_t count = MIK_GetProfileEntryCount(mik_rt_);
    const MIKProfileEntry* entries = MIK_GetProfileEntries(mik_rt_);

    Napi::Array result = Napi::Array::New(env, count);
    for (size_t i = 0; i < count; i++) {
        Napi::Object entry = Napi::Object::New(env);
        entry.Set("name", Napi::String::New(env, entries[i].name));
        entry.Set("deltaBytes", Napi::Number::New(env, (double)entries[i].delta_bytes));
        entry.Set("order", Napi::Number::New(env, (double)entries[i].order));
        result[i] = entry;
    }
    return result;
}

Napi::Value RuntimeWrap::GetProfileBaseline(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!mik_rt_) return Napi::Number::New(env, 0);
    return Napi::Number::New(env, (double)MIK_GetProfileBaseline(mik_rt_));
}

void RuntimeWrap::PostMessage(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "type and data must be strings").ThrowAsJavaScriptException();
        return;
    }

    std::string type = info[0].As<Napi::String>().Utf8Value();
    std::string data = info[1].As<Napi::String>().Utf8Value();

    if (host_bridge_) {
        host_bridge_->inbound_messages.emplace_back(type, data);
    }
}

/* ── Synchronous RPC handler ─────────────────────────────────────── */

void RuntimeWrap::SetRpcHandler(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "rpcHandler must be a function").ThrowAsJavaScriptException();
        return;
    }

    if (host_bridge_) {
        host_bridge_->rpc_handler = Napi::Persistent(info[0].As<Napi::Function>());
    }
}

/* ── Preprocessor ────────────────────────────────────────────────── */

char* RuntimeWrap::PreprocessCallback(const char* filename, const char* source, size_t source_len,
                                      size_t* out_len, void* opaque) {
    auto* self = static_cast<RuntimeWrap*>(opaque);
    if (self->preprocess_fn_.IsEmpty() || !self->current_env_) return nullptr;

    Napi::Env env(self->current_env_);
    Napi::HandleScope scope(env);

    Napi::Value result = self->preprocess_fn_.Call(
        {Napi::String::New(env, filename), Napi::String::New(env, source, source_len)});

    if (!result.IsString()) return nullptr;

    std::string out = result.As<Napi::String>().Utf8Value();
    *out_len = out.size();
    char* buf = static_cast<char*>(malloc(out.size() + 1));
    memcpy(buf, out.data(), out.size());
    buf[out.size()] = '\0';
    return buf;
}

void RuntimeWrap::SetPreprocessor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "preprocessor must be a function").ThrowAsJavaScriptException();
        return;
    }

    preprocess_fn_ = Napi::Persistent(info[0].As<Napi::Function>());
    MIK_SetPreprocessor(mik_rt_, PreprocessCallback, this);
}

/* ── Error handler ───────────────────────────────────────────────── */

void RuntimeWrap::ErrorHandlerCallback(JSContext* ctx, JSValue error, void* opaque) {
    auto* self = static_cast<RuntimeWrap*>(opaque);
    if (!self->host_bridge_) return;

    /* Extract name, message, stack from the error value */
    std::string json = "{";

    JSValue name_val = JS_GetPropertyStr(ctx, error, "name");
    JSValue msg_val = JS_GetPropertyStr(ctx, error, "message");
    JSValue stack_val = JS_GetPropertyStr(ctx, error, "stack");

    const char* name = JS_IsString(name_val) ? JS_ToCString(ctx, name_val) : nullptr;
    const char* msg = JS_IsString(msg_val) ? JS_ToCString(ctx, msg_val) : nullptr;
    const char* stack = JS_IsString(stack_val) ? JS_ToCString(ctx, stack_val) : nullptr;

    /* If it's not an Error object, stringify the value */
    if (!name && !msg) {
        const char* str = JS_ToCString(ctx, error);
        json += "\"message\":\"";
        if (str) {
            json += str;
            JS_FreeCString(ctx, str);
        }
        json += "\"}";
    } else {
        if (name) {
            json += "\"name\":\"";
            json += name;
            json += "\"";
        }
        if (msg) {
            if (name) json += ",";
            json += "\"message\":\"";
            json += msg;
            json += "\"";
        }
        if (stack) {
            json += ",\"stack\":\"";
            /* Escape newlines in stack trace for JSON */
            for (const char* p = stack; *p; p++) {
                if (*p == '\n')
                    json += "\\n";
                else if (*p == '"')
                    json += "\\\"";
                else if (*p == '\\')
                    json += "\\\\";
                else
                    json += *p;
            }
            json += "\"";
        }
        json += "}";
    }

    if (name) JS_FreeCString(ctx, name);
    if (msg) JS_FreeCString(ctx, msg);
    if (stack) JS_FreeCString(ctx, stack);
    JS_FreeValue(ctx, name_val);
    JS_FreeValue(ctx, msg_val);
    JS_FreeValue(ctx, stack_val);

    self->host_bridge_->outbound_messages.emplace_back("error:uncaught", json);
}

/* ── OOM handler ─────────────────────────────────────────────────── */

void RuntimeWrap::OOMHandlerCallback(const MIKOOMEvent* event, void* opaque) {
    auto* self = static_cast<RuntimeWrap*>(opaque);
    if (!self->host_bridge_) return;

    /* Build a small JSON payload by hand — we can't use any QuickJS or
     * Napi machinery here because the JS heap is (very) nearly exhausted
     * and we might be called from inside error-reporting code where
     * allocating a JSValue would recurse. std::string on the C++ heap is
     * fine — that's a separate allocator from QuickJS. Filename is
     * borrowed from the caller (stack in MIK_EvalModule), so we must
     * stringify into a local before returning. */
    const char* phase_name = event->phase == MIK_OOM_PRE_EVAL_WARN   ? "pre-eval-warn"
                             : event->phase == MIK_OOM_POST_EVAL_DETECTED ? "post-eval-detected"
                                                                          : "unknown";

    std::string json = "{\"phase\":\"";
    json += phase_name;
    json += "\",\"filename\":\"";
    for (const char* p = event->filename ? event->filename : ""; *p; p++) {
        if (*p == '"')
            json += "\\\"";
        else if (*p == '\\')
            json += "\\\\";
        else
            json += *p;
    }
    json += "\",\"mallocSize\":";
    json += std::to_string(event->malloc_size);
    json += ",\"mallocLimit\":";
    json += std::to_string(event->malloc_limit);
    json += ",\"headroom\":";
    json += std::to_string(event->headroom);
    json += "}";

    self->host_bridge_->outbound_messages.emplace_back("oom", json);
}

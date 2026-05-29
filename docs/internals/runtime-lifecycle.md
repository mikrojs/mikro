---
title: Runtime Lifecycle
description: How MIKRuntime is created, configured, driven, and destroyed
---

# Runtime Lifecycle

The runtime is the central object in Mikro.js. It wraps a QuickJS `JSRuntime` and `JSContext`, owns all timers and registered modules, and provides the event loop that drives JavaScript execution.

## MIKRuntime

`MIKRuntime` (defined in `private.h`) holds all runtime state. Key fields (simplified; see `private.h` for the full definition):

```c
struct MIKRuntime {
    MIKRunOptions options;
    MIKConfig config;
    JSRuntime* rt;              // QuickJS runtime
    JSContext* ctx;             // QuickJS context
    bool is_worker;
    bool freeing;
    bool stop_requested;

    const char* fs_base_path;   // Module resolution root
    const char* fs_root;        // Sandbox root for fs operations
    size_t fs_limit;            // Max bytes for fs_root (0 = unlimited)

    MIKTimerRegistry* timers;   // Timer scheduling

    // Module registries
    std::vector<MIKNativeModuleEntry> native_modules;
    std::vector<MIKLoopConsumerEntry> loop_consumers;
    std::unordered_map<std::string, std::string> virtual_modules;

    // Built-in JS references (PromiseRejectionEvent, dispatchEvent)
    struct { JSValue promise_event_ctor; JSValue dispatch_event_func; } builtins;

    JSValue env_obj;            // Frozen import.meta.env
    std::vector<std::pair<std::string, std::string>> env_vars;

    // Per-module state (16 slots)
    void* module_data[MIK_MODULE_DATA_SLOTS];
    int next_module_slot;

    // Optional hooks (used by Node.js addon)
    char* (*preprocess_fn)(...);   // Module source preprocessor
    void (*error_handler_fn)(...); // Error handler callback
};
```

## Creation

Two entry points create a runtime:

```c
MIKRuntime* MIK_NewRuntime(void);
MIKRuntime* MIK_NewRuntimeOptions(MIKRunOptions* options);
```

`MIK_NewRuntimeOptions` accepts memory limit and stack size. Both call `MIK_NewRuntimeInternal()` which initializes everything in this order:

1. Creates a `JSRuntime` with custom malloc functions for memory tracking
2. Creates a `JSContext`, seeded with the platform's hardware RNG for `Math.random()`
3. Sets memory limit and stack size
4. Registers the module loader and promise rejection tracker
5. Registers core C modules (`native:sys`, `native:cbor`, `native:fs`, inspect)
6. Calls init functions for any pre-registered native modules
7. Registers `native:stdio` (after native modules, so stdin state is ready)
8. Initializes web standard globals (`TextEncoder`, `AbortController`)
9. Initializes timers (`setTimeout`, `setInterval`, etc.)
10. Initializes the `console` global
11. Builds and freezes `import.meta.env`

::: tip
`MIK_SetPlatform()` must be called **before** creating a runtime. The platform provides the timer clock, RNG seed, and I/O functions used during initialization.
:::

## Configuration

Runtime behavior is controlled by `MIKConfig`:

```c
typedef struct MIKConfig {
    int panic_restart_delay_ms;   // grace window before the panic action
    MIKPanicMode panic_mode;      // MIK_PANIC_RESTART | MIK_PANIC_DEEP_SLEEP
    int panic_sleep_duration_ms;  // deep-sleep length (deep-sleep mode only)
    size_t stack_size;
    uint32_t mem_reserved;
    uint32_t fs_read_max;  // 0 = keep runtime default (65536)
    char entry_point[128];
    char wifi_country[3];
} MIKConfig;
```

Configuration is loaded from the filesystem via `MIK_LoadConfig()` and applied with `MIK_SetConfig()`. On ESP32, `MIK_Main()` handles this automatically.

## Environment variables

Environment variables populate `import.meta.env` in JavaScript:

```c
MIK_SetEnvVar(mik_rt, "WIFI_SSID", "MyNetwork");
MIK_SetEnvVar(mik_rt, "WIFI_PASS", "secret");
MIK_RebuildEnv(mik_rt);  // Rebuild the frozen env object
```

On ESP32, `MIK_LoadEnvFromNVS()` reads all NVS entries and calls `MIK_SetEnvVar()` for each one. The env object is frozen to prevent mutation from JavaScript.

## Running the loop

`MIK_Loop()` executes a single iteration of the event loop. The caller is responsible for calling it repeatedly:

```c
while (MIK_Loop(mik_rt) == 0) {
    MIK_GetPlatform()->yield();
}
```

A return value of `0` means "keep going." A non-zero return means the runtime should stop (either an unhandled exception or a stop request). See [Event Loop](/internals/event-loop) for what happens inside each iteration.

## Stopping

The runtime can be stopped in several ways:

- **Unhandled promise rejection**: The rejection tracker sets `stop_requested` and returns `1` from `MIK_Loop()`
- **Uncaught exception**: Detected at the top of each loop iteration
- **Explicit stop**: `MIK_Stop(mik_rt)` sets `stop_requested`

After an uncaught exception, `MIK_Stop()` records a deadline `panic_restart_delay_ms` in the future on `MIKRuntime.restart_at_us`. `MIK_Loop()` keeps the protocol REPL pumping (no more user JS) until the deadline elapses, then takes the configured panic action: `platform->restart()` (default), or `platform->deep_sleep_us()` for `panic_sleep_duration_ms` when `panic_mode` is `MIK_PANIC_DEEP_SLEEP` (the timer wake reboots the chip). The host can land deploy / clean / --recover commands during the grace window; deep-sleep forfeits that window once asleep.

## Destruction

`MIK_FreeRuntime()` tears down the runtime in a specific order:

1. Sets `freeing = true` to prevent new callbacks from firing
2. Destroys all loop consumers (calls each consumer's `destroy_fn`)
3. Clears all timers and frees their stored JS values
4. Frees internal JS values (`env_obj`, event dispatch functions)
5. Frees the `JSContext` and `JSRuntime`

The `freeing` flag is checked before delivering promise rejection events or calling error handlers, preventing re-entrant cleanup issues.

## Module data slots

Stateful modules need to store persistent data on the runtime (e.g., WiFi connection state). Sixteen slots are available:

```c
int slot = MIK_AllocModuleSlot(mik_rt);
mik_rt->module_data[slot] = my_state;

// Later, in a callback:
MyState* state = (MyState*)mik_rt->module_data[slot];
```

Slots are allocated sequentially and never freed. This is a simple, fast mechanism for modules that need to store a pointer to their state without globals.

---
name: add-native-module
description: Step-by-step guide for adding new native C/C++ modules to the mikrojs ESP32 runtime. Use this skill whenever the user wants to expose new hardware peripherals, ESP-IDF APIs, or C functionality to JavaScript, create a new "native:xxx" native module, add GPIO/SPI/I2C/UART/ADC/PWM or other hardware bindings, or asks how to register C functions with QuickJS in this project.
---

# Adding a Native C/C++ Module to mikrojs

This guide walks through adding a new native module that exposes C/C++ functionality to JavaScript as a `native:` prefixed import (e.g., `import { read } from "native:adc"`).

---

## Overview

There are two patterns used in mikrojs:

1. **Function-export modules** — Export standalone functions (e.g., `native:sys`, `native:stdio`). Simpler, good for stateless APIs.
2. **Class-based modules** — Export a class with methods, backed by a C struct with a finalizer (e.g., `native:wifi`, `native:http`). Use when you need per-instance state or resource cleanup.

Native modules self-register via the `MIK_REGISTER_MODULE()` macro and are lazily initialized on first import. No manual init calls in `main.cpp` are needed.

---

## Step-by-Step: Function-Export Module

We'll create a hypothetical `native:adc` module as an example.

### 1. Create the source file

Create `packages/@mikrojs/firmware/components/mikrojs/mik_adc.cpp`:

```cpp
#include "private.h"
#include "quickjs.h"

// --- Native function implementations ---

static JSValue js_adc_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int channel;
    if (JS_ToInt32(ctx, &channel, argv[0]))
        return JS_EXCEPTION;

    // Call ESP-IDF API
    int raw_value = 0;
    esp_err_t err = adc1_get_raw((adc1_channel_t)channel);
    if (err != ESP_OK) {
        return JS_ThrowInternalError(ctx, "ADC read failed: %s", esp_err_to_name(err));
    }

    return JS_NewInt32(ctx, raw_value);
}

// --- Module init callback (called by QuickJS when the module is imported) ---

static int mik__adc_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "read", JS_NewCFunction(ctx, js_adc_read, "read", 1));
    return 0;
}

// --- Self-registration (lazily initialized on first import) ---

static JSModuleDef* mik__adc_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:adc", mik__adc_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "read");
    return m;
}

MIK_REGISTER_MODULE(adc, "native:adc", mik__adc_init, nullptr, nullptr)
```

The pattern has three parts:

- `mik__adc_module_init` — callback invoked by QuickJS when JS code imports `native:adc`. Use `JS_SetModuleExport` here to set the actual export values (consumes them).
- `mik__adc_init` — called lazily on first import. Returns the `JSModuleDef*`. Registers the module name and declares which exports it will provide via `JS_AddModuleExport`.
- `MIK_REGISTER_MODULE` — macro at file scope that self-registers the module. The module loader discovers it and calls `mik__adc_init` on first import. No manual registration in `main.cpp` needed.

### 2. Add to CMakeLists.txt

**`packages/@mikrojs/firmware/components/mikrojs/CMakeLists.txt`** — Add the source file to SRCS:

```cmake
SRCS
    ...
    "mik_adc.cpp"
    ...
```

If your module needs additional ESP-IDF components, add them to REQUIRES:

```cmake
REQUIRES quickjs littlefs driver esp_timer esp_http_client esp-tls esp_netif esp_event esp_wifi nvs_flash esp_adc
```

**Important:** You must also force-include the module descriptor so the linker doesn't strip it from the static library:

```cmake
mikrojs_force_include_modules(adc)
```

This is provided by `mikrojs_bytecode.cmake` (included via the bytecode generation setup). Without it, the `MIK_REGISTER_MODULE` constructor won't run and the module will silently fail to resolve.

### 3. Add type declarations (optional but recommended)

Create `packages/@mikrojs/types/mik-adc.d.ts` so TypeScript users get autocomplete:

```typescript
declare module 'native:adc' {
  export function read(channel: number): number
}
```

That's it. No changes to `main.cpp` or `private.h` needed.

---

## Step-by-Step: Class-Based Module

For modules with per-instance state (connections, handles, peripherals that need cleanup).

### 1. Define the state struct and class ID

```cpp
#include "private.h"
#include "quickjs.h"

static JSClassID my_sensor_class_id;

typedef struct {
    int pin;
    bool initialized;
    // ... any C state
} MySensorState;
```

### 2. Write the finalizer

The finalizer runs when the JS object is garbage collected. Only free C resources here — no JS API calls.

```cpp
static void my_sensor_finalizer(JSRuntime* rt, JSValue val) {
    MySensorState* s = (MySensorState*)JS_GetOpaque(val, my_sensor_class_id);
    if (s) {
        // Clean up hardware resources
        if (s->initialized) {
            // e.g., deinit peripheral
        }
        free(s);
    }
}

static JSClassDef my_sensor_class = {
    .class_name = "MySensor",
    .finalizer = my_sensor_finalizer,
};
```

### 3. Write the constructor and methods

```cpp
static JSValue js_sensor_constructor(JSContext* ctx, JSValue new_target,
                                      int argc, JSValue* argv) {
    int pin;
    if (JS_ToInt32(ctx, &pin, argv[0]))
        return JS_EXCEPTION;

    MySensorState* s = (MySensorState*)calloc(1, sizeof(MySensorState));
    if (!s)
        return JS_ThrowOutOfMemory(ctx);

    s->pin = pin;

    JSValue obj = JS_NewObjectClass(ctx, my_sensor_class_id);
    if (JS_IsException(obj)) {
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);  // GC now owns s
    return obj;
}

static JSValue js_sensor_read(JSContext* ctx, JSValue this_val,
                               int argc, JSValue* argv) {
    MySensorState* s = (MySensorState*)JS_GetOpaque2(ctx, this_val, my_sensor_class_id);
    if (!s)
        return JS_EXCEPTION;

    // ... read from hardware using s->pin ...
    return JS_NewFloat64(ctx, 23.5);
}

static const JSCFunctionListEntry my_sensor_proto_funcs[] = {
    JS_CFUNC_DEF("read", 0, js_sensor_read),
};
```

### 4. Write the module init and self-registration

```cpp
// Called by QuickJS when JS code imports this module
static int mik__sensor_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ctor = JS_NewCFunction2(ctx, js_sensor_constructor, "MySensor", 1,
                                     JS_CFUNC_constructor, 0);
    JS_SetModuleExport(ctx, m, "MySensor", ctor);  // consumed
    return 0;
}

// Called lazily on first import
static JSModuleDef* mik__sensor_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    // Register the class (once per runtime)
    JS_NewClassID(rt, &my_sensor_class_id);
    JS_NewClass(rt, my_sensor_class_id, &my_sensor_class);

    // Create prototype with methods
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, my_sensor_proto_funcs,
                                countof(my_sensor_proto_funcs));
    JS_SetClassProto(ctx, my_sensor_class_id, proto);  // consumed

    // Register the module
    JSModuleDef* m = JS_NewCModule(ctx, "native:sensor", mik__sensor_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "MySensor");
    return m;
}

MIK_REGISTER_MODULE(sensor, "native:sensor", mik__sensor_init, nullptr, nullptr)
```

Then add to `CMakeLists.txt` SRCS. No changes to `main.cpp` or `private.h` needed.

---

## Event Loop Integration

If your module does async work (network requests, hardware events), integrate with the mikrojs event loop.

### Add consume/destroy functions and use a dynamic module slot

```cpp
/* Dynamic module data slot for storing per-runtime state */
static int mik__adc_slot = -1;

struct MIKAdcState {
    QueueHandle_t result_queue;
    // ... async operation state
};

static inline MIKAdcState*& mik__adc_st(MIKRuntime* rt) {
    return reinterpret_cast<MIKAdcState*&>(rt->module_data[mik__adc_slot]);
}

// Called every tick of the event loop — check for completed async operations
void mik__adc_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik__adc_st(mik_rt)) return;
    // Check if any async reads completed, resolve promises, etc.
}

// Called on runtime shutdown — clean up all resources
void mik__adc_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik__adc_st(mik_rt)) return;
    // Free module-level state
    delete mik__adc_st(mik_rt);
    mik__adc_st(mik_rt) = nullptr;
}

static JSModuleDef* mik__adc_init(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    mik__adc_slot = MIK_AllocModuleSlot(mik_rt);

    auto* state = new MIKAdcState();
    // ... initialize state ...
    mik__adc_st(mik_rt) = state;

    JSModuleDef* m = JS_NewCModule(ctx, "native:adc", mik__adc_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "readAsync");
    return m;
}

// consume and destroy are passed to MIK_REGISTER_MODULE — they are
// automatically registered as loop consumers when the module is first imported.
MIK_REGISTER_MODULE(adc, "native:adc", mik__adc_init, mik__adc_consume, mik__adc_destroy)
```

Loop consumers are registered automatically when the module is lazily initialized. No manual `MIK_RegisterLoopConsumer` calls needed.

### Async pattern with promises

For async operations, use the `MIKPromise` helper:

```cpp
static JSValue js_adc_read_async(JSContext* ctx, JSValue this_val,
                                  int argc, JSValue* argv) {
    MIKPromise* p = (MIKPromise*)calloc(1, sizeof(MIKPromise));
    JSValue promise = MIK_InitPromise(ctx, p);

    // Start async operation, store p somewhere your consume function can find it
    // ...

    return promise;  // returned to JS
}

// Later, in your consume function when the result is ready:
JSValue result = JS_NewInt32(ctx, raw_value);
MIK_SettlePromise(ctx, p, false, 1, &result);  // consumes result, frees p internals
free(p);
```

---

## Checklist

1. [ ] Source file created: `packages/@mikrojs/firmware/components/mikrojs/mik_xxx.cpp`
2. [ ] Self-contained init: `JS_NewCModule` + `JS_AddModuleExport` inside `static JSModuleDef* mik__xxx_init(JSContext* ctx)`
3. [ ] `MIK_REGISTER_MODULE(xxx, "native:xxx", mik__xxx_init, consume_or_null, destroy_or_null)` at file scope
4. [ ] Source added to `CMakeLists.txt` SRCS
5. [ ] ESP-IDF dependencies added to REQUIRES (if needed)
6. [ ] `mikrojs_force_include_modules(xxx)` in CMakeLists.txt (required for linker)
7. [ ] Dynamic slot via `MIK_AllocModuleSlot()` (if module has per-runtime state)
8. [ ] Consume/destroy functions passed to `MIK_REGISTER_MODULE` (if async)
9. [ ] Type declarations added (optional)
10. [ ] Follows naming conventions: `mik__snake_case` for internals, `js_` prefix for JSValue-returning functions

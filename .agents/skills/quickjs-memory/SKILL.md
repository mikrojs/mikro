---
name: quickjs-memory
description: QuickJS-NG memory management patterns for the mikrojs runtime. Use this skill whenever working on C/C++ code that interacts with QuickJS values (JSValue), writing or reviewing native module code, debugging memory leaks or use-after-free crashes, handling promise lifecycles, writing finalizers, or any situation involving JS_DupValue/JS_FreeValue ownership. Also trigger when the user mentions refcount bugs, leaked JS values, or double-free crashes in the QuickJS layer.
---

# QuickJS Memory Management for mikrojs

QuickJS uses **reference counting** for all JS values. Every `JSValue` has a refcount. When the refcount reaches zero, the value is freed. Getting this wrong causes either memory leaks (forgot to free) or use-after-free crashes (freed too early). This guide covers the ownership rules used throughout the mikrojs codebase.

---

## Core Rules

1. **If you receive ownership, you must eventually free it** — call `JS_FreeValue(ctx, val)`
2. **If you want to keep a value beyond the current scope, duplicate it** — call `JS_DupValue(ctx, val)`
3. **Some APIs consume (take ownership of) their arguments** — do NOT free after passing
4. **Some APIs transfer ownership to you in the return value** — you MUST free the result

---

## API Ownership Reference

### Functions that GIVE you ownership (you must free the result)

| Function                               | Notes                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `JS_NewString(ctx, str)`               | New string, refcount 1                                                              |
| `JS_NewObject(ctx)`                    | New object, refcount 1                                                              |
| `JS_NewArray(ctx)`                     | New array, refcount 1                                                               |
| `JS_NewInt32/64/Float64(ctx, n)`       | Primitives — technically no refcount, but safe to free                              |
| `JS_NewCFunction(ctx, fn, name, argc)` | New function object                                                                 |
| `JS_NewPromiseCapability(ctx, rfuncs)` | Returns promise, writes resolve/reject into rfuncs[0]/rfuncs[1] — you own all three |
| `JS_GetPropertyStr(ctx, obj, prop)`    | **Creates a new reference** — you own it                                            |
| `JS_GetPropertyUint32(ctx, obj, idx)`  | Same — new reference, you own it                                                    |
| `JS_Call(ctx, func, this, argc, argv)` | You own the return value                                                            |
| `JS_Eval(ctx, ...)`                    | You own the return value                                                            |
| `JS_ReadObject(ctx, ...)`              | You own the return value                                                            |
| `JS_NewArrayBufferCopy(ctx, buf, len)` | Copies data, you own the JSValue                                                    |
| `JS_NewClassID(rt, &id)`               | Not a JSValue, but allocates a class slot                                           |

### Functions that CONSUME arguments (do NOT free after passing)

| Function                                                  | What it consumes                                             |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `JS_SetPropertyStr(ctx, obj, prop, val)`                  | Consumes `val`                                               |
| `JS_SetPropertyUint32(ctx, obj, idx, val)`                | Consumes `val`                                               |
| `JS_DefinePropertyValueStr(ctx, obj, prop, val, flags)`   | Consumes `val`                                               |
| `JS_DefinePropertyValueUint32(ctx, obj, idx, val, flags)` | Consumes `val`                                               |
| `JS_SetModuleExport(ctx, m, name, val)`                   | Consumes `val`                                               |
| `JS_Throw(ctx, val)`                                      | Consumes `val`                                               |
| `JS_SetOpaque(ctx, obj, ptr)`                             | Takes ownership of the C pointer (freed via class finalizer) |

### Functions that do NOT consume and do NOT transfer ownership

| Function                                 | Notes                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `JS_Call(ctx, func, this, argc, argv)`   | Does NOT consume func, this, or argv elements                                      |
| `JS_ToCString(ctx, val)`                 | Returns a `const char*` — free with `JS_FreeCString(ctx, str)`, not `JS_FreeValue` |
| `JS_GetOpaque(val, class_id)`            | Returns a borrowed pointer — do NOT free it                                        |
| `JS_GetOpaque2(ctx, val, class_id)`      | Same, but throws on type mismatch                                                  |
| `JS_IsException(val)`                    | Pure check, no ownership change                                                    |
| `JS_IsUndefined(val)` / `JS_IsNull(val)` | Pure checks                                                                        |

---

## Common Patterns in mikrojs

### Pattern 1: Setting properties on an object

```cpp
// JS_SetPropertyStr CONSUMES val, so do NOT free it after
JSValue obj = JS_NewObject(ctx);
JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, "hello"));  // consumed
JS_SetPropertyStr(ctx, obj, "count", JS_NewInt32(ctx, 42));        // consumed
return obj;  // caller owns obj
```

### Pattern 2: Reading a property, using it, freeing it

```cpp
JSValue val = JS_GetPropertyStr(ctx, obj, "name");  // you own val
const char* str = JS_ToCString(ctx, val);
// ... use str ...
JS_FreeCString(ctx, str);
JS_FreeValue(ctx, val);
```

### Pattern 3: Building an array

```cpp
JSValue arr = JS_NewArray(ctx);
for (int i = 0; i < count; i++) {
    // DefinePropertyValueUint32 CONSUMES the value
    JS_DefinePropertyValueUint32(ctx, arr, i, JS_NewString(ctx, items[i]),
                                  JS_PROP_C_W_E);
}
return arr;  // caller owns arr
```

### Pattern 4: Calling a JS function from C

```cpp
JSValue args[2] = { JS_NewString(ctx, "data"), JS_NewInt32(ctx, 42) };
JSValue ret = JS_Call(ctx, callback, JS_UNDEFINED, 2, args);
// JS_Call does NOT consume args — you must free them
JS_FreeValue(ctx, args[0]);
JS_FreeValue(ctx, args[1]);
// You own ret — check and free it
if (JS_IsException(ret)) {
    js_std_dump_error(ctx);
}
JS_FreeValue(ctx, ret);
```

### Pattern 5: Error return with cleanup

```cpp
JSValue obj = JS_NewObject(ctx);
JSValue name = JS_NewString(ctx, str);
if (some_error) {
    JS_FreeValue(ctx, obj);
    JS_FreeValue(ctx, name);
    return JS_ThrowInternalError(ctx, "something failed");
}
JS_SetPropertyStr(ctx, obj, "name", name);  // consumed — do NOT free name after this
return obj;
```

**Important**: If you call `JS_SetPropertyStr` and then hit an error, the value was already consumed — do not free it again.

---

## Promise Lifecycle (MIK_InitPromise / MIK_SettlePromise / MIK_FreePromise)

mikrojs wraps QuickJS promises with a `MIKPromise` struct (see `utils.cpp`):

```cpp
// 1. Initialize — stores resolve/reject functions, returns the promise
MIKPromise p;
JSValue promise = MIK_InitPromise(ctx, &p);
// promise is returned to JS (caller owns it)

// 2. Later, settle the promise (resolve or reject)
JSValue result = JS_NewString(ctx, "done");
MIK_SettlePromise(ctx, &p, false, 1, &result);
// SettlePromise consumes argv values AND calls MIK_FreePromise internally

// 3. If you need to abandon without settling:
MIK_FreePromise(ctx, &p);
// Frees rfuncs[0], rfuncs[1], and p — the promise remains pending forever
```

**Rules**:

- `MIK_InitPromise` stores resolve/reject at refcount 1 — do not `JS_DupValue` them
- `MIK_SettlePromise` frees the argv values, the return value of the call, and then calls `MIK_FreePromise` — do not free anything yourself after calling it
- Always call either `MIK_SettlePromise` or `MIK_FreePromise` on every code path — never leave a `MIKPromise` unfreed

---

## Class Instances and Finalizers

For C-backed JS objects (WiFi, HTTP, FileHandle), use QuickJS class IDs:

```cpp
static JSClassID my_class_id;

// Ensure your struct is freed by the GC
static void my_finalizer(JSRuntime* rt, JSValue val) {
    MyState* s = (MyState*)JS_GetOpaque(val, my_class_id);
    if (s) {
        // Free any C resources
        free(s->buffer);
        free(s);
    }
}

static JSClassDef my_class = {
    .class_name = "MyThing",
    .finalizer = my_finalizer,
};

// Registration (once, at init):
JS_NewClassID(JS_GetRuntime(ctx), &my_class_id);
JS_NewClass(JS_GetRuntime(ctx), my_class_id, &my_class);

// Creating an instance:
MyState* s = (MyState*)calloc(1, sizeof(MyState));
JSValue obj = JS_NewObjectClass(ctx, my_class_id);
JS_SetOpaque(obj, s);  // GC now owns s, will call finalizer
```

**Finalizer rules**:

- The finalizer receives `JSRuntime*`, not `JSContext*` — you cannot call most JS APIs
- Do NOT call `JS_FreeValue` inside a finalizer — values are being collected
- Only free C memory (`free`, `esp_http_client_cleanup`, etc.)
- If your C struct holds `JSValue` fields that need freeing during normal lifecycle, free them before the finalizer runs (e.g., in a `close()` method)

---

## Storing JSValues in C Structs

When a C struct stores a `JSValue` (like timer callbacks or event handlers):

```cpp
// Storing — duplicate to take ownership
state->callback = JS_DupValue(ctx, callback_arg);

// Releasing — free when done
JS_FreeValue(ctx, state->callback);
state->callback = JS_UNDEFINED;  // mark as released
```

Use `JS_UNDEFINED` as the sentinel for "no value stored". Check with `JS_IsUndefined()` before freeing.

---

## Top 10 Pitfalls

1. **Forgetting to free `JS_GetPropertyStr` results** — every get creates a new ref
2. **Freeing a value after `JS_SetPropertyStr` consumed it** — double free
3. **Not freeing `JS_Call` return values** — even if you don't use the result
4. **Not freeing `JS_Call` arguments** — JS_Call does NOT consume them
5. **Forgetting `JS_FreeCString`** — ToCString allocates, must be freed separately
6. **Using `JS_DupValue` when you already own the value** — creates a leak
7. **Missing cleanup on error paths** — every early return must free all owned values
8. **Calling JS APIs in a finalizer** — only free C memory in finalizers
9. **Not settling or freeing MIKPromise** — leaks resolve/reject function objects
10. **Storing a JSValue without JS_DupValue** — the original may be freed elsewhere

#include <quickjs.h>
#include <sys/time.h>
#include <time.h>

#ifdef CONFIG_IDF_TARGET
#include <esp_app_desc.h>
#include <esp_chip_info.h>
#include <esp_flash.h>
#ifdef CONFIG_SPIRAM
#include <esp_psram.h>
#endif
#endif

#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

static JSValue mik__sys_eval_script(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* str;
    size_t len;
    str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!str) {
        return JS_EXCEPTION;
    }
    JSValue ret = JS_Eval(ctx, str, len, "<evalScript>",
                          JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC | JS_EVAL_FLAG_BACKTRACE_BARRIER);
    JS_FreeCString(ctx, str);
    return ret;
}

static JSValue mik__sys_memory_usage(JSContext* ctx, JSValue this_val, int argc,
                                         JSValue* argv) {
    JSMemoryUsage mem;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);

    const MIKPlatform* platform = MIK_GetPlatform();

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "heapTotal",
                      JS_NewInt64(ctx, mem.malloc_limit > 0 ? mem.malloc_limit : mem.malloc_size));
    JS_SetPropertyStr(ctx, obj, "heapUsed", JS_NewInt64(ctx, mem.malloc_size));
    JS_SetPropertyStr(ctx, obj, "systemFree",
                      JS_NewInt64(ctx, (int64_t)platform->get_free_system_mem()));
    JS_SetPropertyStr(ctx, obj, "systemMinFree",
                      JS_NewInt64(ctx, (int64_t)platform->get_min_free_system_mem()));
    JS_SetPropertyStr(ctx, obj, "systemTotal",
                      JS_NewInt64(ctx, (int64_t)platform->get_total_system_mem()));
    JS_SetPropertyStr(ctx, obj, "systemLargestFree",
                      JS_NewInt64(ctx, (int64_t)platform->get_largest_free_system_mem()));
    JS_SetPropertyStr(ctx, obj, "internalFree",
                      JS_NewInt64(ctx, (int64_t)platform->get_free_internal_mem()));
    JS_SetPropertyStr(ctx, obj, "internalLargestFree",
                      JS_NewInt64(ctx, (int64_t)platform->get_largest_free_internal_mem()));
    return obj;
}

/* Curated QuickJS-heap breakdown. Covers the "where is memory going?"
 * fields from JSMemoryUsage; skips redundancy with `memoryUsage()`
 * (malloc_size/limit) and low-signal fields (atom counts, pc2line debug
 * info, allocation counts, internal fast-vs-regular distinctions).
 * If you need one of the excluded fields for a specific investigation,
 * add it here — they're all available via JS_ComputeMemoryUsage. */
static JSValue mik__sys_js_memory_usage(JSContext* ctx, JSValue this_val, int argc,
                                        JSValue* argv) {
    JSMemoryUsage mem;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mem);

    const struct {
        const char* name;
        int64_t value;
    } fields[] = {
        {"strCount", mem.str_count},
        {"strSize", mem.str_size},
        {"objCount", mem.obj_count},
        {"objSize", mem.obj_size},
        {"propCount", mem.prop_count},
        {"propSize", mem.prop_size},
        {"shapeCount", mem.shape_count},
        {"shapeSize", mem.shape_size},
        {"jsFuncCount", mem.js_func_count},
        {"jsFuncCodeSize", mem.js_func_code_size},
        {"arrayCount", mem.array_count},
        {"fastArrayElements", mem.fast_array_elements},
        {"binaryObjectSize", mem.binary_object_size},
    };

    JSValue obj = JS_NewObject(ctx);
    for (const auto& f : fields) {
        JS_SetPropertyStr(ctx, obj, f.name, JS_NewInt64(ctx, f.value));
    }
    return obj;
}

static JSValue mik__sys_gc(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}

/* Backs withUnload()'s unload step. Unloads the module whose
 * namespace is argv[0]; returns the number of modules freed (0 if not a
 * loaded module's namespace). Refcounting reclaims the memory once the
 * caller's reference drops; no GC here. */
static JSValue mik__sys_unload_namespace(JSContext* ctx, JSValue this_val, int argc,
                                         JSValue* argv) {
    int rv = mik__unload_namespace(ctx, argv[0]);
    if (rv < 0) return JS_EXCEPTION;
    return JS_NewInt32(ctx, rv);
}

/* True if argv[0] is the namespace of a loaded, non-anchored module.
 * withUnload() uses this to reject builtins (native:/mikrojs//@mikrojs/). */
static JSValue mik__sys_is_unloadable_namespace(JSContext* ctx, JSValue this_val, int argc,
                                                JSValue* argv) {
    return JS_NewBool(ctx, mik__is_unloadable_namespace(ctx, argv[0]));
}

static JSValue mik__sys_active_timers(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = static_cast<MIKRuntime*>(JS_GetContextOpaque(ctx));
    CHECK_NOT_NULL(mik_rt);
    return JS_NewInt32(ctx, static_cast<int32_t>(mik_rt->timers->entries.size()));
}

static JSValue mik__sys_set_time(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    int64_t millis;
    if (JS_ToInt64(ctx, &millis, argv[0])) {
        return JS_EXCEPTION;
    }
    struct timeval tv = {
        .tv_sec = static_cast<time_t>(millis / 1000),
        .tv_usec = static_cast<suseconds_t>((millis % 1000) * 1000),
    };
    if (settimeofday(&tv, NULL) != 0) {
        return mik_throw_errno(ctx, errno);
    }
    return JS_UNDEFINED;
}

static JSValue mik__sys_uptime(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const MIKPlatform* platform = MIK_GetPlatform();
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "boot",
                      JS_NewFloat64(ctx, static_cast<double>(platform->get_boot_us()) / 1000.0));
    JS_SetPropertyStr(ctx, obj, "rtc",
                      JS_NewFloat64(ctx, static_cast<double>(platform->get_rtc_us()) / 1000.0));
    return obj;
}

static JSValue mik__sys_restart(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIK_GetPlatform()->restart();
    return JS_UNDEFINED;
}

static JSValue mik__sys_board(JSContext* ctx) {
    JSValue obj = JS_NewObject(ctx);
#ifdef MIK_BOARD_NAME
    JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, MIK_BOARD_NAME));
#else
    JS_SetPropertyStr(ctx, obj, "name", JS_NewString(ctx, "generic"));
#endif

#ifdef CONFIG_IDF_TARGET
    JS_SetPropertyStr(ctx, obj, "chip", JS_NewString(ctx, CONFIG_IDF_TARGET));

    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);
    JS_SetPropertyStr(ctx, obj, "cores", JS_NewInt32(ctx, chip_info.cores));
    JS_SetPropertyStr(ctx, obj, "revision", JS_NewInt32(ctx, chip_info.revision));

    /* Features as string array */
    JSValue features = JS_NewArray(ctx);
    uint32_t fi = 0;
    if (chip_info.features & CHIP_FEATURE_WIFI_BGN)
        JS_SetPropertyUint32(ctx, features, fi++, JS_NewString(ctx, "wifi"));
    if (chip_info.features & CHIP_FEATURE_BLE)
        JS_SetPropertyUint32(ctx, features, fi++, JS_NewString(ctx, "ble"));
    if (chip_info.features & CHIP_FEATURE_BT)
        JS_SetPropertyUint32(ctx, features, fi++, JS_NewString(ctx, "bt"));
    if (chip_info.features & CHIP_FEATURE_IEEE802154)
        JS_SetPropertyUint32(ctx, features, fi++, JS_NewString(ctx, "ieee802154"));
    JS_SetPropertyStr(ctx, obj, "features", features);

    /* Flash size in bytes */
    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);
    JS_SetPropertyStr(ctx, obj, "flash", JS_NewInt64(ctx, flash_size));

    /* PSRAM size in bytes */
#ifdef CONFIG_SPIRAM
    JS_SetPropertyStr(ctx, obj, "psram", JS_NewInt64(ctx, esp_psram_get_size()));
#else
    JS_SetPropertyStr(ctx, obj, "psram", JS_NewInt64(ctx, 0));
#endif

#else
    JS_SetPropertyStr(ctx, obj, "chip", JS_NewString(ctx, "host"));
    JS_SetPropertyStr(ctx, obj, "cores", JS_NewInt32(ctx, 1));
    JS_SetPropertyStr(ctx, obj, "revision", JS_NewInt32(ctx, 0));
    JS_SetPropertyStr(ctx, obj, "features", JS_NewArray(ctx));
    JS_SetPropertyStr(ctx, obj, "flash", JS_NewInt64(ctx, 0));
    JS_SetPropertyStr(ctx, obj, "psram", JS_NewInt64(ctx, 0));
#endif
    return obj;
}

// MIK_BUILD_DATE_UTC is a real UTC ISO-8601 string injected by CMake at
// configure time (`string(TIMESTAMP ... UTC)`). Preferred over `__DATE__`/
// `__TIME__` and `esp_app_desc_t::date/time`, which are the build host's
// *local* time and can't be correctly labelled as UTC without knowing the
// build machine's timezone.
#ifndef MIK_BUILD_DATE_UTC
#define MIK_BUILD_DATE_UTC "unknown"
#endif

static JSValue mik__sys_firmware(JSContext* ctx) {
    JSValue obj = JS_NewObject(ctx);
#ifdef CONFIG_IDF_TARGET
    const esp_app_desc_t* desc = esp_app_get_description();
    char elf_hash[65];
    for (int i = 0; i < 32; i++) {
        snprintf(elf_hash + i * 2, 3, "%02x", desc->app_elf_sha256[i]);
    }
    JS_SetPropertyStr(ctx, obj, "hash", JS_NewString(ctx, elf_hash));
    JS_SetPropertyStr(ctx, obj, "date", JS_NewString(ctx, MIK_BUILD_DATE_UTC));
    JS_SetPropertyStr(ctx, obj, "idfVersion", JS_NewString(ctx, desc->idf_ver));
#else
    JS_SetPropertyStr(ctx, obj, "hash", JS_NewString(ctx, "dev"));
    JS_SetPropertyStr(ctx, obj, "date", JS_NewString(ctx, MIK_BUILD_DATE_UTC));
    JS_SetPropertyStr(ctx, obj, "idfVersion", JS_NewString(ctx, "n/a"));
#endif
    return obj;
}

void mik__sys_api_init(JSContext* ctx, JSValue ns) {
    JS_SetPropertyStr(ctx, ns, "evalScript",
                      JS_NewCFunction(ctx, mik__sys_eval_script, "evalScript", 1));
    JS_SetPropertyStr(ctx, ns, "memoryUsage",
                      JS_NewCFunction(ctx, mik__sys_memory_usage, "memoryUsage", 0));
    JS_SetPropertyStr(ctx, ns, "jsMemoryUsage",
                      JS_NewCFunction(ctx, mik__sys_js_memory_usage, "jsMemoryUsage", 0));
    JS_SetPropertyStr(ctx, ns, "gc", JS_NewCFunction(ctx, mik__sys_gc, "gc", 0));
    JS_SetPropertyStr(ctx, ns, "unloadNamespace",
                      JS_NewCFunction(ctx, mik__sys_unload_namespace, "unloadNamespace", 1));
    JS_SetPropertyStr(
        ctx, ns, "isUnloadableNamespace",
        JS_NewCFunction(ctx, mik__sys_is_unloadable_namespace, "isUnloadableNamespace", 1));
    JS_SetPropertyStr(ctx, ns, "activeTimers",
                      JS_NewCFunction(ctx, mik__sys_active_timers, "activeTimers", 0));
    JS_SetPropertyStr(ctx, ns, "setTime",
                      JS_NewCFunction(ctx, mik__sys_set_time, "setTime", 1));
    JS_SetPropertyStr(ctx, ns, "uptime",
                      JS_NewCFunction(ctx, mik__sys_uptime, "uptime", 0));
    JS_SetPropertyStr(ctx, ns, "restart",
                      JS_NewCFunction(ctx, mik__sys_restart, "restart", 0));
    JS_SetPropertyStr(ctx, ns, "version",
#ifdef MIK_FW_VERSION
                      JS_NewString(ctx, MIK_FW_VERSION));
#else
                      JS_NewString(ctx, "0.0.0-dev"));
#endif
    JS_SetPropertyStr(ctx, ns, "board", mik__sys_board(ctx));
    JS_SetPropertyStr(ctx, ns, "firmware", mik__sys_firmware(ctx));

    const char* device_id = MIK_GetPlatform()->get_device_id();
    JS_SetPropertyStr(ctx, ns, "deviceId",
                      device_id ? JS_NewString(ctx, device_id) : JS_UNDEFINED);

    JS_SetPropertyStr(ctx, ns, "resetReason",
                      JS_NewString(ctx, MIK_GetPlatform()->get_reset_reason()));
}

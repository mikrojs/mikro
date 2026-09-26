// The chip's internal temperature sensor, as the public module
// @mikrojs-examples/chip-temperature (typed by chiptemp.d.ts). An example of a
// native driver: a factory that returns a Result, and a class handle that owns
// a hardware resource until end().
#include "esp_err.h"
#include "mikrojs/mikrojs.h"
#include "soc/soc_caps.h"

#if SOC_TEMP_SENSOR_SUPPORTED
#include "driver/temperature_sensor.h"
#endif

#define CHIP_TEMP_ERROR "ChipTemperatureError"

#if SOC_TEMP_SENSOR_SUPPORTED

struct ChipTempState {
    temperature_sensor_handle_t sensor = nullptr;
};

static JSClassID chiptemp_class_id;

/* Stops the sensor. Safe to call twice. */
static void chiptemp_stop(ChipTempState* s) {
    if (!s->sensor) return;
    temperature_sensor_disable(s->sensor);
    temperature_sensor_uninstall(s->sensor);
    s->sensor = nullptr;
}

static void chiptemp_finalizer(JSRuntime* rt, JSValue val) {
    auto* s = static_cast<ChipTempState*>(JS_GetOpaque(val, chiptemp_class_id));
    if (!s) return;
    chiptemp_stop(s);
    delete s;
}

static JSClassDef chiptemp_class = {
    .class_name = "ChipTemperature",
    .finalizer = chiptemp_finalizer,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

/* read() → Result<number, ChipTemperatureError> */
static JSValue js_chiptemp_read(JSContext* ctx, JSValueConst this_val, int argc,
                                JSValueConst* argv) {
    auto* s = static_cast<ChipTempState*>(JS_GetOpaque2(ctx, this_val, chiptemp_class_id));
    if (!s) return JS_EXCEPTION;
    if (!s->sensor) return MIK_ResultErrNamed(ctx, CHIP_TEMP_ERROR, "the sensor has ended");
    float celsius = 0;
    esp_err_t err = temperature_sensor_get_celsius(s->sensor, &celsius);
    if (err != ESP_OK) {
        return MIK_ResultErrNamed(ctx, CHIP_TEMP_ERROR, "reading failed: %s",
                                  esp_err_to_name(err));
    }
    return MIK_ResultOk(ctx, JS_NewFloat64(ctx, celsius));
}

/* end(): stops the sensor, so that another handle can start it. */
static JSValue js_chiptemp_end(JSContext* ctx, JSValueConst this_val, int argc,
                               JSValueConst* argv) {
    auto* s = static_cast<ChipTempState*>(JS_GetOpaque2(ctx, this_val, chiptemp_class_id));
    if (!s) return JS_EXCEPTION;
    if (!s->sensor) return JS_UNDEFINED;
    chiptemp_stop(s);
    MIK_DropHandle(ctx, this_val);
    return JS_UNDEFINED;
}

/* ChipTemperature() → Result<ChipTemperature, ChipTemperatureError> */
static JSValue js_chiptemp_open(JSContext* ctx, JSValueConst this_val, int argc,
                                JSValueConst* argv) {
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    temperature_sensor_handle_t sensor = nullptr;
    esp_err_t err = temperature_sensor_install(&config, &sensor);
    if (err == ESP_ERR_INVALID_STATE) {
        return MIK_ResultErrNamed(ctx, CHIP_TEMP_ERROR,
                                  "the sensor is in use; end() the other handle first");
    }
    if (err == ESP_OK) err = temperature_sensor_enable(sensor);
    if (err != ESP_OK) {
        if (sensor) temperature_sensor_uninstall(sensor);
        return MIK_ResultErrNamed(ctx, CHIP_TEMP_ERROR, "starting the sensor failed: %s",
                                  esp_err_to_name(err));
    }

    JSValue handle = JS_NewObjectClass(ctx, chiptemp_class_id);
    if (JS_IsException(handle)) {
        temperature_sensor_disable(sensor);
        temperature_sensor_uninstall(sensor);
        return handle;
    }
    auto* s = new ChipTempState();
    s->sensor = sensor;
    JS_SetOpaque(handle, s);
    /* The handle owns the sensor, so it lives until end(). */
    MIK_KeepHandle(ctx, handle);
    return MIK_ResultOk(ctx, handle);
}

static int chiptemp_module_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExport(ctx, m, "ChipTemperature",
                              JS_NewCFunction(ctx, js_chiptemp_open, "ChipTemperature", 0));
}

static JSModuleDef* chiptemp_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);
    MIK_NewClassID(rt, &chiptemp_class_id);
    JS_NewClass(rt, chiptemp_class_id, &chiptemp_class);
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, proto, "read", JS_NewCFunction(ctx, js_chiptemp_read, "read", 0));
    JS_SetPropertyStr(ctx, proto, "end", JS_NewCFunction(ctx, js_chiptemp_end, "end", 0));
    JS_SetClassProto(ctx, chiptemp_class_id, proto);

    JSModuleDef* m = JS_NewCModule(ctx, "@mikrojs-examples/chip-temperature", chiptemp_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "ChipTemperature");
    return m;
}

#else

/* Chips without a temperature sensor (the original ESP32) still get the module,
 * so that apps can import it and handle the error. */
static JSValue js_chiptemp_open(JSContext* ctx, JSValueConst this_val, int argc,
                                JSValueConst* argv) {
    return MIK_ResultErrNamed(ctx, CHIP_TEMP_ERROR, "this chip has no temperature sensor");
}

static int chiptemp_module_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExport(ctx, m, "ChipTemperature",
                              JS_NewCFunction(ctx, js_chiptemp_open, "ChipTemperature", 0));
}

static JSModuleDef* chiptemp_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "@mikrojs-examples/chip-temperature", chiptemp_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "ChipTemperature");
    return m;
}

#endif

MIK_REGISTER_PUBLIC_MODULE(chiptemp, "@mikrojs-examples/chip-temperature", chiptemp_init, nullptr,
                           nullptr)

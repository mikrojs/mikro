#pragma once
#include <quickjs.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct UJSRuntime UJSRuntime;

typedef struct UJSRunOptions {
    int mem_limit;
    size_t stack_size;
} UJSRunOptions;

void UJS_DefaultOptions(UJSRunOptions* options);
UJSRuntime* UJS_NewRuntime(void);
UJSRuntime* UJS_NewRuntimeOptions(UJSRunOptions* options);
void UJS_FreeRuntime(UJSRuntime* ujs_rt);

JSContext* UJS_GetJSContext(UJSRuntime* ujs_rt);
UJSRuntime* UJS_GetRuntime(JSContext* ctx);
int UJS_Loop(UJSRuntime* ujs_rt);
void UJS_Stop(UJSRuntime* ujs_rt);

#ifdef __cplusplus
}
#endif

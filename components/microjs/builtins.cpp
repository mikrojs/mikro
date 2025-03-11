
#include "private.h"
#include "utils.h"

typedef struct {
    const char* name;
    const uint8_t* data;
    uint32_t data_size;
} ujs_builtin_t;

static ujs_builtin_t builtins[] = {
    {NULL, NULL, 0},
};

JSModuleDef* ujs__load_builtin(JSContext* ctx, const char* name) {
    ujs_builtin_t* item = NULL;

    for (ujs_builtin_t* p = builtins; p->name != NULL; ++p) {
        if (strncmp(p->name, name, strlen(p->name)) == 0) {
            item = p;
            break;
        }
    }

    if (item == NULL) {
        return NULL;
    }

    JSValue obj = JS_ReadObject(ctx, item->data, item->data_size, JS_READ_OBJ_BYTECODE);

    CHECK_EQ(JS_IsException(obj), 0);
    CHECK_EQ(JS_VALUE_GET_TAG(obj), JS_TAG_MODULE);

    JSModuleDef* m = static_cast<JSModuleDef*>(JS_VALUE_GET_PTR(obj));
    JS_FreeValue(ctx, obj);

    return m;
}

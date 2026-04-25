#include <quickjs.h>

#include "mikrojs/private.h"
#include "mikrojs/utils.h"

int mik__eval_bytecode(JSContext* ctx, const uint8_t* buf, size_t buf_len, bool check_promise) {
    JSValue obj = JS_ReadObject(ctx, buf, buf_len, JS_READ_OBJ_BYTECODE);

    if (JS_IsException(obj)) {
        mik_dump_error(ctx);
        return -1;
    }

    if (JS_VALUE_GET_TAG(obj) == JS_TAG_MODULE) {
        if (JS_ResolveModule(ctx, obj) < 0) {
            JS_FreeValue(ctx, obj);
            mik_dump_error(ctx);
            return -1;
        }
    }

    JSValue val = JS_EvalFunction(ctx, obj);
    if (JS_IsException(val)) {
        mik_dump_error(ctx);
        return -1;
    }

    if (check_promise) {
        JSPromiseStateEnum promise_state = JS_PromiseState(ctx, val);
        if (promise_state != (JSPromiseStateEnum)-1) {
            if (promise_state == JS_PROMISE_REJECTED) {
                JSValue res = JS_PromiseResult(ctx, val);
                JS_FreeValue(ctx, res);
                JS_FreeValue(ctx, val);
                return -1;
            }
        }
    }

    JS_FreeValue(ctx, val);
    return 0;
}

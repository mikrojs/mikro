#include <quickjs.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/*
 * Non-blocking read from stdin via VFS.
 * Works with any ESP-IDF console backend (UART, USB Serial/JTAG, etc.)
 * The default VFS console driver is already non-blocking for reads.
 */
static int mik__stdin_read_raw(uint8_t* buf, size_t size) {
    return MIK_GetPlatform()->stdin_read(buf, size);
}

static JSValue mik__stdout_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (mik__repl_is_protocol_mode()) {
        if (JS_GetTypedArrayType(argv[0]) == JS_TYPED_ARRAY_UINT8) {
            size_t size;
            const uint8_t* buf = JS_GetUint8Array(ctx, &size, argv[0]);
            if (!buf) return JS_EXCEPTION;
            mik__repl_proto_send_output(MIK_MSG_LOG, buf, size);
        } else {
            const char* str = JS_ToCString(ctx, argv[0]);
            if (!str) return JS_EXCEPTION;
            mik__repl_proto_send_output(MIK_MSG_LOG, str, strlen(str));
            JS_FreeCString(ctx, str);
        }
        return JS_UNDEFINED;
    }

    if (JS_GetTypedArrayType(argv[0]) == JS_TYPED_ARRAY_UINT8) {
        size_t size;
        const uint8_t* buf = JS_GetUint8Array(ctx, &size, argv[0]);
        if (!buf) {
            return JS_EXCEPTION;
        }
        MIK_GetPlatform()->stdout_write(buf, size);
    } else {
        const char* str = JS_ToCString(ctx, argv[0]);
        if (!str) {
            return JS_EXCEPTION;
        }
        MIK_GetPlatform()->stdout_write(str, strlen(str));
        JS_FreeCString(ctx, str);
    }
    return JS_UNDEFINED;
}

static JSValue mik__stdout_flush(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    fflush(stdout);
    fsync(fileno(stdout));
    return JS_UNDEFINED;
}

static JSValue mik__stdin_read_js(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    uint8_t buf[MIK_STDIN_BUF_SIZE];
    int len = mik__stdin_read_raw(buf, sizeof(buf));

    if (len <= 0) {
        return JS_UNDEFINED;
    }

    return JS_NewUint8ArrayCopy(ctx, buf, len);
}

/*
 * Register a JS callback to receive stdin data.
 * Called from the event loop (mik__stdin_consume) — no timers needed.
 */
static JSValue mik__stdin_set_handler(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (!JS_IsFunction(ctx, argv[0])) {
        return JS_ThrowTypeError(ctx, "expected a function");
    }

    /* Free previous handler if set */
    if (!JS_IsUndefined(mik_rt->stdin_state.on_data)) {
        JS_FreeValue(ctx, mik_rt->stdin_state.on_data);
    }

    mik_rt->stdin_state.on_data = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

/*
 * Unregister the stdin data callback.
 */
static JSValue mik__stdin_clear_handler(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (!JS_IsUndefined(mik_rt->stdin_state.on_data)) {
        JS_FreeValue(ctx, mik_rt->stdin_state.on_data);
        mik_rt->stdin_state.on_data = JS_UNDEFINED;
    }
    return JS_UNDEFINED;
}

/*
 * Called from MIK_Loop — reads stdin and dispatches to the JS handler.
 */
void mik__stdin_consume(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    CHECK_NOT_NULL(mik_rt);

    if (JS_IsUndefined(mik_rt->stdin_state.on_data)) {
        return;
    }

    uint8_t buf[256];
    int len = mik__stdin_read_raw(buf, sizeof(buf));
    if (len <= 0) {
        return;
    }

    JSValue data = JS_NewUint8ArrayCopy(ctx, buf, len);
    JSValue ret = JS_Call(ctx, mik_rt->stdin_state.on_data, JS_UNDEFINED, 1, &data);
    JS_FreeValue(ctx, data);
    if (JS_IsException(ret)) {
        mik_dump_error(ctx);
    }
    JS_FreeValue(ctx, ret);
}

void mik__stdio_init(JSContext* ctx, JSValue ns) {
    /* stdout */
    JSValue p_stdout = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, p_stdout, "write", JS_NewCFunction(ctx, mik__stdout_write, "write", 1));
    JS_SetPropertyStr(ctx, p_stdout, "flush",
                      JS_NewCFunction(ctx, mik__stdout_flush, "flush", 0));
    JS_SetPropertyStr(ctx, ns, "stdout", p_stdout);

    /* stdin */
    JSValue p_stdin = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, p_stdin, "read", JS_NewCFunction(ctx, mik__stdin_read_js, "read", 0));
    JS_SetPropertyStr(ctx, p_stdin, "setHandler",
                      JS_NewCFunction(ctx, mik__stdin_set_handler, "setHandler", 1));
    JS_SetPropertyStr(ctx, p_stdin, "clearHandler",
                      JS_NewCFunction(ctx, mik__stdin_clear_handler, "clearHandler", 0));
    JS_SetPropertyStr(ctx, ns, "stdin", p_stdin);
}

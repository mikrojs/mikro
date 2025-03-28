#pragma once
#include "quickjs.h"
#include <string>


static JSValue error_from_exception(JSContext *ctx) {
  const JSValue exception = JS_GetException(ctx);
  JS_FreeValue(ctx, exception);
  if (JS_IsError(ctx, exception)) {
    return exception;
  }
  return JS_UNDEFINED;
}

static const char *format_error(JSContext *ctx, JSValue error) {
  std::string exception_str = JS_ToCString(ctx, error);
  std::string stack_str;

  if (JS_IsError(ctx, error)) {
    JSValue stack = JS_GetPropertyStr(ctx, error, "stack");
    if (!JS_IsUndefined(stack)) {
      stack_str = JS_ToCString(ctx, stack);
    }
  }

  return std::string(exception_str).append("\n").append(stack_str).c_str();
}

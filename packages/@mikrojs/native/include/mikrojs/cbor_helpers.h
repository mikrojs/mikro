/**
 * Internal CBOR encode/decode helpers for JSValue ↔ nanocbor.
 * Used by mik_cbor.cpp (user-facing module) and mik_rtc.cpp (RTC storage).
 */

#pragma once

#include <nanocbor/nanocbor.h>
#include <quickjs.h>

#define MIK_CBOR_MAX_DEPTH 32

/**
 * Recursively encode a JS value into a nanocbor encoder.
 * Returns 0 on success, negative on error.
 * Works with both NULL-buffer (size calculation) and real-buffer passes.
 */
int mik__cbor_encode_value(JSContext* ctx, nanocbor_encoder_t* enc, JSValue val, int depth);

/**
 * Decode one CBOR value from a nanocbor decoder into a JS value.
 * Returns JS_EXCEPTION on error.
 */
JSValue mik__cbor_decode_value(JSContext* ctx, nanocbor_value_t* val, int depth);

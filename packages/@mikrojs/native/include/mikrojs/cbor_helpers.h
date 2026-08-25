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

/**
 * Skip the value at the iterator, treating it as ONE item of the container the
 * iterator is walking.
 *
 * nanocbor_skip() cannot be used directly for that: it walks a nested container
 * on the same iterator and decrements `remaining` once per inner item, so
 * skipping a container value underflows the outer container's count and every
 * later key reads as "end of map". Lifting the count for the duration keeps the
 * walk bounded by the buffer end, which is the bound that matters.
 *
 * Returns what nanocbor_skip() returned.
 */
static inline int mik__cbor_skip_value(nanocbor_value_t* it) {
    uint64_t remaining = it->remaining;
    it->remaining = UINT64_MAX;
    int res = nanocbor_skip(it);
    it->remaining = remaining > 0 ? remaining - 1 : 0;
    return res;
}

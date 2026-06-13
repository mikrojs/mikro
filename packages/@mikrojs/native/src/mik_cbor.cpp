#include <cmath>
#include <cstring>

#include <nanocbor/nanocbor.h>
#include <quickjs.h>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/utils.h"

/* ── Encoder ────────────────────────────────────────────────────────── */

int mik__cbor_encode_value(JSContext* ctx, nanocbor_encoder_t* enc, JSValue val, int depth) {
    if (depth > MIK_CBOR_MAX_DEPTH) {
        return -1;
    }

    int tag = JS_VALUE_GET_NORM_TAG(val);

    switch (tag) {
        case JS_TAG_INT: {
            int32_t v;
            JS_ToInt32(ctx, &v, val);
            nanocbor_fmt_int(enc, v);
            return 0;
        }

        case JS_TAG_FLOAT64: {
            double d = JS_VALUE_GET_FLOAT64(val);
            /* Encode integers compactly */
            if (std::isfinite(d) && d == std::trunc(d) && d >= -2147483648.0 && d <= 2147483647.0) {
                nanocbor_fmt_int(enc, static_cast<int64_t>(d));
            } else {
                nanocbor_fmt_double(enc, d);
            }
            return 0;
        }

        case JS_TAG_BOOL: {
            nanocbor_fmt_bool(enc, JS_ToBool(ctx, val) != 0);
            return 0;
        }

        case JS_TAG_NULL: {
            nanocbor_fmt_null(enc);
            return 0;
        }

        case JS_TAG_UNDEFINED: {
            nanocbor_fmt_undefined(enc);
            return 0;
        }

        case JS_TAG_STRING: {
            size_t len = 0;
            const char* str = JS_ToCStringLen(ctx, &len, val);
            if (!str) return -1;
            nanocbor_put_tstrn(enc, str, len);
            JS_FreeCString(ctx, str);
            return 0;
        }

        case JS_TAG_OBJECT: {
            /* Uint8Array -> bstr */
            if (JS_GetTypedArrayType(val) == JS_TYPED_ARRAY_UINT8) {
                size_t len = 0;
                const uint8_t* data = JS_GetUint8Array(ctx, &len, val);
                if (!data && len > 0) return -1;
                nanocbor_put_bstr(enc, data, len);
                return 0;
            }

            /* Array */
            if (JS_IsArray(val)) {
                JSValue length_val = JS_GetPropertyStr(ctx, val, "length");
                uint32_t length = 0;
                JS_ToUint32(ctx, &length, length_val);
                JS_FreeValue(ctx, length_val);

                nanocbor_fmt_array(enc, length);
                for (uint32_t i = 0; i < length; i++) {
                    JSValue elem = JS_GetPropertyUint32(ctx, val, i);
                    int rc = mik__cbor_encode_value(ctx, enc, elem, depth + 1);
                    JS_FreeValue(ctx, elem);
                    if (rc < 0) return rc;
                }
                return 0;
            }

            /* Plain object -> map with string keys */
            if (JS_IsFunction(ctx, val) || JS_IsError(val)) {
                return -1;
            }

            JSPropertyEnum* props = nullptr;
            uint32_t prop_count = 0;
            if (JS_GetOwnPropertyNames(ctx, &props, &prop_count, val,
                                       JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
                return -1;
            }

            nanocbor_fmt_map(enc, prop_count);
            for (uint32_t i = 0; i < prop_count; i++) {
                const char* key = JS_AtomToCString(ctx, props[i].atom);
                if (!key) {
                    js_free(ctx, props);
                    return -1;
                }
                nanocbor_put_tstr(enc, key);
                JS_FreeCString(ctx, key);

                JSValue prop_val = JS_GetProperty(ctx, val, props[i].atom);
                int rc = mik__cbor_encode_value(ctx, enc, prop_val, depth + 1);
                JS_FreeValue(ctx, prop_val);
                if (rc < 0) {
                    js_free(ctx, props);
                    return rc;
                }
            }

            js_free(ctx, props);
            return 0;

        }

        default:
            return -1;
    }
}

static JSValue mik__cbor_encode(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc < 1) {
        return mik__result_err_named(ctx, "EncodeFailed",
                                     "CBOR encode requires a value argument");
    }

    JSValue val = argv[0];

    /* Pass 1: compute size with NULL buffer */
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, nullptr, 0);
    if (mik__cbor_encode_value(ctx, &enc, val, 0) < 0) {
        return mik__result_err_named(
            ctx, "EncodeFailed",
            "CBOR encode failed: unsupported value type or max depth exceeded");
    }
    size_t needed = nanocbor_encoded_len(&enc);

    /* Pass 2: encode into buffer */
    auto* buf = static_cast<uint8_t*>(js_malloc(ctx, needed > 0 ? needed : 1));
    if (!buf) return JS_EXCEPTION;

    nanocbor_encoder_init(&enc, buf, needed);
    if (mik__cbor_encode_value(ctx, &enc, val, 0) < 0) {
        js_free(ctx, buf);
        return mik__result_err_named(ctx, "EncodeFailed",
                                     "CBOR encode failed during buffer write");
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, buf, needed);
    js_free(ctx, buf);

    if (JS_IsException(result)) return JS_EXCEPTION;
    return mik__result_ok(ctx, result);
}

/* ── Decoder ────────────────────────────────────────────────────────── */

JSValue mik__cbor_decode_value(JSContext* ctx, nanocbor_value_t* val, int depth) {
    if (depth > MIK_CBOR_MAX_DEPTH) {
        return JS_EXCEPTION;
    }

    int type = nanocbor_get_type(val);
    if (type < 0) return JS_EXCEPTION;

    switch (type) {
        case NANOCBOR_TYPE_UINT: {
            uint64_t v;
            if (nanocbor_get_uint64(val, &v) < 0) return JS_EXCEPTION;
            if (v <= INT64_MAX) {
                return JS_NewInt64(ctx, static_cast<int64_t>(v));
            }
            return JS_NewFloat64(ctx, static_cast<double>(v));
        }

        case NANOCBOR_TYPE_NINT: {
            int64_t v;
            if (nanocbor_get_int64(val, &v) < 0) return JS_EXCEPTION;
            return JS_NewInt64(ctx, v);
        }

        case NANOCBOR_TYPE_BSTR: {
            const uint8_t* buf = nullptr;
            size_t len = 0;
            if (nanocbor_get_bstr(val, &buf, &len) < 0) return JS_EXCEPTION;
            return JS_NewUint8ArrayCopy(ctx, buf, len);
        }

        case NANOCBOR_TYPE_TSTR: {
            const uint8_t* buf = nullptr;
            size_t len = 0;
            if (nanocbor_get_tstr(val, &buf, &len) < 0) return JS_EXCEPTION;
            return JS_NewStringLen(ctx, reinterpret_cast<const char*>(buf), len);
        }

        case NANOCBOR_TYPE_ARR: {
            nanocbor_value_t arr;
            if (nanocbor_enter_array(val, &arr) < 0) return JS_EXCEPTION;

            JSValue result = JS_NewArray(ctx);
            uint32_t idx = 0;
            while (!nanocbor_at_end(&arr)) {
                JSValue elem = mik__cbor_decode_value(ctx, &arr, depth + 1);
                if (JS_IsException(elem)) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }
                JS_SetPropertyUint32(ctx, result, idx++, elem);
            }
            nanocbor_leave_container(val, &arr);
            return result;
        }

        case NANOCBOR_TYPE_MAP: {
            nanocbor_value_t map;
            if (nanocbor_enter_map(val, &map) < 0) return JS_EXCEPTION;

            JSValue result = JS_NewObject(ctx);
            while (!nanocbor_at_end(&map)) {
                /* Key must be a text string */
                if (nanocbor_get_type(&map) != NANOCBOR_TYPE_TSTR) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }
                const uint8_t* key_buf = nullptr;
                size_t key_len = 0;
                if (nanocbor_get_tstr(&map, &key_buf, &key_len) < 0) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }

                JSValue prop_val = mik__cbor_decode_value(ctx, &map, depth + 1);
                if (JS_IsException(prop_val)) {
                    JS_FreeValue(ctx, result);
                    return JS_EXCEPTION;
                }

                JSAtom atom =
                    JS_NewAtomLen(ctx, reinterpret_cast<const char*>(key_buf), key_len);
                JS_SetProperty(ctx, result, atom, prop_val);
                JS_FreeAtom(ctx, atom);
            }
            nanocbor_leave_container(val, &map);
            return result;
        }

        case NANOCBOR_TYPE_TAG: {
            /* Strip tags: skip tag number and decode inner value */
            uint32_t tag_num;
            if (nanocbor_get_tag(val, &tag_num) < 0) return JS_EXCEPTION;
            return mik__cbor_decode_value(ctx, val, depth);
        }

        case NANOCBOR_TYPE_FLOAT: {
            /* Check for simple values first (bool, null, undefined) */
            bool b;
            if (nanocbor_get_bool(val, &b) >= 0) {
                return JS_NewBool(ctx, b);
            }
            if (nanocbor_get_null(val) >= 0) {
                return JS_NULL;
            }
            if (nanocbor_get_undefined(val) >= 0) {
                return JS_UNDEFINED;
            }

            /* Float value */
            double d;
            if (nanocbor_get_double(val, &d) >= 0) {
                return JS_NewFloat64(ctx, d);
            }
            return JS_EXCEPTION;
        }

        default:
            return JS_EXCEPTION;
    }
}

static JSValue mik__cbor_decode(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc < 1 || JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT8) {
        return mik__result_err_named(ctx, "DecodeFailed",
                                     "CBOR decode requires a Uint8Array argument");
    }

    size_t len = 0;
    const uint8_t* data = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!data && len > 0) {
        return mik__result_err_named(ctx, "DecodeFailed",
                                     "CBOR decode failed to read input buffer");
    }

    nanocbor_value_t decoder;
    nanocbor_decoder_init(&decoder, data, len);

    JSValue result = mik__cbor_decode_value(ctx, &decoder, 0);
    if (JS_IsException(result)) {
        return mik__result_err_named(ctx, "DecodeFailed",
                                     "CBOR decode failed: malformed or unsupported data");
    }

    return mik__result_ok(ctx, result);
}

/* ── Module registration ────────────────────────────────────────────── */

static int mik__cbor_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "encode", JS_NewCFunction(ctx, mik__cbor_encode, "encode", 1));
    JS_SetModuleExport(ctx, m, "decode", JS_NewCFunction(ctx, mik__cbor_decode, "decode", 1));
    return 0;
}

JSModuleDef* mik__cbor_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/cbor", mik__cbor_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "encode");
    JS_AddModuleExport(ctx, m, "decode");
    return m;
}

// Registered explicitly in mikrojs.cpp (MIK_NewRuntime) rather than via
// MIK_REGISTER_MODULE, which relies on __attribute__((constructor)) that
// doesn't survive static library linking into Node.js addons.

#include <quickjs.h>
#include <string.h>

#include "mikrojs/utils.h"

/* ---- TextEncoder ---- */

static JSClassID textencoder_class_id;

static JSClassDef textencoder_classdef = {
    .class_name = "TextEncoder",
    .finalizer = nullptr,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

static JSValue mik__text_encoder_constructor(JSContext* ctx, JSValue new_target, int argc,
                                             JSValue* argv) {
    return JS_NewObjectClass(ctx, textencoder_class_id);
}

static JSValue mik__text_encoder_encode(JSContext* ctx, JSValue this_val, int argc,
                                        JSValue* argv) {
    const char* str = JS_ToCString(ctx, argv[0]);
    if (!str) {
        return JS_EXCEPTION;
    }
    JSValue ret = JS_NewUint8ArrayCopy(ctx, (const uint8_t*)str, strlen(str));
    JS_FreeCString(ctx, str);
    return ret;
}

static const JSCFunctionListEntry mik__text_encoder_proto_funcs[] = {
    MIK_CFUNC_DEF("encode", 1, mik__text_encoder_encode),
};

/* ---- TextDecoder ---- */

typedef struct {
    uint8_t pending[4];   /* up to 3 bytes of a leading incomplete sequence */
    uint8_t pending_len;  /* 0..3 */
} MIKTextDecoder;

static JSClassID textdecoder_class_id;

static void mik__text_decoder_finalizer(JSRuntime* rt, JSValue val) {
    MIKTextDecoder* state = static_cast<MIKTextDecoder*>(JS_GetOpaque(val, textdecoder_class_id));
    if (state) js_free_rt(rt, state);
}

static JSClassDef textdecoder_classdef = {
    .class_name = "TextDecoder",
    .finalizer = mik__text_decoder_finalizer,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

/* Case-insensitive ASCII match for utf-8 / utf8 (with optional surrounding
 * ASCII whitespace, matching WHATWG "get an encoding" label trimming). */
static bool is_utf8_label(const char* s) {
    while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r' || *s == '\f') s++;
    const char* end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\n' ||
                       end[-1] == '\r' || end[-1] == '\f')) {
        end--;
    }
    size_t len = (size_t)(end - s);
    char buf[8];
    if (len == 0 || len >= sizeof(buf)) return false;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
        buf[i] = c;
    }
    buf[len] = '\0';
    return strcmp(buf, "utf-8") == 0 || strcmp(buf, "utf8") == 0;
}

static JSValue mik__text_decoder_constructor(JSContext* ctx, JSValue new_target, int argc,
                                             JSValue* argv) {
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        const char* label = JS_ToCString(ctx, argv[0]);
        if (!label) return JS_EXCEPTION;
        bool ok = is_utf8_label(label);
        JS_FreeCString(ctx, label);
        if (!ok) {
            return JS_ThrowRangeError(ctx, "TextDecoder: only 'utf-8' is supported");
        }
    }
    JSValue obj = JS_NewObjectClass(ctx, textdecoder_class_id);
    if (JS_IsException(obj)) return obj;
    MIKTextDecoder* state = static_cast<MIKTextDecoder*>(js_mallocz(ctx, sizeof(MIKTextDecoder)));
    if (!state) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, state);
    return obj;
}

/* Return the expected UTF-8 sequence length given a lead byte, or 0 if the
 * byte is not a valid lead. */
static int utf8_seq_len(uint8_t b) {
    if (b < 0x80) return 1;
    if ((b & 0xE0) == 0xC0) return 2;
    if ((b & 0xF0) == 0xE0) return 3;
    if ((b & 0xF8) == 0xF0) return 4;
    return 0;
}

/* Validate a complete UTF-8 sequence of the given length. Checks continuation
 * bytes, overlong encodings, surrogate range, and max codepoint. */
static bool utf8_seq_valid(const uint8_t* p, int len) {
    if (len == 1) return p[0] < 0x80;
    for (int i = 1; i < len; i++) {
        if ((p[i] & 0xC0) != 0x80) return false;
    }
    if (len == 2) {
        return p[0] >= 0xC2;  /* reject overlong */
    }
    if (len == 3) {
        if (p[0] == 0xE0 && p[1] < 0xA0) return false;  /* overlong */
        if (p[0] == 0xED && p[1] >= 0xA0) return false;  /* surrogate */
        return true;
    }
    if (len == 4) {
        if (p[0] == 0xF0 && p[1] < 0x90) return false;  /* overlong */
        if (p[0] == 0xF4 && p[1] >= 0x90) return false;  /* > U+10FFFF */
        if (p[0] > 0xF4) return false;
        return true;
    }
    return false;
}

/* Append U+FFFD (EF BF BD) to buffer. */
static void append_replacement(uint8_t* out, size_t* out_len) {
    out[(*out_len)++] = 0xEF;
    out[(*out_len)++] = 0xBF;
    out[(*out_len)++] = 0xBD;
}

static JSValue mik__text_decoder_decode(JSContext* ctx, JSValue this_val, int argc,
                                        JSValue* argv) {
    MIKTextDecoder* state =
        static_cast<MIKTextDecoder*>(JS_GetOpaque2(ctx, this_val, textdecoder_class_id));
    if (!state) return JS_EXCEPTION;

    const uint8_t* data = nullptr;
    size_t len = 0;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        if (JS_GetTypedArrayType(argv[0]) != JS_TYPED_ARRAY_UINT8) {
            return JS_ThrowTypeError(ctx, "expected Uint8Array");
        }
        data = JS_GetUint8Array(ctx, &len, argv[0]);
        if (!data) return JS_EXCEPTION;
    }

    bool stream = false;
    if (argc >= 2 && JS_IsObject(argv[1])) {
        JSValue sv = JS_GetPropertyStr(ctx, argv[1], "stream");
        if (JS_IsException(sv)) return JS_EXCEPTION;
        stream = JS_ToBool(ctx, sv);
        JS_FreeValue(ctx, sv);
    }

    /* Common fast path: no pending bytes, scan `data` in place. Slow path
     * (pending carry-over) copies pending + data into a buffer. */
    size_t total = state->pending_len + len;
    const uint8_t* input;
    uint8_t stackbuf[8];
    uint8_t* heap_input = nullptr;
    if (state->pending_len == 0) {
        input = data;
    } else if (total <= sizeof(stackbuf)) {
        memcpy(stackbuf, state->pending, state->pending_len);
        if (len > 0) memcpy(stackbuf + state->pending_len, data, len);
        input = stackbuf;
    } else {
        heap_input = static_cast<uint8_t*>(js_malloc(ctx, total));
        if (!heap_input) return JS_EXCEPTION;
        memcpy(heap_input, state->pending, state->pending_len);
        memcpy(heap_input + state->pending_len, data, len);
        input = heap_input;
    }
    state->pending_len = 0;

    /* Worst case output: every byte becomes U+FFFD (3 bytes). */
    size_t out_cap = total * 3;
    if (out_cap == 0) out_cap = 1;
    uint8_t* out = static_cast<uint8_t*>(js_malloc(ctx, out_cap));
    if (!out) {
        if (heap_input) js_free(ctx, heap_input);
        return JS_EXCEPTION;
    }
    size_t out_len = 0;

    size_t i = 0;
    while (i < total) {
        uint8_t b = input[i];
        int seq = utf8_seq_len(b);
        if (seq == 0) {
            append_replacement(out, &out_len);
            i++;
            continue;
        }
        if (i + seq > total) {
            /* Incomplete trailing sequence. */
            if (stream) {
                size_t held = total - i;
                for (size_t k = 0; k < held; k++) state->pending[k] = input[i + k];
                state->pending_len = (uint8_t)held;
                break;
            }
            /* Flush: one U+FFFD per held byte. */
            for (size_t k = i; k < total; k++) append_replacement(out, &out_len);
            i = total;
            break;
        }
        if (!utf8_seq_valid(input + i, seq)) {
            append_replacement(out, &out_len);
            i++;
            continue;
        }
        memcpy(out + out_len, input + i, seq);
        out_len += seq;
        i += seq;
    }

    if (heap_input) js_free(ctx, heap_input);
    JSValue ret = JS_NewStringLen(ctx, (const char*)out, out_len);
    js_free(ctx, out);
    return ret;
}

static const JSCFunctionListEntry mik__text_decoder_proto_funcs[] = {
    MIK_CFUNC_DEF("decode", 1, mik__text_decoder_decode),
};

/* ---- btoa / atob ---- */

static const char b64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* The base64 decoder below is ported from QuickJS-NG (quickjs.c, `b64_decode`
 * and its lookup tables), which implements the WHATWG forgiving-base64 decode
 * algorithm. QuickJS-NG is MIT licensed:
 *   Copyright (c) 2017-2024 Fabrice Bellard, Charlie Gordon and contributors.
 * We use only the standard alphabet (atob/btoa never decode base64url) and
 * surface decode failures as our own error type rather than a DOMException. */
enum { K_VAL = 1u, K_WS = 2u };

/* Sextet value per base64 character (0 for non-base64 bytes; validity is gated
 * by b64_flags below). Positional initializer to stay standard C++. */
static const uint8_t b64_val[256] = {
    /* clang-format off */
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,62, 0, 0, 0,63,
    52,53,54,55,56,57,58,59,60,61, 0, 0, 0, 0, 0, 0,
     0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25, 0, 0, 0, 0, 0,
     0,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    /* clang-format on */
};

/* Per-byte class: K_WS (2) for ASCII whitespace, K_VAL (1) for the 64 standard
 * base64 alphabet characters, 0 (invalid) otherwise. */
static const char b64_flags[256] = {
    /* clang-format off */
     0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1,
     1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
     0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
     1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
     0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
     1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    /* clang-format on */
};

/* Implements https://infra.spec.whatwg.org/#forgiving-base64-decode.
 * Writes decoded bytes to dst and returns the count; sets *err on malformed
 * input. dst must have room for at least (len / 4) * 3 + 3 bytes. */
static size_t b64_decode(const char* src, size_t len, uint8_t* dst, int* err) {
    size_t i, j;
    uint32_t acc;
    int seen, pad;
    unsigned ch;

    acc = 0;
    seen = 0;
    for (i = 0, j = 0; i < len; i++) {
        ch = (unsigned char)src[i];
        if ((b64_flags[ch] & K_WS)) continue;
        if (!(b64_flags[ch] & K_VAL)) break;
        acc = (acc << 6) | b64_val[ch];
        seen++;
        if (seen == 4) {
            dst[j++] = (acc >> 16) & 0xFF;
            dst[j++] = (acc >> 8) & 0xFF;
            dst[j++] = acc & 0xFF;
            seen = 0;
            acc = 0;
        }
    }

    if (seen != 0) {
        if (seen == 3) {
            dst[j++] = (acc >> 10) & 0xFF;
            dst[j++] = (acc >> 2) & 0xFF;
        } else if (seen == 2) {
            dst[j++] = (acc >> 4) & 0xFF;
        } else {
            *err = 1;
            return 0;
        }
        for (pad = 0; i < len; i++) {
            ch = (unsigned char)src[i];
            if (pad < 2 && ch == '=') {
                pad++;
            } else if (!(b64_flags[ch] & K_WS)) {
                break;
            }
        }
        if (pad != 0 && seen + pad != 4) {
            *err = 1;
            return 0;
        }
    }

    *err = i < len;
    return j;
}

/* btoa: encode a binary string to base64.
 * Per the web spec, the argument is first coerced to a string (ToString), then
 * each character's code point is treated as a raw byte. We iterate by code
 * point, not by UTF-8 bytes, since JS_ToCStringLen would turn e.g. U+0080 into
 * two bytes (\xC2\x80). */
static JSValue mik__btoa(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    JSValue str_val = JS_ToString(ctx, argv[0]);
    if (JS_IsException(str_val)) return JS_EXCEPTION;

    JSValue len_val = JS_GetPropertyStr(ctx, str_val, "length");
    int64_t len;
    if (JS_ToInt64(ctx, &len, len_val)) {
        JS_FreeValue(ctx, len_val);
        JS_FreeValue(ctx, str_val);
        return JS_EXCEPTION;
    }
    JS_FreeValue(ctx, len_val);

    /* Extract code points into a byte buffer, validating latin1 range */
    uint8_t* bytes = static_cast<uint8_t*>(js_malloc(ctx, len > 0 ? len : 1));
    if (!bytes) {
        JS_FreeValue(ctx, str_val);
        return JS_EXCEPTION;
    }

    JSAtom charCodeAt_atom = JS_NewAtom(ctx, "charCodeAt");
    for (int64_t i = 0; i < len; i++) {
        JSValue idx = JS_NewInt64(ctx, i);
        JSValue code = JS_Invoke(ctx, str_val, charCodeAt_atom, 1, &idx);
        JS_FreeValue(ctx, idx);
        if (JS_IsException(code)) {
            JS_FreeAtom(ctx, charCodeAt_atom);
            js_free(ctx, bytes);
            JS_FreeValue(ctx, str_val);
            return JS_EXCEPTION;
        }
        int32_t cp;
        JS_ToInt32(ctx, &cp, code);
        JS_FreeValue(ctx, code);
        if (cp > 0xFF) {
            JS_FreeAtom(ctx, charCodeAt_atom);
            js_free(ctx, bytes);
            JS_FreeValue(ctx, str_val);
            return JS_ThrowRangeError(ctx,
                                      "The string to be encoded contains characters outside of the "
                                      "Latin1 range");
        }
        bytes[i] = (uint8_t)cp;
    }
    JS_FreeAtom(ctx, charCodeAt_atom);
    JS_FreeValue(ctx, str_val);

    size_t out_len = 4 * ((len + 2) / 3);
    char* out = static_cast<char*>(js_malloc(ctx, out_len + 1));
    if (!out) {
        js_free(ctx, bytes);
        return JS_EXCEPTION;
    }

    size_t j = 0;
    for (int64_t i = 0; i < len; i += 3) {
        uint32_t a = bytes[i];
        uint32_t b = (i + 1 < len) ? bytes[i + 1] : 0;
        uint32_t c = (i + 2 < len) ? bytes[i + 2] : 0;
        uint32_t triple = (a << 16) | (b << 8) | c;

        out[j++] = b64_table[(triple >> 18) & 0x3F];
        out[j++] = b64_table[(triple >> 12) & 0x3F];
        out[j++] = (i + 1 < len) ? b64_table[(triple >> 6) & 0x3F] : '=';
        out[j++] = (i + 2 < len) ? b64_table[triple & 0x3F] : '=';
    }
    out[j] = '\0';

    js_free(ctx, bytes);
    JSValue ret = JS_NewStringLen(ctx, out, j);
    js_free(ctx, out);
    return ret;
}

/* atob: decode a base64 string to a binary string. The argument is coerced to
 * a string (ToString) per spec, then decoded via the ported forgiving-base64
 * decoder above. */
static JSValue mik__atob(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    JSValue str_val = JS_ToString(ctx, argv[0]);
    if (JS_IsException(str_val)) return JS_EXCEPTION;
    size_t len;
    const char* str = JS_ToCStringLen(ctx, &len, str_val);
    JS_FreeValue(ctx, str_val);
    if (!str) return JS_EXCEPTION;

    size_t out_cap = (len / 4) * 3 + 3;
    uint8_t* out = static_cast<uint8_t*>(js_malloc(ctx, out_cap));
    if (!out) {
        JS_FreeCString(ctx, str);
        return JS_EXCEPTION;
    }

    int err = 0;
    size_t j = b64_decode(str, len, out, &err);
    JS_FreeCString(ctx, str);
    if (err) {
        js_free(ctx, out);
        return JS_ThrowSyntaxError(ctx,
                                   "The string to be decoded is not correctly encoded");
    }

    /* Convert decoded bytes to a JS string. Bytes 0x80-0xFF must become
     * their corresponding Unicode code points (U+0080-U+00FF), which in
     * UTF-8 are two-byte sequences. Build a UTF-8 buffer. */
    size_t utf8_cap = j * 2 + 1;  /* worst case: every byte is 0x80-0xFF */
    char* utf8 = static_cast<char*>(js_malloc(ctx, utf8_cap));
    if (!utf8) {
        js_free(ctx, out);
        return JS_EXCEPTION;
    }
    size_t utf8_len = 0;
    for (size_t i = 0; i < j; i++) {
        uint8_t b = (uint8_t)out[i];
        if (b < 0x80) {
            utf8[utf8_len++] = (char)b;
        } else {
            utf8[utf8_len++] = (char)(0xC0 | (b >> 6));
            utf8[utf8_len++] = (char)(0x80 | (b & 0x3F));
        }
    }

    js_free(ctx, out);
    JSValue ret = JS_NewStringLen(ctx, utf8, utf8_len);
    js_free(ctx, utf8);
    return ret;
}

/* ---- Registration ---- */

void mik__text_encoding_init(JSContext* ctx, JSValue global) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* TextEncoder */
    JS_NewClassID(rt, &textencoder_class_id);
    JS_NewClass(rt, textencoder_class_id, &textencoder_classdef);
    JSValue te_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, te_proto, mik__text_encoder_proto_funcs,
                               countof(mik__text_encoder_proto_funcs));
    JS_SetClassProto(ctx, textencoder_class_id, te_proto);
    JSValue te_ctor = JS_NewCFunction2(ctx, mik__text_encoder_constructor, "TextEncoder", 0,
                                       JS_CFUNC_constructor, 0);
    JS_DefinePropertyValueStr(ctx, global, "TextEncoder", te_ctor, JS_PROP_C_W_E);

    /* TextDecoder */
    JS_NewClassID(rt, &textdecoder_class_id);
    JS_NewClass(rt, textdecoder_class_id, &textdecoder_classdef);
    JSValue td_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, td_proto, mik__text_decoder_proto_funcs,
                               countof(mik__text_decoder_proto_funcs));
    JS_SetClassProto(ctx, textdecoder_class_id, td_proto);
    JSValue td_ctor = JS_NewCFunction2(ctx, mik__text_decoder_constructor, "TextDecoder", 0,
                                       JS_CFUNC_constructor, 0);
    JS_DefinePropertyValueStr(ctx, global, "TextDecoder", td_ctor, JS_PROP_C_W_E);

    /* btoa / atob */
    JS_DefinePropertyValueStr(ctx, global, "btoa",
                              JS_NewCFunction(ctx, mik__btoa, "btoa", 1), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, global, "atob",
                              JS_NewCFunction(ctx, mik__atob, "atob", 1), JS_PROP_C_W_E);
}

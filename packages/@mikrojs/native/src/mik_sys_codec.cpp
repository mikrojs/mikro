#include "mikrojs/sys_codec.h"

#include <nanocbor/nanocbor.h>

#include <cstdint>
#include <cstdio>
#include <cstring>

size_t mik__kv_encode_str(const char* value, uint8_t* out, size_t out_len) {
    /* The measuring pass needs a non-null base: an empty string still reaches
     * memcpy with length 0, and memcpy(NULL, ..., 0) is undefined behavior. */
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    nanocbor_put_tstr(&enc, value ? value : "");
    size_t needed = nanocbor_encoded_len(&enc);
    if (!out || out_len < needed) return needed;
    nanocbor_encoder_init(&enc, out, out_len);
    nanocbor_put_tstr(&enc, value ? value : "");
    return needed;
}

bool mik__kv_decode_str(const uint8_t* in, size_t in_len, char* out, size_t out_len) {
    if (!in || in_len == 0 || !out || out_len == 0) return false;
    nanocbor_value_t it;
    nanocbor_decoder_init(&it, in, in_len);
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(&it, &ptr, &len) < 0) return false;
    if (len + 1 > out_len) return false;
    memcpy(out, ptr, len);
    out[len] = '\0';
    return true;
}

size_t mik__kv_encode_i32(int32_t value, uint8_t* out, size_t out_len) {
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    nanocbor_fmt_int(&enc, value);
    size_t needed = nanocbor_encoded_len(&enc);
    if (!out || out_len < needed) return needed;
    nanocbor_encoder_init(&enc, out, out_len);
    nanocbor_fmt_int(&enc, value);
    return needed;
}

bool mik__kv_decode_i32(const uint8_t* in, size_t in_len, int32_t* out) {
    if (!in || in_len == 0 || !out) return false;
    nanocbor_value_t it;
    nanocbor_decoder_init(&it, in, in_len);
    return nanocbor_get_int32(&it, out) >= 0;
}


/* ── Device name pair ─────────────────────────────────────────────────────── */

namespace {

const char* skip_space(const char* p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}

}  // namespace

bool mik__device_name_parse(const char* json, int* out_rev, char* out_name, size_t name_len) {
    if (!json || !out_rev || !out_name || name_len == 0) return false;
    out_name[0] = '\0';

    const char* p = skip_space(json);
    if (*p != '[') return false;
    p = skip_space(p + 1);

    /* The revision. Negative and non-integer values are not pairs. */
    if (*p < '0' || *p > '9') return false;
    long rev = 0;
    while (*p >= '0' && *p <= '9') {
        rev = rev * 10 + (*p - '0');
        if (rev > INT32_MAX) return false;
        p++;
    }
    p = skip_space(p);
    *out_rev = (int)rev;

    if (*p == ']') return true;  /* [rev] — cleared */
    if (*p != ',') return false;
    p = skip_space(p + 1);

    /* A cleared name may also arrive as an explicit null. */
    if (strncmp(p, "null", 4) == 0) {
        p = skip_space(p + 4);
        return *p == ']';
    }
    if (*p != '"') return false;
    p++;

    size_t written = 0;
    while (*p && *p != '"') {
        /* Escapes: the writer is JSON.stringify, so a name can carry them. Only
         * the forms it emits are handled; anything else fails the parse rather
         * than storing a half-decoded name. */
        char c = *p;
        if (c == '\\') {
            p++;
            switch (*p) {
                case '"':
                case '\\':
                case '/':
                    c = *p;
                    break;
                case 'n':
                    c = '\n';
                    break;
                case 't':
                    c = '\t';
                    break;
                case 'r':
                    c = '\r';
                    break;
                case 'b':
                    c = '\b';
                    break;
                case 'f':
                    c = '\f';
                    break;
                default:
                    return false;
            }
        }
        if (written + 1 >= name_len) return false;
        out_name[written++] = c;
        p++;
    }
    if (*p != '"') return false;
    out_name[written] = '\0';
    p = skip_space(p + 1);
    return *p == ']';
}

size_t mik__device_name_format(int rev, const char* name, char* out, size_t out_len) {
    if (rev < 0) rev = 0;
    if (!name || !name[0]) {
        int needed = snprintf(nullptr, 0, "[%d]", rev);
        if (out && out_len > (size_t)needed) snprintf(out, out_len, "[%d]", rev);
        return (size_t)needed;
    }
    /* Escape what JSON requires. Control characters below 0x20 have no short
     * form here, so they are dropped rather than emitted raw — a name is display
     * text, and a device is not the place to grow a \u encoder. */
    char escaped[128];
    size_t w = 0;
    for (const char* p = name; *p && w + 2 < sizeof(escaped); p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '"' || c == '\\') {
            escaped[w++] = '\\';
            escaped[w++] = (char)c;
        } else if (c >= 0x20) {
            escaped[w++] = (char)c;
        }
    }
    escaped[w] = '\0';

    int needed = snprintf(nullptr, 0, "[%d,\"%s\"]", rev, escaped);
    if (out && out_len > (size_t)needed) snprintf(out, out_len, "[%d,\"%s\"]", rev, escaped);
    return (size_t)needed;
}

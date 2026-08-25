#pragma once

/**
 * Encodings for the runtime's persisted state, shared by its native and JS
 * readers.
 *
 * native:mikro/nvs_kv stores each value as the CBOR encoding of the value
 * itself, so `sysSet('ota.tries', 2)` writes a CBOR integer and
 * `sysSet('ota.url', s)` writes a CBOR text string. Native readers of those same
 * keys — the OTA policy store — have to agree byte for byte, or the C and JS
 * implementations disagree about live device state.
 *
 * These helpers are that agreement, in the portable library so host tests can
 * hold them to it.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Encode `value` as a bare CBOR text string. Returns the number of bytes the
 * encoding needs, which may exceed out_len — nothing is written in that case, so
 * a caller can measure with (NULL, 0) first. */
size_t mik__kv_encode_str(const char* value, uint8_t* out, size_t out_len);

/* Decode a bare CBOR text string into out (always NUL-terminated on success).
 * False when the value is not a text string or does not fit. */
bool mik__kv_decode_str(const uint8_t* in, size_t in_len, char* out, size_t out_len);

/* Encode `value` as a bare CBOR integer. */
size_t mik__kv_encode_i32(int32_t value, uint8_t* out, size_t out_len);

/* Decode a bare CBOR integer. False when the value is not an integer that fits
 * in an int32. */
bool mik__kv_decode_i32(const uint8_t* in, size_t in_len, int32_t* out);

/**
 * The device name pair.
 *
 * The platform stores it as the JSON text `[rev]` or `[rev, name]` — one value,
 * so the pair can never be read or written half-updated (see runtime/sys/sys.ts,
 * which is the other end of this encoding). Revision 0 with no name means never
 * named.
 */

/* Parse the stored pair. False when the text is not a well-formed pair, which
 * callers read as "never named" rather than as an error. `out_name` is set to the
 * empty string when the name was cleared. */
bool mik__device_name_parse(const char* json, int* out_rev, char* out_name, size_t name_len);

/* Format a pair for storage. Pass NULL or "" as `name` to write `[rev]`.
 * Returns the length the text needs, which may exceed out_len. */
size_t mik__device_name_format(int rev, const char* name, char* out, size_t out_len);

#ifdef __cplusplus
}
#endif

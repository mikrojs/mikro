// Build install: streaming gunzip -> untar of a build archive, and the swap
// that makes it the live app. Pure libc plus tinfl; the host test in
// firmware/components/mikrojs/test/ota_host/ compiles this file.

#include "mikrojs/build_install.h"

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include "mikrojs/app_store.h"
#include "mikrojs/platform.h"

// tinfl comes from miniz: the ESP32 mask ROM has it (the header comes with the
// always-available `esp_rom` dependency). A target without ROM miniz compiles
// it in.
#include "miniz.h"

namespace {

constexpr size_t kChunk = 4096;
constexpr size_t kTarBlock = 512;
constexpr size_t kTarName = 100;  // ustar name field width
constexpr int kMaxNameDepth = 8;  // path components a member may create

// The boot install and the deploy-time verify run on the main task with no
// MIK_Loop pass in between, so flash-bound loops feed the task watchdog here.
void feed_watchdog(void) {
    const MIKPlatform* platform = MIK_GetPlatform();
    if (platform && platform->feed_watchdog) platform->feed_watchdog();
}

// ── SHA-256 (FIPS 180-4) ─────────────────────────────────────────────────────
// Self-contained and host-validated against the standard vectors, so the build
// checksum is verified identically on host and device with no mbedTLS dependency
// to wire into the component. The offer checksum and `mikro app pack` both use
// SHA-256 over the whole .tgz.
struct Sha256 {
    uint32_t h[8];
    uint64_t len;  // total bytes hashed
    uint8_t buf[64];
    size_t buflen;
};

inline uint32_t sha256_ror(uint32_t v, int b) {
    return (v >> b) | (v << (32 - b));
}

void sha256_block(Sha256* c, const uint8_t* p) {
    static const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = sha256_ror(w[i - 15], 7) ^ sha256_ror(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = sha256_ror(w[i - 2], 17) ^ sha256_ror(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3];
    uint32_t e = c->h[4], f = c->h[5], g = c->h[6], hh = c->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = sha256_ror(e, 6) ^ sha256_ror(e, 11) ^ sha256_ror(e, 25);
        uint32_t ch = (e & f) ^ ((~e) & g);
        uint32_t t1 = hh + S1 + ch + K[i] + w[i];
        uint32_t S0 = sha256_ror(a, 2) ^ sha256_ror(a, 13) ^ sha256_ror(a, 22);
        uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + maj;
        hh = g;
        g = f;
        f = e;
        e = d + t1;
        d = cc;
        cc = b;
        b = a;
        a = t1 + t2;
    }
    c->h[0] += a;
    c->h[1] += b;
    c->h[2] += cc;
    c->h[3] += d;
    c->h[4] += e;
    c->h[5] += f;
    c->h[6] += g;
    c->h[7] += hh;
}

void sha256_init(Sha256* c) {
    c->h[0] = 0x6a09e667;
    c->h[1] = 0xbb67ae85;
    c->h[2] = 0x3c6ef372;
    c->h[3] = 0xa54ff53a;
    c->h[4] = 0x510e527f;
    c->h[5] = 0x9b05688c;
    c->h[6] = 0x1f83d9ab;
    c->h[7] = 0x5be0cd19;
    c->len = 0;
    c->buflen = 0;
}

void sha256_update(Sha256* c, const uint8_t* p, size_t n) {
    c->len += n;
    while (n) {
        size_t take = 64 - c->buflen;
        if (take > n) take = n;
        memcpy(c->buf + c->buflen, p, take);
        c->buflen += take;
        p += take;
        n -= take;
        if (c->buflen == 64) {
            sha256_block(c, c->buf);
            c->buflen = 0;
        }
    }
}

void sha256_final(Sha256* c, uint8_t out[32]) {
    uint64_t bits = c->len * 8;  // captured before padding
    uint8_t pad = 0x80;
    sha256_update(c, &pad, 1);
    uint8_t zero = 0;
    while (c->buflen != 56) sha256_update(c, &zero, 1);
    uint8_t lenb[8];
    for (int i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_update(c, lenb, 8);
    for (int i = 0; i < 8; i++) {
        out[i * 4] = c->h[i] >> 24;
        out[i * 4 + 1] = c->h[i] >> 16;
        out[i * 4 + 2] = c->h[i] >> 8;
        out[i * 4 + 3] = (uint8_t)c->h[i];
    }
}

// Hash a whole file into `out` (65 bytes: 64 lowercase hex + NUL). Hashing the
// staged file (not an in-memory running hash) is deliberate: a partial download
// can resume across a reboot, and the verify still works because it reads the
// bytes back off flash. Returns false on any I/O error.
bool sha256_file(const char* path, char out[65]) {
    FILE* f = fopen(path, "rb");
    if (!f) return false;
    unsigned char* buf = (unsigned char*)malloc(kChunk);
    if (!buf) {
        fclose(f);
        return false;
    }
    Sha256 c;
    sha256_init(&c);
    size_t n;
    while ((n = fread(buf, 1, kChunk, f)) > 0) {
        feed_watchdog();
        sha256_update(&c, buf, n);
    }
    bool read_err = ferror(f) != 0;
    free(buf);
    fclose(f);
    if (read_err) return false;
    uint8_t d[32];
    sha256_final(&c, d);
    static const char* H = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        out[i * 2] = H[d[i] >> 4];
        out[i * 2 + 1] = H[d[i] & 0xf];
    }
    out[64] = 0;
    return true;
}

// ── CRC-32 (gzip/zlib polynomial) ────────────────────────────────────────────
// Bit-by-bit so it needs no lookup table; one-shot over the decompressed build
// at install time, so the loop cost is irrelevant. Self-contained rather than
// miniz's mz_crc32 so it can't be compiled out by ESP-IDF's miniz config.
uint32_t crc32_update(uint32_t crc, const unsigned char* p, size_t n) {
    crc = crc ^ 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        crc ^= p[i];
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return crc ^ 0xFFFFFFFFu;
}

// Keep the last 8 bytes seen across a byte stream — the gzip trailer, captured
// as the file is read so it needs neither fseek (unreliable on some VFS) nor
// tinfl's end-of-stream input accounting (the esp32c6 ROM miniz mis-reports it).
void tail8_push(unsigned char tail[8], size_t* len, const unsigned char* p, size_t n) {
    if (n >= 8) {
        memcpy(tail, p + n - 8, 8);
        *len = 8;
        return;
    }
    if (n == 0) return;
    size_t keep = (*len + n > 8) ? (8 - n) : *len;  // bytes of the old tail to retain
    memmove(tail, tail + (*len - keep), keep);
    memcpy(tail + keep, p, n);
    *len = keep + n;
}

long octal(const char* p, int len) {
    long v = 0;
    for (int i = 0; i < len && p[i] >= '0' && p[i] <= '7'; i++) v = (v << 3) + (p[i] - '0');
    return v;
}

// Create every parent directory of `path` (the last component is the leaf and
// is left for the caller to create as a file or dir). EEXIST is fine. Makes the
// streaming untar robust whether or not the archive carries explicit dir
// entries. littlefs may ignore the mode argument; nothing here depends on it.
void mkdir_parents(const char* path) {
    char tmp[512];
    size_t n = strlen(path);
    if (n >= sizeof(tmp)) return;
    memcpy(tmp, path, n + 1);
    for (size_t i = 1; i < n; i++) {
        if (tmp[i] == '/') {
            tmp[i] = 0;
            mkdir(tmp, 0755);
            tmp[i] = '/';
        }
    }
}

// ── Streaming ustar extraction ───────────────────────────────────────────────
// Fed arbitrary byte chunks (the gunzip output), it reassembles 512-byte tar
// blocks across chunk boundaries and writes members to disk as they arrive, so
// no intermediate `.tar` ever lands on the app filesystem. Members are expected
// to be prefixed `app/...` (the build is `tar -C build app`), so dest_dir
// receives `app/...` and mik__app_commit renames dest_dir/app -> /app.
struct Untar {
    char dest[256];
    unsigned char block[kTarBlock];
    size_t fill;  // bytes accumulated toward the current 512-block
    enum { kHeader, kFile, kSkip } mode;
    FILE* cur;
    long remaining;     // file content bytes left to write
    long skip_blocks;   // 512-blocks left to discard (unknown entry types)
    bool failed;
    bool done;          // saw the end-of-archive marker
    const char* err;
    MIKBuildErr kind;   // corrupt for a malformed archive, transient for I/O
};

void untar_init(Untar* u, const char* dest) {
    snprintf(u->dest, sizeof(u->dest), "%s", dest);
    u->fill = 0;
    u->mode = Untar::kHeader;
    u->cur = nullptr;
    u->remaining = 0;
    u->skip_blocks = 0;
    u->failed = false;
    u->done = false;
    u->err = nullptr;
    u->kind = MIK_BUILD_ERR_CORRUPT;
}

// Rejects member names that would escape dest_dir. The checksum is no defence
// here: it arrives in the same offer as the URL, so whoever serves the offer
// controls both. Without this, a member named `../../app/main.js` writes
// straight over the live app (or the rollback baseline) during boot reconcile,
// before any JS gets to run.
bool unsafe_member_name(const unsigned char* block) {
    const char* n = (const char*)block;
    if (n[0] == '/' || n[0] == 0) return true;
    const size_t len = strnlen(n, kTarName);
    // A name filling the field without a terminator is truncated by the %.100s
    // below into a different path than the archive declared.
    if (len == kTarName) return true;
    // The ustar `prefix` field is not honored when building the path, so a
    // member relying on it would silently extract somewhere else.
    if (memcmp(block + 257, "ustar", 5) == 0 && block[345] != 0) return true;
    // Depth is capped because every directory level created here is a level
    // rmtree/rmdir_recursive later recurses over, and those run from boot
    // recovery where a stack overflow costs the device permanently. `a/` twice
    // per level fits ~49 levels in this field; real builds are 2-3 deep.
    int depth = 0;
    for (size_t i = 0; i < len; i++) {
        if (n[i] == '/' && ++depth > kMaxNameDepth) return true;
    }
    for (size_t i = 0; i + 1 < len; i++) {
        const bool at_start = (i == 0 || n[i - 1] == '/');
        if (!at_start || n[i] != '.' || n[i + 1] != '.') continue;
        if (i + 2 == len || n[i + 2] == '/') return true;
    }
    return false;
}

void untar_block(Untar* u) {
    if (u->mode == Untar::kHeader) {
        if (u->block[0] == 0) {  // zero block = end of archive
            u->done = true;
            return;
        }
        if (unsafe_member_name(u->block)) {
            u->failed = true;
            u->err = "unsafe path in build archive";
            u->kind = MIK_BUILD_ERR_CORRUPT;
            return;
        }
        char name[256];
        snprintf(name, sizeof(name), "%s/%.100s", u->dest, (const char*)u->block);
        long size = octal((const char*)u->block + 124, 12);
        char type = u->block[156];
        // A negative size would make `want` below wrap to a huge size_t and read
        // past the 512-byte block.
        if (size < 0) {
            u->failed = true;
            u->err = "bad member size in build archive";
            u->kind = MIK_BUILD_ERR_CORRUPT;
            return;
        }

        if (type == '5') {  // directory
            mkdir_parents(name);
            mkdir(name, 0755);
            return;
        }
        if (type == '0' || type == 0) {  // regular file
            mkdir_parents(name);
            u->cur = fopen(name, "wb");
            if (!u->cur) {
                u->failed = true;
                u->err = "create extracted file";
                u->kind = MIK_BUILD_ERR_TRANSIENT;
                return;
            }
            u->remaining = size;
            if (size == 0) {  // no data blocks follow
                if (fclose(u->cur) != 0) {
                    u->failed = true;
                    u->err = "close extracted file";
                    u->kind = MIK_BUILD_ERR_TRANSIENT;
                }
                u->cur = nullptr;
                return;
            }
            u->mode = Untar::kFile;
            return;
        }
        // Other entry types (symlink/longname/etc.) aren't produced by our
        // builds — discard their data blocks.
        u->skip_blocks = (size + kTarBlock - 1) / kTarBlock;
        if (u->skip_blocks > 0) u->mode = Untar::kSkip;
        return;
    }

    if (u->mode == Untar::kFile) {
        size_t want = u->remaining < (long)kTarBlock ? (size_t)u->remaining : kTarBlock;
        if (fwrite(u->block, 1, want, u->cur) != want) {
            fclose(u->cur);
            u->cur = nullptr;
            u->failed = true;
            u->err = "write extracted file";
            u->kind = MIK_BUILD_ERR_TRANSIENT;
            return;
        }
        u->remaining -= (long)want;  // trailing bytes of this block are padding
        if (u->remaining <= 0) {
            // littlefs surfaces ENOSPC at close, not at write, so an unchecked
            // fclose here would promote a silently truncated app file.
            if (fclose(u->cur) != 0) {
                u->failed = true;
                u->err = "close extracted file";
                u->kind = MIK_BUILD_ERR_TRANSIENT;
            }
            u->cur = nullptr;
            u->mode = Untar::kHeader;
        }
        return;
    }

    // kSkip
    if (--u->skip_blocks <= 0) u->mode = Untar::kHeader;
}

void untar_feed(Untar* u, const unsigned char* data, size_t n) {
    while (n > 0 && !u->failed && !u->done) {
        size_t take = kTarBlock - u->fill;
        if (take > n) take = n;
        memcpy(u->block + u->fill, data, take);
        u->fill += take;
        data += take;
        n -= take;
        if (u->fill == kTarBlock) {
            u->fill = 0;
            untar_block(u);
        }
    }
}

// Release the open member handle, if any. Split out from untar_finish because
// the failure path has to close it too, and must not overwrite the error that
// caused the failure with untar_finish's own.
void untar_close(Untar* u) {
    if (u->cur) {
        fclose(u->cur);
        u->cur = nullptr;
    }
}

bool untar_finish(Untar* u, const char** err) {
    if (u->cur) {
        // Still open means the archive ended mid-member: the app file on disk is
        // short. Reporting success here would promote a truncated app.
        if (fclose(u->cur) != 0 && !u->failed) {
            u->err = "close extracted file";
            u->kind = MIK_BUILD_ERR_TRANSIENT;
        } else if (!u->failed) {
            u->err = "build archive ended mid-file (truncated)";
            u->kind = MIK_BUILD_ERR_CORRUPT;
        }
        u->failed = true;
        u->cur = nullptr;
    }
    if (u->failed) {
        *err = u->err;
        return false;
    }
    return true;
}

// ── Streaming gunzip -> untar ────────────────────────────────────────────────
// Inflate in_path with miniz's low-level tinfl and feed the decompressed bytes
// straight into the untar state machine, so the .tar never hits disk. The gzip
// trailer (CRC-32 + ISIZE) is still verified — a corrupt or truncated download
// decompresses to garbage that won't match, so it is rejected before any swap.
bool unpack_tgz(const char* in_path, const char* dest_dir, const char** err, MIKBuildErr* kind) {
    *kind = MIK_BUILD_ERR_TRANSIENT;
    FILE* in = fopen(in_path, "rb");
    if (!in) {
        *err = "open .tgz";
        return false;
    }

    // Parse the gzip header, honoring the optional fields the FLG byte advertises
    // (FEXTRA/FNAME/FCOMMENT/FHCRC) instead of assuming a fixed 10-byte header.
    // Magic(2) CM(1) FLG(1) MTIME(4) XFL(1) OS(1) = 10 fixed bytes, then extras.
    int b0 = fgetc(in), b1 = fgetc(in), cm = fgetc(in), flg = fgetc(in);
    if (b0 != 0x1f || b1 != 0x8b || cm == EOF || flg == EOF) {
        fclose(in);
        *err = "not a gzip stream";
        *kind = MIK_BUILD_ERR_CORRUPT;
        return false;
    }
    for (int i = 0; i < 6; i++) fgetc(in);  // MTIME + XFL + OS
    bool hdr_ok = true;
    if (flg & 0x04) {  // FEXTRA: 2-byte LE length, then that many bytes
        int xl = fgetc(in), xh = fgetc(in);
        if (xl == EOF || xh == EOF) {
            hdr_ok = false;
        } else {
            for (int i = 0, xlen = xl | (xh << 8); i < xlen && hdr_ok; i++) {
                if (fgetc(in) == EOF) hdr_ok = false;
            }
        }
    }
    if (hdr_ok && (flg & 0x08)) {  // FNAME
        int c;
        do {
            c = fgetc(in);
        } while (c != 0 && c != EOF);
        if (c == EOF) hdr_ok = false;
    }
    if (hdr_ok && (flg & 0x10)) {  // FCOMMENT
        int c;
        do {
            c = fgetc(in);
        } while (c != 0 && c != EOF);
        if (c == EOF) hdr_ok = false;
    }
    if (hdr_ok && (flg & 0x02)) {  // FHCRC
        if (fgetc(in) == EOF || fgetc(in) == EOF) hdr_ok = false;
    }
    if (!hdr_ok) {
        fclose(in);
        *err = "bad gzip header";
        *kind = MIK_BUILD_ERR_CORRUPT;
        return false;
    }

    // Everything here goes on the HEAP, not the stack: this runs deep inside the
    // QuickJS / boot call chain where a multi-KB stack array would overflow.
    // That includes the decompressor itself -- tinfl_decompressor is ~11 KiB
    // against the ESP-IDF ROM miniz (three 3.5 KiB huffman tables), which alone
    // is half the main task stack. TINFL_LZ_DICT_SIZE (32 KiB) is the sliding
    // window tinfl requires.
    tinfl_decompressor* inflator = (tinfl_decompressor*)malloc(sizeof(tinfl_decompressor));
    unsigned char* window = (unsigned char*)malloc(TINFL_LZ_DICT_SIZE);
    unsigned char* inbuf = (unsigned char*)malloc(kChunk);
    if (!inflator || !window || !inbuf) {
        free(inflator);
        free(window);
        free(inbuf);
        fclose(in);
        *err = "oom (inflate buffers)";
        *kind = MIK_BUILD_ERR_OOM;
        return false;
    }
    tinfl_init(inflator);

    Untar untar;
    untar_init(&untar, dest_dir);

    // Single streaming loop (validated on host against real `tar -czf` builds).
    // NOTE: do NOT gate the loop on TINFL_FLAG_HAS_MORE_INPUT — once input drains
    // while that flag is set, tinfl returns NEEDS_MORE_INPUT with zero progress
    // and the loop spins forever. Drive it off `avail_in`/`eof` only.
    size_t window_pos = 0;
    const unsigned char* next_in = inbuf;
    size_t avail_in = 0;
    bool eof = false;
    bool ok = true;
    uint32_t crc = 0;        // running CRC-32 of the decompressed output
    uint32_t total_out = 0;  // uncompressed byte count (mod 2^32 == gzip ISIZE)
    unsigned char tail[8];   // rolling last-8-bytes of the file == the gzip trailer
    size_t tail_len = 0;
    for (;;) {
        feed_watchdog();
        if (avail_in == 0 && !eof) {
            size_t in_n = fread(inbuf, 1, kChunk, in);
            // A read error also returns 0. Distinguish it from real EOF: treating
            // an I/O glitch as a short stream classifies it corrupt below, which
            // makes the policy blacklist a perfectly good build forever.
            if (in_n == 0 && ferror(in)) {
                *err = "read staged build (i/o error)";
                *kind = MIK_BUILD_ERR_TRANSIENT;
                ok = false;
                break;
            }
            next_in = inbuf;
            avail_in = in_n;
            tail8_push(tail, &tail_len, inbuf, in_n);  // remember the file's last 8 bytes
            if (in_n == 0) eof = true;
        }
        size_t in_used = avail_in;
        size_t out_used = TINFL_LZ_DICT_SIZE - window_pos;
        int flags = eof ? 0 : TINFL_FLAG_HAS_MORE_INPUT;
        tinfl_status st = tinfl_decompress(inflator, next_in, &in_used, window,
                                           window + window_pos, &out_used, flags);
        next_in += in_used;
        avail_in -= in_used;
        if (out_used) {
            untar_feed(&untar, window + window_pos, out_used);
            if (untar.failed) {
                *err = untar.err;
                *kind = untar.kind;
                ok = false;
                break;
            }
            crc = crc32_update(crc, window + window_pos, out_used);
            total_out += (uint32_t)out_used;
        }
        window_pos = (window_pos + out_used) & (TINFL_LZ_DICT_SIZE - 1);
        if (st == TINFL_STATUS_DONE) break;
        if (st < TINFL_STATUS_DONE) {
            *err = "inflate error";
            *kind = MIK_BUILD_ERR_CORRUPT;
            ok = false;
            break;
        }
        if (st == TINFL_STATUS_NEEDS_MORE_INPUT && eof) {
            *err = "truncated gzip";
            *kind = MIK_BUILD_ERR_CORRUPT;
            ok = false;
            break;
        }
    }

    // tinfl stops at the end of the DEFLATE stream, so the 8-byte trailer may be
    // sitting unread in the file. Drain whatever's left through the same rolling
    // tail so `tail` holds the file's true final 8 bytes.
    if (ok) {
        unsigned char drain[64];
        size_t dn;
        while ((dn = fread(drain, 1, sizeof(drain), in)) > 0) {
            tail8_push(tail, &tail_len, drain, dn);
        }
    }

    // Verify the gzip trailer from `tail` (the file's last 8 bytes) rather than
    // from tinfl's leftover input: the esp32c6 ROM tinfl mis-accounts its input
    // consumption at end-of-stream (it draws the trailer into its bit-buffer
    // lookahead and reports it consumed), so the post-DONE buffer is unreliable
    // and a valid build would wrongly read as "missing trailer". `crc`/
    // `total_out` come from the decoded output, so they're independent of that.
    if (ok) {
        if (tail_len < 8) {
            *err = "gzip: missing trailer (truncated)";
            *kind = MIK_BUILD_ERR_CORRUPT;
            ok = false;
        } else {
            uint32_t want_crc = (uint32_t)tail[0] | ((uint32_t)tail[1] << 8) |
                                ((uint32_t)tail[2] << 16) | ((uint32_t)tail[3] << 24);
            uint32_t want_size = (uint32_t)tail[4] | ((uint32_t)tail[5] << 8) |
                                 ((uint32_t)tail[6] << 16) | ((uint32_t)tail[7] << 24);
            if (crc != want_crc) {
                *err = "gzip: crc mismatch (corrupt build)";
                *kind = MIK_BUILD_ERR_CORRUPT;
                ok = false;
            } else if (total_out != want_size) {
                *err = "gzip: size mismatch (corrupt build)";
                *kind = MIK_BUILD_ERR_CORRUPT;
                ok = false;
            }
        }
    }

    if (ok && !untar_finish(&untar, err)) {
        *kind = untar.kind;
        ok = false;
    }
    // untar_finish is skipped on the failure path above, and it is the only
    // other owner of `cur`. Without this an aborted unpack (inflate error, crc
    // mismatch, truncation) strands an open littlefs handle -- on a tree
    // install_build is about to rmtree -- once per attempt, and nothing ever
    // reclaims it. No-op when untar_finish already closed it.
    untar_close(&untar);

    free(inflator);
    free(window);
    free(inbuf);
    fclose(in);
    return ok;
}

/* `stat` succeeds for any node, so a guard that means "a directory is here"
 * has to say so: an archive carrying a regular file named `app` would
 * otherwise be accepted as an unpacked build. */
bool dir_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

// Uncompressed size from the gzip ISIZE trailer (last 4 bytes), or -1 when it
// can't be read. Only a hint for the free-space precheck: it is attacker-
// influenced and mod 2^32, so nothing may trust it -- the real check is the
// crc/size verification against the decoded output in unpack_tgz.
long gzip_isize(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return -1;
    unsigned char t[4];
    long got = -1;
    if (fseek(f, -4, SEEK_END) == 0 && fread(t, 1, 4, f) == 4) {
        uint32_t v = (uint32_t)t[0] | ((uint32_t)t[1] << 8) | ((uint32_t)t[2] << 16) |
                     ((uint32_t)t[3] << 24);
        if (v <= LONG_MAX) got = (long)v;
    }
    fclose(f);
    return got;
}

// Deepest tree rmtree will descend into. kMaxNameDepth caps what untar will
// create, so this is only reachable through state an older firmware left
// behind. The bound matters because rmtree runs from boot reconcile: a stack
// overflow there reboots into the same call and never reaches the install
// budget, so the device would never recover. Past the bound the tree stays on
// disk and fails the next install instead.
constexpr int kMaxRmDepth = 32;

// `path` is a mutable buffer of `cap` bytes; each level appends into it and
// truncates on the way out, so a frame costs a few dozen bytes rather than a
// 512-byte path of its own.
void rmtree_at(char* path, size_t cap, int depth) {
    DIR* d = opendir(path);
    if (!d) {
        unlink(path);
        return;
    }
    const size_t base = strlen(path);
    dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        if (!strcmp(ent->d_name, ".") || !strcmp(ent->d_name, "..")) continue;
        feed_watchdog();
        const int n = snprintf(path + base, cap - base, "/%s", ent->d_name);
        if (n < 0 || (size_t)n >= cap - base) {
            path[base] = 0;  // would truncate to a different path; skip it
            continue;
        }
        struct stat st;
        if (!stat(path, &st) && S_ISDIR(st.st_mode)) {
            if (depth < kMaxRmDepth) rmtree_at(path, cap, depth + 1);
        } else {
            unlink(path);
        }
        path[base] = 0;
    }
    closedir(d);
    rmdir(path);
}

void rmtree(const char* path) {
    char buf[512];
    const size_t n = strlen(path);
    if (n >= sizeof(buf)) return;
    memcpy(buf, path, n + 1);
    rmtree_at(buf, sizeof(buf), 0);
}

}  // namespace

bool mik__sha256_file(const char* path, char out[65]) {
    return sha256_file(path, out);
}

bool mik__unpack_tgz(const char* tgz, const char* dest_dir, const char** err, MIKBuildErr* kind) {
    return unpack_tgz(tgz, dest_dir, err, kind);
}

// ── install (gunzip -> untar -> atomic swap) ─────────────────────────────────
// Unpacks `tgz` into <base>/.deploy-tmp/app and promotes it to /app via the
// shared app-store engine (crash-safe: an interrupted swap is rolled back by
// MIK_DeployRecover at the next boot). Reusing the deploy staging dir means
// MIK_DeployRecover also cleans up an unpack interrupted by a brownout.
bool mik__install_build(const char* fs_base, const char* tgz, const char** err,
                        MIKBuildErr* kind) {
    char deploy_tmp[256];
    char deploy_old[256];
    // A truncated path would name another directory for rmtree to delete.
    if (strlen(fs_base) + sizeof("/.deploy-tmp") > sizeof(deploy_tmp)) {
        *err = "app filesystem path too long";
        *kind = MIK_BUILD_ERR_TRANSIENT;
        return false;
    }
    snprintf(deploy_tmp, sizeof(deploy_tmp), "%s/.deploy-tmp", fs_base);
    snprintf(deploy_old, sizeof(deploy_old), "%s/.deploy-old", fs_base);
    rmtree(deploy_tmp);
    rmtree(deploy_old);
    // Reject an oversized build up front instead of failing partway through the
    // unpack and burning an install attempt. Prefer the gzip ISIZE trailer (the
    // unpacked tar size) over the compressed size, which understates the real
    // requirement several-fold and lets through builds that cannot fit.
    long need = gzip_isize(tgz);
    if (need < 0) need = mik__file_size(tgz);
    long total = 0;
    long free_bytes = 0;
    if (need > 0 && mik__fs_space(&total, &free_bytes) && free_bytes < need) {
        *err = "not enough free space to install build";
        *kind = MIK_BUILD_ERR_TRANSIENT;
        return false;
    }
    if (mkdir(deploy_tmp, 0755) != 0 && errno != EEXIST) {
        *err = "mkdir stage";
        *kind = MIK_BUILD_ERR_TRANSIENT;
        return false;
    }
    if (!unpack_tgz(tgz, deploy_tmp, err, kind)) {
        rmtree(deploy_tmp);
        return false;
    }
    // mik__app_commit reports OK when nothing was staged -- correct for the
    // serial deploy path, but here it would turn an archive with no `app/`
    // member into a silent no-op that still promotes and records the checksum
    // as installed, so the device never retries. A build that unpacks to
    // nothing is a bad build.
    char staged_app[512];
    snprintf(staged_app, sizeof(staged_app), "%s/app", deploy_tmp);
    if (!dir_exists(staged_app)) {
        *err = "build archive contains no app/ directory";
        *kind = MIK_BUILD_ERR_CORRUPT;
        rmtree(deploy_tmp);
        return false;
    }
    MIKAppCommitResult r = mik__app_commit(fs_base, false);
    if (r != MIK_APP_COMMIT_OK) {
        *err = r == MIK_APP_COMMIT_STASH_FAILED ? "stash old app failed" : "swap new app failed";
        *kind = MIK_BUILD_ERR_TRANSIENT;
        rmtree(deploy_tmp);
        return false;
    }
    return true;
}

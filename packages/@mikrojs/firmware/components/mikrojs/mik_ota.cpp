// Native OTA install module for Mikro.js firmware.
//
// Registers `native:mikro/ota`, the privileged half of over-the-air updates the
// JS layer can't do: /app is read-only from JS and there is no gunzip/untar in
// the runtime, but C in firmware has a writable FS, miniz, and plain file I/O.
//
// The surface (consumed by the JS helper that owns the OTA protocol):
//   stageBegin(checksum, size)               stage a download, resume if partial
//   stageWrite(bytes)                         append to the staged .tgz
//   stageFinish(trialBoots, requireConfirm, installNow)  verify + arm install
//   stageAbort()                              drop the in-progress staging file
//   markValid()                               confirm the running trial (promote)
//   revert()                                  roll back to the last-good build
//   running()                                 { checksum?, trial }
//   reconcile()                               outcome of the boot-time reconcile
//
// The actual install (gunzip -> untar -> atomic swap) runs at boot on a clean
// heap from mik__ota_boot_reconcile(), which also drives the trial/rollback
// state machine. The unpack functions (gunzip + untar + SHA-256) are pure and
// host-tested under MIK_OTA_HOST_TEST (see test/ota_host/); everything that
// needs ESP-IDF / QuickJS / NVS is excluded from that build.

#ifndef MIK_OTA_HOST_TEST
#include <esp_app_desc.h>
#include <esp_system.h>
#include <nvs.h>
#include <nvs_flash.h>

#include "mikrojs/app_store.h"
#include "mikrojs/mikrojs.h"
#include "mikrojs/ota_env.h"
#include "mikrojs/platform.h"
#include "mikrojs_esp32.h"
#include "quickjs.h"
#endif

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

// tinfl comes from miniz, whose implementation is in the chip mask ROM and whose
// header the always-available `esp_rom` dependency provides, so no REQUIRES entry
// is needed. IDF versions differ on where the header sits: a target that lacks
// ROM miniz needs the `miniz` managed component in idf_component.yml.
#include "miniz.h"

namespace {

constexpr size_t kChunk = 4096;
constexpr size_t kTarBlock = 512;
constexpr size_t kTarName = 100;  // ustar name field width
constexpr int kMaxNameDepth = 8;  // path components a member may create

// Classified failure cause carried back to JS. `corrupt` means the bytes are
// deterministically bad (gzip/tar/SHA) so retrying identical bytes can't help;
// `transient` is fs/mount/io; `oom` is an allocation failure.
enum class OtaErr { kCorrupt, kTransient, kOom };

const char* err_kind(OtaErr k) {
    switch (k) {
        case OtaErr::kCorrupt:
            return "corrupt";
        case OtaErr::kOom:
            return "oom";
        case OtaErr::kTransient:
        default:
            return "transient";
    }
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
    while ((n = fread(buf, 1, kChunk, f)) > 0) sha256_update(&c, buf, n);
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
// no intermediate `.tar` ever lands on the 1 MB filesystem. Members are expected
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
    OtaErr kind;        // kCorrupt for a malformed archive, kTransient for I/O
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
    u->kind = OtaErr::kCorrupt;
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
            u->kind = OtaErr::kCorrupt;
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
            u->kind = OtaErr::kCorrupt;
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
                u->kind = OtaErr::kTransient;
                return;
            }
            u->remaining = size;
            if (size == 0) {  // no data blocks follow
                if (fclose(u->cur) != 0) {
                    u->failed = true;
                    u->err = "close extracted file";
                    u->kind = OtaErr::kTransient;
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
            u->kind = OtaErr::kTransient;
            return;
        }
        u->remaining -= (long)want;  // trailing bytes of this block are padding
        if (u->remaining <= 0) {
            // littlefs surfaces ENOSPC at close, not at write, so an unchecked
            // fclose here would promote a silently truncated app file.
            if (fclose(u->cur) != 0) {
                u->failed = true;
                u->err = "close extracted file";
                u->kind = OtaErr::kTransient;
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
            u->kind = OtaErr::kTransient;
        } else if (!u->failed) {
            u->err = "build archive ended mid-file (truncated)";
            u->kind = OtaErr::kCorrupt;
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
bool unpack_tgz(const char* in_path, const char* dest_dir, const char** err, OtaErr* kind) {
    *kind = OtaErr::kTransient;
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
        *kind = OtaErr::kCorrupt;
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
        *kind = OtaErr::kCorrupt;
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
        *kind = OtaErr::kOom;
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
        if (avail_in == 0 && !eof) {
            size_t in_n = fread(inbuf, 1, kChunk, in);
            // A read error also returns 0. Distinguish it from real EOF: treating
            // an I/O glitch as a short stream classifies it kCorrupt below, which
            // makes the policy blacklist a perfectly good build forever.
            if (in_n == 0 && ferror(in)) {
                *err = "read staged build (i/o error)";
                *kind = OtaErr::kTransient;
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
            *kind = OtaErr::kCorrupt;
            ok = false;
            break;
        }
        if (st == TINFL_STATUS_NEEDS_MORE_INPUT && eof) {
            *err = "truncated gzip";
            *kind = OtaErr::kCorrupt;
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
            *kind = OtaErr::kCorrupt;
            ok = false;
        } else {
            uint32_t want_crc = (uint32_t)tail[0] | ((uint32_t)tail[1] << 8) |
                                ((uint32_t)tail[2] << 16) | ((uint32_t)tail[3] << 24);
            uint32_t want_size = (uint32_t)tail[4] | ((uint32_t)tail[5] << 8) |
                                 ((uint32_t)tail[6] << 16) | ((uint32_t)tail[7] << 24);
            if (crc != want_crc) {
                *err = "gzip: crc mismatch (corrupt build)";
                *kind = OtaErr::kCorrupt;
                ok = false;
            } else if (total_out != want_size) {
                *err = "gzip: size mismatch (corrupt build)";
                *kind = OtaErr::kCorrupt;
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

}  // namespace

#ifndef MIK_OTA_HOST_TEST

namespace {

// ── On-disk layout (raw VFS; LittleFS is mounted at /appfs) ──────────────────
constexpr const char* kFsBase = "/appfs";
constexpr const char* kStaging = "/appfs/.ota-staging.tgz";    // in-progress download sink
constexpr const char* kPending = "/appfs/.ota-pending.tgz";    // verified, awaiting install
constexpr const char* kLastGood = "/appfs/.ota-last-good.tgz"; // revert target
constexpr const char* kLastGoodTmp = "/appfs/.ota-last-good.tmp"; // adopt: install source
// Reuse the deploy staging dir so MIK_DeployRecover() (which runs at boot before
// our reconcile) cleans up an OTA unpack interrupted by a brownout, exactly as
// it does for an interrupted serial deploy. mik__app_commit expects the new app
// at <base>/.deploy-tmp/app.
constexpr const char* kDeployTmp = "/appfs/.deploy-tmp";
constexpr const char* kDeployOld = "/appfs/.deploy-old";

// NVS namespace + keys. Keys are kept <= 15 chars (the NVS limit).
constexpr const char* kNs = "mik.ota";
constexpr const char* kKeyState = "state";        // u8: 0 GOOD, 1 TRIAL
constexpr const char* kKeyTrialLeft = "trialLeft"; // u8
constexpr const char* kKeyTrialN = "trialN";      // u8: trial budget for a pending install
constexpr const char* kKeyConfirm = "confirm";    // u8: trial requires markValid() to promote
constexpr const char* kKeyPending = "pending";    // u8: 1 = .ota-pending.tgz awaits clean-heap install
constexpr const char* kKeyPendMode = "pendMode";  // u8: how to install the pending build (see below)
constexpr const char* kKeyInstLeft = "instLeft";  // u8: install-attempt budget
constexpr const char* kKeyPromLeft = "promLeft";  // u8: promote-attempt budget
constexpr const char* kKeyRbLeft = "rbLeft";      // u8: rollback-attempt budget
constexpr const char* kKeyNeutLeft = "neutLeft";  // u8: brownout boots a trial may absorb
constexpr const char* kKeyInstChk = "instChk";    // str: running good (last-good) checksum
constexpr const char* kKeyPendChk = "pendChk";    // str: pending/trial checksum
constexpr const char* kKeyStgChk = "stgChk";      // str: in-progress staging expected checksum
constexpr const char* kKeyStgSize = "stgSize";    // u32: expected staged size
constexpr const char* kKeyFwHash = "fwHash";      // str: firmware elf sha256 (reflash guard)
constexpr const char* kKeyTrialBad = "trialBad";  // u8: trial app hit a fatal JS error this boot
constexpr const char* kKeyBadDetail = "badDetail"; // str: that error, for the revert diagnostic
// Boot-reconcile outcome, read once by reconcile() and then cleared.
constexpr const char* kKeyOInst = "oInst";        // str: checksum just installed
constexpr const char* kKeyORevert = "oRevert";    // u8
constexpr const char* kKeyORsn = "oRsn";          // str: diagnostic reason
constexpr const char* kKeyODetail = "oDetail";    // str: diagnostic detail
// Adopt-install outcome, read once by MIK_CMD_DEPLOY_RESULT and then cleared.
// Separate from the reconcile record above: that one reaches the registry as
// `lastInstall` and would blacklist a checksum the developer is re-pushing.
constexpr const char* kKeyDRes = "dRes";          // u8: 1 ok, 2 fail
constexpr const char* kKeyDChk = "dChk";          // str: staged checksum
constexpr const char* kKeyDRsn = "dRsn";          // str: failure reason
constexpr const char* kKeyDDetail = "dDetail";    // str: failure detail

constexpr uint8_t kStateGood = 0;
constexpr uint8_t kStateTrial = 1;
// kKeyPendMode values. Trial is the OTA path (trialBoots, rollback, abandon
// policy); adopt is the cable-deploy path (straight to GOOD, no trial, no
// rollback baseline, one install attempt). Absent defaults to trial so a
// pending build staged by older firmware keeps its semantics.
constexpr uint8_t kPendModeTrial = 0;
constexpr uint8_t kPendModeAdopt = 1;
constexpr uint8_t kInstallBudget = 3;  // boot install attempts before abandoning a pending build
// Boot attempts to make a survived trial the revert target before giving up on
// the revert target rather than on the device: a trial that cannot promote and
// never resolves leaves applyOffer skipping every future offer, so the device
// stops being updatable at all and only a reflash recovers it.
constexpr uint8_t kPromoteBudget = 3;
// Boot attempts to install the revert target before keeping the trial build
// instead. install_build can panic rather than return, so an unbudgeted rollback
// that crashes mid-install re-enters itself every boot forever.
constexpr uint8_t kRollbackBudget = 3;
// Brownout boots a trial absorbs before they start counting as ordinary boots.
// A brownout is ambiguous (bad supply, or the new build drawing more than the
// board can deliver), so don't convict on the first one -- but don't absorb them
// forever either: applyOffer skips every offer while a trial is unresolved, so a
// trial held open indefinitely shuts the one channel that could ship a fix.
constexpr uint8_t kNeutralBudget = 3;

// ── small fs helpers ─────────────────────────────────────────────────────────
bool path_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0;
}

/* `stat` succeeds for any node, so a guard that means "a directory is here"
 * has to say so: an archive carrying a regular file named `app` would
 * otherwise be accepted as an unpacked build. */
bool dir_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

long file_size(const char* path) {
    struct stat st;
    if (stat(path, &st) != 0) return -1;
    return (long)st.st_size;
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

// Capacity and free bytes of the app filesystem. False when the platform can't
// report them (no littlefs build); callers then skip their size check rather
// than block an install on a missing measurement.
bool fs_space(long* total, long* free_bytes) {
    const MIKPlatform* p = MIK_GetPlatform();
    size_t t = 0;
    size_t u = 0;
    if (!p || !p->get_fs_info || !p->get_fs_info("user", &t, &u)) return false;
    *total = (long)t;
    *free_bytes = t > u ? (long)(t - u) : 0;
    return true;
}

// Make the pending build the new revert target. The old last-good is only
// dropped once the replacement is in hand: unlinking first and then failing the
// rename (ENOSPC on littlefs metadata, or kPending lost to a power cut) would
// leave a GOOD state whose instChk names a build with no .tgz on disk, so a
// later revert() would have nothing to reinstall.
bool promote_pending(void) {
    if (!path_exists(kPending)) return false;
    // rename replaces an existing destination atomically (lfs_rename removes it
    // as part of the same commit), so kLastGood must NOT be unlinked first: a
    // failed rename after the unlink would leave a GOOD state whose instChk
    // names a build with no .tgz on disk, and a later revert() would have
    // nothing to reinstall.
    return rename(kPending, kLastGood) == 0;
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

// ── NVS helpers ──────────────────────────────────────────────────────────────
uint8_t nvs_u8(nvs_handle_t h, const char* key, uint8_t def) {
    uint8_t v = def;
    if (nvs_get_u8(h, key, &v) != ESP_OK) v = def;
    return v;
}

uint32_t nvs_u32(nvs_handle_t h, const char* key, uint32_t def) {
    uint32_t v = def;
    if (nvs_get_u32(h, key, &v) != ESP_OK) v = def;
    return v;
}

// Read a string key into `buf`. Returns true and a non-empty string on success.
bool nvs_str(nvs_handle_t h, const char* key, char* buf, size_t cap) {
    size_t len = cap;
    if (nvs_get_str(h, key, buf, &len) != ESP_OK || len == 0) {
        buf[0] = 0;
        return false;
    }
    return buf[0] != 0;
}

// ── install (gunzip -> untar -> atomic swap) ─────────────────────────────────
// Unpacks `tgz` into <base>/.deploy-tmp/app and promotes it to /app via the
// shared app-store engine (crash-safe: an interrupted swap is rolled back by
// MIK_DeployRecover at the next boot).
bool install_build(const char* tgz, const char** err, OtaErr* kind) {
    rmtree(kDeployTmp);
    rmtree(kDeployOld);
    // Reject an oversized build up front instead of failing partway through the
    // unpack and burning an install attempt. Prefer the gzip ISIZE trailer (the
    // unpacked tar size) over the compressed size, which understates the real
    // requirement several-fold and lets through builds that cannot fit.
    long need = gzip_isize(tgz);
    if (need < 0) need = file_size(tgz);
    long total = 0;
    long free_bytes = 0;
    if (need > 0 && fs_space(&total, &free_bytes) && free_bytes < need) {
        *err = "not enough free space to install build";
        *kind = OtaErr::kTransient;
        return false;
    }
    if (mkdir(kDeployTmp, 0755) != 0 && errno != EEXIST) {
        *err = "mkdir stage";
        *kind = OtaErr::kTransient;
        return false;
    }
    if (!unpack_tgz(tgz, kDeployTmp, err, kind)) {
        rmtree(kDeployTmp);
        return false;
    }
    // mik__app_commit reports OK when nothing was staged -- correct for the
    // serial deploy path, but here it would turn an archive with no `app/`
    // member into a silent no-op that still promotes and records the checksum
    // as installed, so the device never retries. A build that unpacks to
    // nothing is a bad build.
    char staged_app[512];
    snprintf(staged_app, sizeof(staged_app), "%s/app", kDeployTmp);
    if (!dir_exists(staged_app)) {
        *err = "build archive contains no app/ directory";
        *kind = OtaErr::kCorrupt;
        rmtree(kDeployTmp);
        return false;
    }
    MIKAppCommitResult r = mik__app_commit(kFsBase, false);
    if (r != MIK_APP_COMMIT_OK) {
        *err = r == MIK_APP_COMMIT_STASH_FAILED ? "stash old app failed" : "swap new app failed";
        *kind = OtaErr::kTransient;
        rmtree(kDeployTmp);
        return false;
    }
    return true;
}

// Drop the trial crash flag and its diagnostic. Must run wherever the state
// machine leaves a trial or arms a new one: the flag outliving the build that
// set it makes the *next* trial roll back on its first reboot, blamed with the
// previous build's error string.
void clear_trial_failure(nvs_handle_t h) {
    nvs_erase_key(h, kKeyTrialBad);
    nvs_erase_key(h, kKeyBadDetail);
}

// Record a boot/promote diagnostic for the next reconcile() call to report.
void record_diag(nvs_handle_t h, const char* reason, const char* detail) {
    nvs_set_str(h, kKeyORsn, reason);
    if (detail && detail[0]) nvs_set_str(h, kKeyODetail, detail);
}

// ── staging write cache ──────────────────────────────────────────────────────
// stageBegin fills these, stageWrite appends without reopening, and
// stageFinish/stageAbort flush them. Without the cache every 4 KB chunk cost an
// nvs_open + stat + fopen/fclose (~50 flash metadata commits for a 200 KB
// build). Safe as plain statics because staging writes and the boot reconcile
// never overlap: both run on the single main task.
FILE* g_stage_file = nullptr;
uint32_t g_stage_cap = 0;  // declared size from stageBegin; 0 = uncapped
long g_stage_have = 0;     // bytes in the staging file

// Flush and close the staging file. False if the close failed, which on
// littlefs is where a full disk surfaces.
bool stage_close(void) {
    if (!g_stage_file) return true;
    bool ok = fclose(g_stage_file) == 0;
    g_stage_file = nullptr;
    return ok;
}

// ── JS result-object builders ────────────────────────────────────────────────
JSValue ok_obj(JSContext* ctx) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "ok", JS_TRUE);
    return o;
}

JSValue err_obj(JSContext* ctx, const char* msg) {
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "ok", JS_FALSE);
    JS_SetPropertyStr(ctx, o, "error", JS_NewString(ctx, msg));
    return o;
}

JSValue err_obj_kind(JSContext* ctx, const char* msg, OtaErr kind) {
    JSValue o = err_obj(ctx, msg);
    JS_SetPropertyStr(ctx, o, "kind", JS_NewString(ctx, err_kind(kind)));
    return o;
}

// ── JS bindings ──────────────────────────────────────────────────────────────

// sha256_file emits lowercase hex and the comparison in stageFinish is strcmp,
// so anything else can never match. Rejecting it here matters because the
// mismatch would otherwise surface as kCorrupt, which the policy layer treats
// as "these bytes can never succeed" and abandons the checksum permanently: an
// uppercase digest from a registry would blacklist a perfectly good build.
bool valid_checksum(const char* s) {
    size_t i = 0;
    for (; s[i]; i++) {
        if (i >= 64) return false;
        const char c = s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return i == 64;
}

// ── Staging cores ────────────────────────────────────────────────────────────
// The install machinery, with no JSContext in sight. Two callers sit on top: the
// native:mikro/ota JS bindings below, and the MIKOtaEnv install ops the native
// OTA client drives (mik__ota_fill_install_ops). One implementation, so the two
// can never drift on something as unforgiving as install safety.

struct CoreErr {
    const char* msg = nullptr;
    OtaErr kind = OtaErr::kTransient;
};

bool core_fail(CoreErr* e, const char* msg, OtaErr kind = OtaErr::kTransient) {
    if (e) {
        e->msg = msg;
        e->kind = kind;
    }
    return false;
}

bool core_stage_begin(const char* checksum, int64_t size, int64_t* out_resume, CoreErr* e) {
    if (!checksum) return core_fail(e, "checksum not a string");
    if (!valid_checksum(checksum)) {
        // kTransient, not the default: the build is fine, the offer is
        // malformed, so this must not count against the build's retry budget.
        return core_fail(e, "checksum must be 64 lowercase hex characters", OtaErr::kTransient);
    }
    if (size <= 0) return core_fail(e, "invalid size");
    // Reject an impossible size while it is still int64: stgSize is u32, so a
    // bogus offer above 4 GB would otherwise truncate into a small cap.
    long fs_total = 0;
    long fs_free = 0;
    if (fs_space(&fs_total, &fs_free) && size > fs_total) {
        return core_fail(e, "offered build is larger than the filesystem");
    }

    stage_close();  // flush any prior staging file before stat/unlink below

    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return core_fail(e, "nvs open failed");

    // Resume only if the in-progress staging file is for the same checksum+size
    // and hasn't already grown past the declared size.
    char prev[96];
    uint32_t prev_size = nvs_u32(h, kKeyStgSize, 0);
    long have = file_size(kStaging);
    int64_t resume = 0;
    if (nvs_str(h, kKeyStgChk, prev, sizeof(prev)) && strcmp(prev, checksum) == 0 &&
        prev_size == (uint32_t)size && have >= 0 && have <= size) {
        resume = have;
    } else {
        unlink(kStaging);  // different target — start fresh
        nvs_set_str(h, kKeyStgChk, checksum);
        nvs_set_u32(h, kKeyStgSize, (uint32_t)size);
        nvs_commit(h);
    }
    nvs_close(h);

    g_stage_cap = (uint32_t)size;
    g_stage_have = resume;
    if (out_resume) *out_resume = resume;
    return true;
}

bool core_stage_write(const uint8_t* data, size_t len, CoreErr* e) {
    if (!data) return core_fail(e, "bytes not a Uint8Array");
    if (len == 0) return true;

    // Enforce the size cap from stageBegin so a runaway download can't fill flash.
    if (g_stage_cap > 0 && (uint64_t)g_stage_have + len > g_stage_cap) {
        return core_fail(e, "staged write exceeds declared size", OtaErr::kTransient);
    }

    if (!g_stage_file) {
        g_stage_file = fopen(kStaging, "ab");
        if (!g_stage_file) return core_fail(e, "open staging file", OtaErr::kTransient);
    }
    size_t wrote = fwrite(data, 1, len, g_stage_file);
    if (wrote != len) {
        // A short write still leaves `wrote` bytes on disk. Close first so the
        // stream flushes, then resync from the file itself: an understated
        // g_stage_have desyncs the resume offset from the real file, and the
        // duplicated/skipped bytes surface later as a checksum mismatch, which
        // is classified kCorrupt and blacklists the checksum forever. A full
        // filesystem must stay transient.
        stage_close();
        long actual = file_size(kStaging);
        g_stage_have = actual < 0 ? g_stage_have + (long)wrote : actual;
        return core_fail(e, "write staging file (disk full?)", OtaErr::kTransient);
    }
    g_stage_have += (long)len;
    return true;
}

bool core_stage_finish(int64_t trial_boots, bool require_confirm, bool install_now, CoreErr* e) {
    if (trial_boots < 0) trial_boots = 0;
    // A confirm-gated trial needs at least one boot to run in. Boot reconcile
    // evaluates the trial before the app loads, so trialBoots:0 with confirm set
    // reverts at the next boot without the new build ever having had the chance
    // to call markValid() -- every such update would revert, deterministically.
    if (require_confirm && trial_boots < 1) trial_boots = 1;
    if (trial_boots > 255) trial_boots = 255;

    if (!stage_close()) {
        return core_fail(e, "write staging file (disk full?)", OtaErr::kTransient);
    }

    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        return core_fail(e, "nvs open failed", OtaErr::kTransient);
    }
    char want_chk[96];
    bool has_chk = nvs_str(h, kKeyStgChk, want_chk, sizeof(want_chk));
    uint32_t want_size = nvs_u32(h, kKeyStgSize, 0);

    if (!has_chk) {
        nvs_close(h);
        return core_fail(e, "no staged build", OtaErr::kTransient);
    }
    long have = file_size(kStaging);
    if (have < 0) {
        nvs_close(h);
        return core_fail(e, "staging file missing", OtaErr::kTransient);
    }
    if ((uint32_t)have != want_size) {
        nvs_close(h);
        return core_fail(e, "staged size mismatch", OtaErr::kCorrupt);
    }
    char got_chk[65];
    if (!sha256_file(kStaging, got_chk)) {
        nvs_close(h);
        return core_fail(e, "read staging file", OtaErr::kTransient);
    }
    if (strcmp(got_chk, want_chk) != 0) {
        nvs_close(h);
        return core_fail(e, "checksum mismatch (corrupt download)", OtaErr::kCorrupt);
    }

    // Verified. Promote the staging file to the pending build.
    unlink(kPending);
    if (rename(kStaging, kPending) != 0) {
        nvs_close(h);
        return core_fail(e, "stage pending build", OtaErr::kTransient);
    }
    g_stage_cap = 0;
    g_stage_have = 0;
    nvs_erase_key(h, kKeyStgChk);
    nvs_erase_key(h, kKeyStgSize);
    nvs_set_str(h, kKeyPendChk, want_chk);
    // Explicit even though trial is the default: a leftover adopt marker from
    // an earlier cable deploy must not turn this OTA build into an adopt.
    nvs_set_u8(h, kKeyPendMode, kPendModeTrial);
    nvs_set_u8(h, kKeyTrialN, (uint8_t)trial_boots);
    nvs_set_u8(h, kKeyConfirm, require_confirm ? 1 : 0);

    if (install_now) {
        const char* err = nullptr;
        OtaErr kind = OtaErr::kTransient;
        if (!install_build(kPending, &err, &kind)) {
            // The verified .tgz is already on flash. Leaving it with pending=0
            // would strand it there forever and let the next stageBegin build a
            // second staging file beside it.
            if (kind == OtaErr::kCorrupt) {
                nvs_set_u8(h, kKeyPending, 0);  // identical bytes can't succeed
                unlink(kPending);
            } else {
                nvs_set_u8(h, kKeyPending, 1);  // boot reconcile retries it
                nvs_set_u8(h, kKeyInstLeft, kInstallBudget);
            }
            nvs_commit(h);
            nvs_close(h);
            return core_fail(e, err, kind);
        }
        // New app is live but unproven: enter the trial. The caller restarts.
        nvs_set_u8(h, kKeyState, kStateTrial);
        nvs_set_u8(h, kKeyTrialLeft, (uint8_t)trial_boots);
        nvs_set_u8(h, kKeyPending, 0);
        nvs_erase_key(h, kKeyPromLeft);   // per-trial budgets
        nvs_erase_key(h, kKeyRbLeft);
        nvs_erase_key(h, kKeyNeutLeft);
        clear_trial_failure(h);  // fresh trial: this build has not failed yet
        nvs_commit(h);
        nvs_close(h);
        return true;
    }

    // Defer: install at the next boot on a clean heap.
    nvs_set_u8(h, kKeyPending, 1);
    nvs_set_u8(h, kKeyInstLeft, kInstallBudget);
    nvs_commit(h);
    nvs_close(h);
    return true;
}

void core_stage_abort(void) {
    stage_close();
    g_stage_cap = 0;
    g_stage_have = 0;
    unlink(kStaging);
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, kKeyStgChk);
        nvs_erase_key(h, kKeyStgSize);
        nvs_commit(h);
        nvs_close(h);
    }
}

// Confirm the running trial: promote it to GOOD and make the pending build the
// new revert target.
void core_mark_valid(void) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    if (nvs_u8(h, kKeyState, kStateGood) == kStateTrial) {
        // Stay in the trial if the promotion failed: going GOOD anyway would
        // point instChk at a build that has no .tgz left to revert to.
        if (promote_pending()) {
            char chk[96];
            if (nvs_str(h, kKeyPendChk, chk, sizeof(chk))) nvs_set_str(h, kKeyInstChk, chk);
            nvs_set_u8(h, kKeyState, kStateGood);
            nvs_set_u8(h, kKeyTrialLeft, 0);
            nvs_set_u8(h, kKeyPending, 0);
            nvs_erase_key(h, kKeyPromLeft);
            clear_trial_failure(h);
        } else {
            record_diag(h, "promote-failed", "could not make the trial build the revert target");
        }
        nvs_commit(h);
    }
    nvs_close(h);
}

bool core_revert(CoreErr* e) {
    if (!path_exists(kLastGood)) return core_fail(e, "no last-good build to revert to");
    const char* err = nullptr;
    OtaErr kind = OtaErr::kTransient;
    if (!install_build(kLastGood, &err, &kind)) return core_fail(e, err, kind);
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, kKeyState, kStateGood);
        nvs_set_u8(h, kKeyTrialLeft, 0);
        nvs_set_u8(h, kKeyPending, 0);
        clear_trial_failure(h);
        unlink(kPending);
        nvs_commit(h);
        nvs_close(h);
    }
    return true;
}

void core_running(char* chk, size_t chk_len, bool* out_trial) {
    bool trial = false;
    if (chk && chk_len) chk[0] = '\0';
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) == ESP_OK) {
        trial = nvs_u8(h, kKeyState, kStateGood) == kStateTrial;
        if (chk && chk_len) nvs_str(h, trial ? kKeyPendChk : kKeyInstChk, chk, chk_len);
        nvs_close(h);
    }
    if (out_trial) *out_trial = trial;
}

// Read the outcome the boot-time reconcile recorded, then clear it so a second
// call reads empty.
void core_reconcile(char* installed, size_t installed_len, bool* out_reverted, char* reason,
                    size_t reason_len, char* detail, size_t detail_len) {
    if (installed && installed_len) installed[0] = '\0';
    if (reason && reason_len) reason[0] = '\0';
    if (detail && detail_len) detail[0] = '\0';
    bool reverted = false;

    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) == ESP_OK) {
        reverted = nvs_u8(h, kKeyORevert, 0) != 0;
        if (installed && installed_len) nvs_str(h, kKeyOInst, installed, installed_len);
        if (reason && reason_len) nvs_str(h, kKeyORsn, reason, reason_len);
        if (detail && detail_len) nvs_str(h, kKeyODetail, detail, detail_len);
        nvs_erase_key(h, kKeyOInst);
        nvs_erase_key(h, kKeyORevert);
        nvs_erase_key(h, kKeyORsn);
        nvs_erase_key(h, kKeyODetail);
        nvs_commit(h);
        nvs_close(h);
    }
    if (out_reverted) *out_reverted = reverted;
}

// ── JS bindings ──────────────────────────────────────────────────────────────
// Argument coercion and result shaping only; the work is in the cores above.

JSValue core_err_obj(JSContext* ctx, const CoreErr& e) {
    return err_obj_kind(ctx, e.msg ? e.msg : "ota error", e.kind);
}

// stageBegin(checksum, size) -> { ok, resumeOffset } | { ok:false, error }
JSValue js_stage_begin(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2) return err_obj(ctx, "missing checksum/size");
    const char* checksum = JS_ToCString(ctx, argv[0]);
    if (!checksum) {
        // JS_ToCString throws on a value with a throwing toString. Clear it
        // rather than strand it on the context for some unrelated later
        // operation to surface, the same way the size path below does.
        JS_FreeValue(ctx, JS_GetException(ctx));
        return err_obj(ctx, "checksum not a string");
    }
    int64_t size = 0;
    if (JS_ToInt64(ctx, &size, argv[1])) {
        JS_FreeCString(ctx, checksum);
        // JS_ToInt64 throws on a value with a throwing valueOf. We report through
        // the result object, so clear it rather than strand it on the context.
        JS_FreeValue(ctx, JS_GetException(ctx));
        return err_obj(ctx, "invalid size");
    }

    CoreErr e;
    int64_t resume = 0;
    bool ok = core_stage_begin(checksum, size, &resume, &e);
    JS_FreeCString(ctx, checksum);
    if (!ok) return core_err_obj(ctx, e);

    JSValue o = ok_obj(ctx);
    JS_SetPropertyStr(ctx, o, "resumeOffset", JS_NewInt64(ctx, resume));
    return o;
}

// stageWrite(bytes) -> { ok } | { ok:false, error, kind? }
JSValue js_stage_write(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return err_obj(ctx, "missing bytes");
    size_t len = 0;
    const uint8_t* data = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!data) {
        JS_FreeValue(ctx, JS_GetException(ctx));  // JS_GetUint8Array throws; we report via err_obj
        return err_obj(ctx, "bytes not a Uint8Array");
    }
    CoreErr e;
    if (!core_stage_write(data, len, &e)) return core_err_obj(ctx, e);
    return ok_obj(ctx);
}

// stageFinish(trialBoots, requireConfirm, installNow)
//   -> { ok } | { ok:false, error, kind }
// Verifies SHA-256 + size over the whole staged file, then either installs in
// place now (installNow) or marks a verified build staged-for-install so the
// next boot's reconcile installs it on a clean heap.
JSValue js_stage_finish(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    int64_t trial_boots = 1;
    if (argc >= 1 && JS_ToInt64(ctx, &trial_boots, argv[0])) {
        // A throwing valueOf leaves trial_boots indeterminate and an exception
        // pending; we report through the result object, so clear it and default.
        JS_FreeValue(ctx, JS_GetException(ctx));
        trial_boots = 1;
    }
    bool require_confirm = argc >= 2 && JS_ToBool(ctx, argv[1]);
    bool install_now = argc >= 3 && JS_ToBool(ctx, argv[2]);

    CoreErr e;
    if (!core_stage_finish(trial_boots, require_confirm, install_now, &e)) {
        return core_err_obj(ctx, e);
    }
    return ok_obj(ctx);
}

// stageAbort() -> void
JSValue js_stage_abort(JSContext*, JSValueConst, int, JSValueConst*) {
    core_stage_abort();
    return JS_UNDEFINED;
}

// markValid() -> void
JSValue js_mark_valid(JSContext*, JSValueConst, int, JSValueConst*) {
    core_mark_valid();
    return JS_UNDEFINED;
}

// revert() -> { ok } | { ok:false, error }. Re-install the last-good build.
JSValue js_revert(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    CoreErr e;
    // Historically reported without a kind, and the policy maps every revert
    // failure to transient anyway.
    if (!core_revert(&e)) return err_obj(ctx, e.msg ? e.msg : "revert failed");
    return ok_obj(ctx);
}

// running() -> { checksum?, trial }
JSValue js_running(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue o = JS_NewObject(ctx);
    char chk[96] = {0};
    bool trial = false;
    core_running(chk, sizeof(chk), &trial);
    if (chk[0]) JS_SetPropertyStr(ctx, o, "checksum", JS_NewString(ctx, chk));
    JS_SetPropertyStr(ctx, o, "trial", JS_NewBool(ctx, trial));
    return o;
}

// reconcile() -> { installed?, reverted, diagnostic? }
JSValue js_reconcile(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue o = JS_NewObject(ctx);
    char installed[96] = {0};
    char reason[96] = {0};
    char detail[160] = {0};
    bool reverted = false;
    core_reconcile(installed, sizeof(installed), &reverted, reason, sizeof(reason), detail,
                   sizeof(detail));

    if (installed[0]) JS_SetPropertyStr(ctx, o, "installed", JS_NewString(ctx, installed));
    JS_SetPropertyStr(ctx, o, "reverted", JS_NewBool(ctx, reverted));
    if (reason[0]) {
        JSValue diag = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, diag, "reason", JS_NewString(ctx, reason));
        if (detail[0]) JS_SetPropertyStr(ctx, diag, "detail", JS_NewString(ctx, detail));
        JS_SetPropertyStr(ctx, o, "diagnostic", diag);
    }
    return o;
}

// ── MIKOtaEnv install ops ────────────────────────────────────────────────────
// The native OTA client reaches the staging machinery through these. They are
// the same cores the JS bindings above call, so nothing can drift between the
// two implementations while both are in the tree.

namespace {

int env_err_kind(OtaErr kind) {
    switch (kind) {
        case OtaErr::kCorrupt:
            return MIK_OTA_ERR_CORRUPT;
        case OtaErr::kOom:
            return MIK_OTA_ERR_OOM;
        case OtaErr::kTransient:
            break;
    }
    return MIK_OTA_ERR_TRANSIENT;
}

void env_copy_err(const CoreErr& e, char* err_buf, size_t err_len) {
    if (err_buf && err_len) snprintf(err_buf, err_len, "%s", e.msg ? e.msg : "ota error");
}

bool env_stage_begin(void*, const char* checksum, size_t size, size_t* out_resume, char* err_buf,
                     size_t err_len) {
    CoreErr e;
    int64_t resume = 0;
    if (!core_stage_begin(checksum, (int64_t)size, &resume, &e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    if (out_resume) *out_resume = (size_t)resume;
    return true;
}

bool env_stage_write(void*, const uint8_t* data, size_t len, char* err_buf, size_t err_len) {
    CoreErr e;
    if (!core_stage_write(data, len, &e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    return true;
}

bool env_stage_finish(void*, int trial_boots, bool require_confirm, bool install_now, char* err_buf,
                      size_t err_len, int* out_err_kind) {
    CoreErr e;
    if (!core_stage_finish(trial_boots, require_confirm, install_now, &e)) {
        env_copy_err(e, err_buf, err_len);
        if (out_err_kind) *out_err_kind = env_err_kind(e.kind);
        return false;
    }
    return true;
}

void env_stage_abort(void*) { core_stage_abort(); }
void env_mark_valid(void*) { core_mark_valid(); }

bool env_revert(void*, char* err_buf, size_t err_len) {
    CoreErr e;
    if (!core_revert(&e)) {
        env_copy_err(e, err_buf, err_len);
        return false;
    }
    return true;
}

bool env_running(void*, MIKOtaRunningBuild* out) {
    if (!out) return false;
    *out = {};
    char chk[96] = {0};
    bool trial = false;
    core_running(chk, sizeof(chk), &trial);
    // The checksum field is a 64-hex digest plus its terminator; a longer value
    // could only come from corrupted NVS, and truncating it is what the JS path
    // effectively did too.
    snprintf(out->checksum, sizeof(out->checksum), "%s", chk);
    out->trial = trial;
    // version is left empty on purpose: the policy fills it from the app's
    // package.json through read_app_version.
    return true;
}

void env_reconcile(void*, MIKOtaReconcileOutcome* out) {
    if (!out) return;
    *out = {};
    char installed[96] = {0};
    char reason[96] = {0};
    char detail[160] = {0};
    bool reverted = false;
    core_reconcile(installed, sizeof(installed), &reverted, reason, sizeof(reason), detail,
                   sizeof(detail));
    snprintf(out->installed, sizeof(out->installed), "%s", installed);
    out->reverted = reverted;
    if (reason[0]) {
        out->has_diagnostic = true;
        snprintf(out->diagnostic.reason, sizeof(out->diagnostic.reason), "%s", reason);
        snprintf(out->diagnostic.detail, sizeof(out->diagnostic.detail), "%s", detail);
    }
}

}  // namespace

// ── module registration ──────────────────────────────────────────────────────
int mik__ota_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "stageBegin",
                       JS_NewCFunction(ctx, js_stage_begin, "stageBegin", 2));
    JS_SetModuleExport(ctx, m, "stageWrite",
                       JS_NewCFunction(ctx, js_stage_write, "stageWrite", 1));
    JS_SetModuleExport(ctx, m, "stageFinish",
                       JS_NewCFunction(ctx, js_stage_finish, "stageFinish", 3));
    JS_SetModuleExport(ctx, m, "stageAbort",
                       JS_NewCFunction(ctx, js_stage_abort, "stageAbort", 0));
    JS_SetModuleExport(ctx, m, "markValid", JS_NewCFunction(ctx, js_mark_valid, "markValid", 0));
    JS_SetModuleExport(ctx, m, "revert", JS_NewCFunction(ctx, js_revert, "revert", 0));
    JS_SetModuleExport(ctx, m, "running", JS_NewCFunction(ctx, js_running, "running", 0));
    JS_SetModuleExport(ctx, m, "reconcile", JS_NewCFunction(ctx, js_reconcile, "reconcile", 0));
    return 0;
}

JSModuleDef* mik__ota_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/ota", mik__ota_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "stageBegin");
    JS_AddModuleExport(ctx, m, "stageWrite");
    JS_AddModuleExport(ctx, m, "stageFinish");
    JS_AddModuleExport(ctx, m, "stageAbort");
    JS_AddModuleExport(ctx, m, "markValid");
    JS_AddModuleExport(ctx, m, "revert");
    JS_AddModuleExport(ctx, m, "running");
    JS_AddModuleExport(ctx, m, "reconcile");
    return m;
}

// ── boot-time reconcile (trial state machine) ────────────────────────────────

// Map a reset reason to a trial verdict.
enum class TrialVerdict { kCrash, kNeutral, kClean };

TrialVerdict classify_reset(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_PANIC:
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT:
            return TrialVerdict::kCrash;
        case ESP_RST_BROWNOUT:
            // Ambiguous: a bad supply, or the new build drawing more than the
            // board can deliver. Absorbed a bounded number of times (kNeutralBudget).
            return TrialVerdict::kNeutral;
        default:  // ESP_RST_POWERON, ESP_RST_SW, ESP_RST_DEEPSLEEP, ESP_RST_EXT, ...
            // A cold start is an ordinary boot: nothing went wrong, and the app
            // is about to get its chance to run and confirm. Counting it as
            // neutral would let a mains device that only ever power-cycles sit
            // in an unresolved trial forever.
            return TrialVerdict::kClean;
    }
}

const char* reset_reason_name(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_PANIC:
            return "panic";
        case ESP_RST_INT_WDT:
            return "interrupt-watchdog";
        case ESP_RST_TASK_WDT:
            return "task-watchdog";
        case ESP_RST_WDT:
            return "watchdog";
        default:
            return "crash";
    }
}

// Record the just-installed checksum so reconcile() can report it after the
// post-install restart.
void record_installed(nvs_handle_t h, const char* chk) {
    nvs_set_str(h, kKeyOInst, chk);
}

void record_revert(nvs_handle_t h, const char* reason, const char* detail) {
    nvs_set_u8(h, kKeyORevert, 1);
    record_diag(h, reason, detail);
}

// The trial build is still what /app holds, so make instChk name it. Leaving
// instChk on the previous build would make running() report a checksum the
// device is not running: the registry would never re-offer the build that is
// actually live, and revert() would install the older build over the newer one.
void keep_trial_as_installed(nvs_handle_t h) {
    char chk[96];
    if (nvs_str(h, kKeyPendChk, chk, sizeof(chk))) nvs_set_str(h, kKeyInstChk, chk);
}

// Install the revert target, ending the trial. Both trial-failure paths funnel
// here so the attempt budget is charged identically.
//
// The budget is charged and committed BEFORE the install, for the reason the
// deferred-install path documents: install_build does not only return false, it
// can panic (a littlefs assert, the task watchdog, an allocation the OOM handler
// turns into a restart). Charging on the return paths alone means a rollback
// that crashes mid-install leaves NVS untouched, so the next boot re-enters the
// identical rollback and the budget is never reached -- a loop only a reflash
// escapes, and one every device that took the bad build enters together.
//
// Returns false if the last-good build is not live, in which case the caller
// keeps the trial build and must carry pendChk across.
bool attempt_rollback(nvs_handle_t h, const char* reason, const char* detail) {
    if (!path_exists(kLastGood)) {
        record_revert(h, reason, "no rollback build available");
        return false;
    }
    uint8_t left = nvs_u8(h, kKeyRbLeft, kRollbackBudget);
    if (left == 0) {
        record_revert(h, reason, "rollback install failed repeatedly; keeping this build");
        return false;
    }
    nvs_set_u8(h, kKeyRbLeft, (uint8_t)(left - 1));
    nvs_commit(h);

    const char* err = nullptr;
    OtaErr kind = OtaErr::kTransient;
    if (!install_build(kLastGood, &err, &kind)) {
        record_revert(h, reason, "rollback install failed");
        return false;
    }
    nvs_erase_key(h, kKeyRbLeft);
    record_revert(h, reason, detail);
    return true;
}

// Resolve a failed adopt install: drop the pending build, record the outcome
// for MIK_CMD_DEPLOY_RESULT, and leave the previous /app running. No rollback
// and no retry -- the developer is on the serial cable and re-pushes. Never
// touches the reconcile record (oRsn/oDetail), which reaches the registry.
void adopt_fail(nvs_handle_t h, const char* chk, const char* reason, const char* detail) {
    nvs_set_u8(h, kKeyPending, 0);
    nvs_erase_key(h, kKeyPendChk);
    nvs_erase_key(h, kKeyPendMode);
    nvs_erase_key(h, kKeyInstLeft);
    unlink(kPending);
    nvs_set_u8(h, kKeyDRes, 2);
    nvs_set_str(h, kKeyDChk, chk);
    nvs_set_str(h, kKeyDRsn, reason);
    nvs_set_str(h, kKeyDDetail, detail);
    nvs_commit(h);
}

}  // namespace

void mik__ota_fill_install_ops(MIKOtaEnv* env) {
    if (!env) return;
    env->stage_begin = env_stage_begin;
    env->stage_write = env_stage_write;
    env->stage_finish = env_stage_finish;
    env->stage_abort = env_stage_abort;
    env->mark_valid = env_mark_valid;
    env->revert = env_revert;
    env->running = env_running;
    env->reconcile = env_reconcile;
}

// Stage a streamed .tgz for adopt install at the next boot (the cable-deploy
// path, distinct from an OTA download which runs a trial). The install itself
// runs from mik__ota_boot_reconcile() on a clean heap: doing it here, with the
// app live, needs a 32 KB contiguous inflate window a fragmented heap cannot
// provide. Verification stays synchronous so a corrupt upload still fails over
// serial; empty checksum skips the check. NOT JS-exposed — called from the
// serial DEPLOY_BUILD handler.
bool mik__ota_stage_adopt(const char* tgz_path, const char* checksum, const char** err) {
    if (!path_exists(tgz_path)) {
        *err = "build not staged";
        return false;
    }
    if (checksum && checksum[0]) {
        char got[65];
        if (!sha256_file(tgz_path, got)) {
            *err = "read staged build";
            return false;
        }
        if (strcmp(got, checksum) != 0) {
            *err = "checksum mismatch (corrupt build)";
            return false;
        }
    }
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        *err = "nvs open failed";
        return false;
    }
    // Move the .tgz out of the deploy tmp tree before acking: MIK_DeployRecover
    // cleans that tree at boot, before the reconcile would read it. Rename
    // before anything else mutates: a failed rename (e.g. littlefs metadata
    // ENOSPC) must error back over serial having left trial state untouched.
    unlink(kPending);
    if (rename(tgz_path, kPending) != 0) {
        nvs_close(h);
        *err = "stage pending build";
        return false;
    }
    // A cable deploy supersedes an in-flight trial. Resolve it to GOOD now,
    // while the trial's checksum is still in pendChk (overwritten below): the
    // trial build is what /app holds, so it becomes the installed build, the
    // same accounting the reflash guard does. Without this, the next boot's
    // trial verdict would roll back or promote against the pending slot this
    // deploy just replaced.
    if (nvs_u8(h, kKeyState, kStateGood) == kStateTrial) {
        char trial_chk[96];
        if (nvs_str(h, kKeyPendChk, trial_chk, sizeof(trial_chk))) {
            nvs_set_str(h, kKeyInstChk, trial_chk);
        }
        nvs_set_u8(h, kKeyState, kStateGood);
        nvs_set_u8(h, kKeyTrialLeft, 0);
        nvs_erase_key(h, kKeyPromLeft);
        nvs_erase_key(h, kKeyRbLeft);
        nvs_erase_key(h, kKeyNeutLeft);
        clear_trial_failure(h);
    }
    nvs_set_str(h, kKeyPendChk, checksum ? checksum : "");
    nvs_set_u8(h, kKeyPendMode, kPendModeAdopt);
    nvs_set_u8(h, kKeyPending, 1);
    nvs_set_u8(h, kKeyInstLeft, 1);  // one attempt: the developer is on the cable
    // Drop any unread outcome from an earlier adopt (e.g. a --no-restart deploy
    // that installed at a natural boot), so the post-restart result read can
    // only ever see this deploy's outcome.
    nvs_erase_key(h, kKeyDRes);
    nvs_erase_key(h, kKeyDChk);
    nvs_erase_key(h, kKeyDRsn);
    nvs_erase_key(h, kKeyDDetail);
    nvs_commit(h);
    nvs_close(h);
    return true;
}

// Read and clear the adopt-install outcome for MIK_CMD_DEPLOY_RESULT.
void mik__ota_take_deploy_result(MIKDeployResult* out) {
    memset(out, 0, sizeof(*out));
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    out->status = nvs_u8(h, kKeyDRes, 0);
    nvs_str(h, kKeyDChk, out->checksum, sizeof(out->checksum));
    nvs_str(h, kKeyDRsn, out->reason, sizeof(out->reason));
    nvs_str(h, kKeyDDetail, out->detail, sizeof(out->detail));
    if (out->status != 0) {
        nvs_erase_key(h, kKeyDRes);
        nvs_erase_key(h, kKeyDChk);
        nvs_erase_key(h, kKeyDRsn);
        nvs_erase_key(h, kKeyDDetail);
        nvs_commit(h);
    }
    nvs_close(h);
}

// True while an unconfirmed OTA trial is the running build.
bool mik__ota_in_trial(void) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READONLY, &h) != ESP_OK) return false;
    bool trial = nvs_u8(h, kKeyState, kStateGood) == kStateTrial;
    nvs_close(h);
    return trial;
}

// Flag the running trial as failed after a fatal JS error, so the next reconcile
// reverts it even though the reboot will look like a clean software reset. No-op
// outside a trial; the first detail recorded wins.
void mik__ota_note_trial_failure(const char* detail) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;
    if (nvs_u8(h, kKeyState, kStateGood) == kStateTrial && nvs_u8(h, kKeyTrialBad, 0) == 0) {
        nvs_set_u8(h, kKeyTrialBad, 1);
        if (detail && detail[0]) nvs_set_str(h, kKeyBadDetail, detail);
        nvs_commit(h);
    }
    nvs_close(h);
}

// Boot reconcile: NOT JS-exposed. Called from MIK_Main() before the JS app
// loads, after MIK_DeployRecover(). Runs the reflash guard, an adopt install
// (cable deploy), the trial verdict, and a deferred trial install in that
// order.
void mik__ota_boot_reconcile(void) {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) return;

    // Legacy leftover: firmware that installed cable deploys synchronously
    // staged its install source here and could die before promoting it. Never
    // valid across a boot, and a whole build's worth of flash.
    unlink(kLastGoodTmp);

    // 1. Reflash guard. An out-of-band `idf.py flash` swaps the firmware without
    //    touching OTA state; a stale pending/staged build must not then revert
    //    or overwrite the freshly-flashed /app. Detect via the running app's ELF
    //    SHA-256 and scrub OTA install state when it changed.
    const esp_app_desc_t* desc = esp_app_get_description();
    char fw_now[65];
    static const char* H = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        fw_now[i * 2] = H[desc->app_elf_sha256[i] >> 4];
        fw_now[i * 2 + 1] = H[desc->app_elf_sha256[i] & 0xf];
    }
    fw_now[64] = 0;
    char fw_stored[65];
    bool have_fw = nvs_str(h, kKeyFwHash, fw_stored, sizeof(fw_stored));
    if (!have_fw || strcmp(fw_stored, fw_now) != 0) {
        // A firmware flash leaves /appfs alone, so if a trial was in flight the
        // trial build is what /app still holds. Forcing GOOD without moving
        // pendChk across would leave instChk naming the previous build: the
        // device would report the wrong checksum to the registry forever, and
        // revert() would install that older build over the newer live one.
        if (nvs_u8(h, kKeyState, kStateGood) == kStateTrial) {
            char pend_chk[96];
            if (nvs_str(h, kKeyPendChk, pend_chk, sizeof(pend_chk))) {
                nvs_set_str(h, kKeyInstChk, pend_chk);
            }
        }
        nvs_erase_key(h, kKeyPendChk);
        nvs_erase_key(h, kKeyPendMode);
        nvs_set_u8(h, kKeyState, kStateGood);
        nvs_set_u8(h, kKeyTrialLeft, 0);
        nvs_set_u8(h, kKeyPending, 0);
        unlink(kPending);
        unlink(kStaging);
        nvs_erase_key(h, kKeyStgChk);
        nvs_erase_key(h, kKeyStgSize);
        nvs_set_str(h, kKeyFwHash, fw_now);
        nvs_commit(h);
    }

    // 2. Adopt install: a cable deploy staged by MIK_CMD_DEPLOY_BUILD. No
    //    trial, no rollback baseline, one attempt (charged before the attempt,
    //    same crash reasoning as the deferred install below). Runs before the
    //    trial verdict as a backstop: stage_adopt resolves an in-flight trial
    //    at stage time, but stale trial state must never roll back or promote
    //    against the pending slot the deploy overwrote.
    if (nvs_u8(h, kKeyPending, 0) == 1 &&
        nvs_u8(h, kKeyPendMode, kPendModeTrial) == kPendModeAdopt) {
        char chk[96] = {0};
        nvs_str(h, kKeyPendChk, chk, sizeof(chk));
        if (!path_exists(kPending)) {
            adopt_fail(h, chk, "install-failed", "staged build missing");
            nvs_close(h);
            return;
        }
        uint8_t left = nvs_u8(h, kKeyInstLeft, 1);
        if (left == 0) {
            // The charged attempt never came back: the install panicked.
            adopt_fail(h, chk, "install-failed", "install did not complete (device restarted)");
            nvs_close(h);
            return;
        }
        nvs_set_u8(h, kKeyInstLeft, (uint8_t)(left - 1));
        nvs_commit(h);

        const char* err = nullptr;
        OtaErr kind = OtaErr::kTransient;
        if (!install_build(kPending, &err, &kind)) {
            adopt_fail(h, chk, kind == OtaErr::kCorrupt ? "install-corrupt" : "install-failed",
                       err != nullptr ? err : "install failed");
            nvs_close(h);
            return;
        }
        // Installed. A cable deploy resets the OTA safety story like a reflash
        // does: nothing to roll back to until the next OTA trial promotes.
        unlink(kPending);
        unlink(kLastGood);
        nvs_set_str(h, kKeyInstChk, chk);
        nvs_set_u8(h, kKeyState, kStateGood);
        nvs_set_u8(h, kKeyTrialLeft, 0);
        nvs_set_u8(h, kKeyPending, 0);
        nvs_erase_key(h, kKeyPendChk);
        nvs_erase_key(h, kKeyPendMode);
        nvs_erase_key(h, kKeyInstLeft);
        nvs_erase_key(h, kKeyPromLeft);
        nvs_erase_key(h, kKeyRbLeft);
        nvs_erase_key(h, kKeyNeutLeft);
        clear_trial_failure(h);
        nvs_set_u8(h, kKeyDRes, 1);
        nvs_set_str(h, kKeyDChk, chk);
        nvs_erase_key(h, kKeyDRsn);
        nvs_erase_key(h, kKeyDDetail);
        nvs_commit(h);
        nvs_close(h);
        esp_restart();  // boot into the deployed app on a clean heap
        return;
    }

    // 3. Trial verdict. Evaluate why we just reset while a trial was in flight.
    if (nvs_u8(h, kKeyState, kStateGood) == kStateTrial) {
        esp_reset_reason_t reason = esp_reset_reason();
        TrialVerdict verdict = classify_reset(reason);
        // A fatal JS error the trial app flagged in-process (a top-level throw or
        // an unhandled rejection) reboots as a clean software reset, which would
        // otherwise be read as "survived". Treat it like a crash.
        bool js_failed = nvs_u8(h, kKeyTrialBad, 0) != 0;
        if (js_failed || verdict == TrialVerdict::kCrash) {
            // The new app failed: roll back to last-good immediately, bypassing
            // the counter. If no rollback build exists (first-ever OTA), we
            // can't reinstall — stop the trial loop and record the diagnostic so
            // the app can surface it (the deploy app remains serial-recoverable).
            char detail[160];
            const char* rsn;
            const char* why;
            if (js_failed) {
                rsn = "startup-crash";
                if (!nvs_str(h, kKeyBadDetail, detail, sizeof(detail))) {
                    snprintf(detail, sizeof(detail), "trial app threw at startup");
                }
                why = detail;
            } else {
                rsn = reset_reason_name(reason);
                why = "reverted to last-good build";
            }
            if (!attempt_rollback(h, rsn, why)) keep_trial_as_installed(h);
            nvs_set_u8(h, kKeyState, kStateGood);
            nvs_set_u8(h, kKeyTrialLeft, 0);
            nvs_set_u8(h, kKeyPending, 0);
            nvs_erase_key(h, kKeyPendChk);
            nvs_erase_key(h, kKeyTrialBad);
            nvs_erase_key(h, kKeyBadDetail);
            unlink(kPending);
            nvs_commit(h);
            nvs_close(h);
            return;
        }
        if (verdict == TrialVerdict::kNeutral) {
            uint8_t left = nvs_u8(h, kKeyNeutLeft, kNeutralBudget);
            if (left > 0) {
                nvs_set_u8(h, kKeyNeutLeft, (uint8_t)(left - 1));
                nvs_commit(h);
            } else {
                // Budget spent: stop absorbing and let the trial progress on the
                // clean path, so it reaches a verdict instead of staying open.
                verdict = TrialVerdict::kClean;
            }
        }
        if (verdict == TrialVerdict::kClean) {
            uint8_t left = nvs_u8(h, kKeyTrialLeft, 0);
            bool confirm = nvs_u8(h, kKeyConfirm, 0) != 0;
            if (left == 0) {
                if (confirm) {
                    // Trial elapsed without an explicit markValid(): roll back.
                    if (!attempt_rollback(h, "unconfirmed",
                                          "trial elapsed without markValid()")) {
                        keep_trial_as_installed(h);
                    }
                    nvs_set_u8(h, kKeyState, kStateGood);
                    nvs_set_u8(h, kKeyPending, 0);
                    nvs_erase_key(h, kKeyPendChk);
                    unlink(kPending);
                } else if (promote_pending()) {
                    // Promote: the trial proved stable.
                    char chk[96];
                    if (nvs_str(h, kKeyPendChk, chk, sizeof(chk))) nvs_set_str(h, kKeyInstChk, chk);
                    nvs_set_u8(h, kKeyState, kStateGood);
                    nvs_erase_key(h, kKeyPromLeft);
                } else if (uint8_t prom = nvs_u8(h, kKeyPromLeft, kPromoteBudget); prom > 1) {
                    // Stay in the trial rather than go GOOD with no revert
                    // target; the next clean boot retries the promotion.
                    nvs_set_u8(h, kKeyPromLeft, (uint8_t)(prom - 1));
                    record_diag(h, "promote-failed",
                                "could not make the trial build the revert target");
                } else {
                    // Budget spent, so the failure is not transient (kPending
                    // lost, or a filesystem that will not take the rename).
                    // Resolve to GOOD with no revert target. That is the lesser
                    // loss: the build has survived its whole trial and is
                    // running, whereas staying in TRIAL makes applyOffer skip
                    // every future offer, so the one channel that could ship a
                    // fix is shut. The next update re-establishes a baseline.
                    char chk[96];
                    if (nvs_str(h, kKeyPendChk, chk, sizeof(chk))) nvs_set_str(h, kKeyInstChk, chk);
                    nvs_set_u8(h, kKeyState, kStateGood);
                    nvs_set_u8(h, kKeyPending, 0);
                    nvs_erase_key(h, kKeyPromLeft);
                    unlink(kPending);
                    record_diag(h, "promote-failed",
                                "gave up making the trial build the revert target; "
                                "this build is kept but cannot be rolled back");
                }
                nvs_commit(h);
            } else {
                nvs_set_u8(h, kKeyTrialLeft, (uint8_t)(left - 1));
                nvs_commit(h);
            }
        }
        // kNeutral: don't penalize — leave the trial untouched and proceed.
    }

    // 4. Deferred trial install. A build verified by stageFinish(installNow=
    //    false) is installed here, on a clean heap, then we restart into its
    //    trial. (An adopt-mode pending build never reaches this: step 2
    //    returns.)
    if (nvs_u8(h, kKeyPending, 0) == 1 && nvs_u8(h, kKeyState, kStateGood) == kStateGood) {
        if (!path_exists(kPending)) {
            nvs_set_u8(h, kKeyPending, 0);
            nvs_commit(h);
            nvs_close(h);
            return;
        }
        // Charge the attempt BEFORE making it, and commit, so the budget
        // survives a boot that never comes back. install_build does not only
        // return false: it can panic (a littlefs assert, the task watchdog, an
        // allocation the OOM handler turns into a restart). Decrementing on the
        // return paths alone means a build that crashes mid-install leaves NVS
        // untouched, so the next boot re-enters the identical install and the
        // budget is never reached — a fleet-wide loop only a reflash escapes.
        // Same reasoning rmtree's depth cap is documented with.
        uint8_t inst_left = nvs_u8(h, kKeyInstLeft, kInstallBudget);
        if (inst_left == 0) {
            nvs_set_u8(h, kKeyPending, 0);
            unlink(kPending);
            nvs_commit(h);
            nvs_close(h);
            return;
        }
        nvs_set_u8(h, kKeyInstLeft, (uint8_t)(inst_left - 1));
        nvs_commit(h);

        const char* err = nullptr;
        OtaErr kind = OtaErr::kTransient;
        if (install_build(kPending, &err, &kind)) {
            char chk[96] = {0};
            nvs_str(h, kKeyPendChk, chk, sizeof(chk));
            record_installed(h, chk);
            uint8_t trial_n = nvs_u8(h, kKeyTrialN, 1);
            nvs_set_u8(h, kKeyState, kStateTrial);
            nvs_set_u8(h, kKeyTrialLeft, trial_n);
            nvs_set_u8(h, kKeyPending, 0);
            nvs_erase_key(h, kKeyPromLeft);  // per-trial budgets
            nvs_erase_key(h, kKeyRbLeft);
            nvs_erase_key(h, kKeyNeutLeft);
            nvs_set_u8(h, kKeyTrialBad, 0);  // fresh trial: clear any prior crash flag
            nvs_erase_key(h, kKeyBadDetail);
            nvs_commit(h);
            nvs_close(h);
            esp_restart();  // boot into the freshly-installed app on a clean heap
            return;
        }
        // Recorded like every other failure, and for a reason this path needs
        // more than most: the diagnostic is what reaches the registry as
        // `lastInstall`, and that is what stops the same build being offered
        // again. Without it a build that verifies but will not unpack is
        // re-downloaded and rewritten to flash on every boot, forever, since
        // nothing on either side learns it failed. `install: 'next-boot'` is
        // the default, so this is the ordinary path, not a corner.
        record_diag(h, kind == OtaErr::kCorrupt ? "install-corrupt" : "install-failed",
                    err != nullptr ? err : "deferred install failed");
        // The attempt is already charged above; this only decides whether to
        // keep the build for another boot.
        if (kind == OtaErr::kCorrupt) {
            nvs_set_u8(h, kKeyPending, 0);  // identical bytes can't succeed — abandon
            unlink(kPending);
        } else if (inst_left <= 1) {
            nvs_set_u8(h, kKeyPending, 0);  // budget exhausted — abandon
            unlink(kPending);
        }
        nvs_commit(h);
    }
    nvs_close(h);
}

MIK_REGISTER_MODULE(ota, "native:mikro/ota", mik__ota_init, nullptr, nullptr)

#endif  // MIK_OTA_HOST_TEST

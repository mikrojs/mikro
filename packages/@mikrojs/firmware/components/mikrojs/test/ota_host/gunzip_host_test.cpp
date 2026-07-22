// Host regression test for the pure unpack path in ../../mik_ota.cpp:
// unpack_tgz() (streaming gunzip -> untar) and sha256_file().
//
// Two things this guards:
//
//  1. The esp32c6 ROM tinfl over-reads the gzip trailer. On the chip the tinfl
//     implementation comes from the mask ROM (an old miniz) which, at the end of
//     the deflate stream, draws the 8-byte gzip trailer into its bit-buffer
//     lookahead and reports it consumed. Code that recovers the trailer from
//     tinfl's *leftover input* then sees < 8 bytes and rejects a good build.
//     rom_tinfl_decompress() below models that behaviour; the real unpack_tgz
//     must still succeed because it reads the trailer from the file's last 8
//     bytes (a rolling tail). Revert to buffer-based trailer reading and this
//     fails.
//
//  2. Streaming gunzip -> untar must be byte-identical to the archive. We unpack
//     into a dir and run.sh diffs it against `tar -xzf`.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define MIK_OTA_HOST_TEST 1
#include "miniz.h"

// Non-zero after a run means the modelled over-read actually fired (so the test
// isn't passing vacuously).
static size_t g_rom_ate = 0;

static tinfl_status rom_tinfl_decompress(tinfl_decompressor* r, const mz_uint8* pin,
                                         size_t* pin_size, mz_uint8* pout_start,
                                         mz_uint8* pout_next, size_t* pout_size,
                                         const mz_uint32 flags) {
    size_t avail_before = *pin_size;
    tinfl_status st = tinfl_decompress(r, pin, pin_size, pout_start, pout_next, pout_size, flags);
    if (st == TINFL_STATUS_DONE) {
        size_t leftover = avail_before - *pin_size;  // unconsumed input still in buffer
        size_t eat = leftover < 4 ? leftover : 4;    // ROM swallows a few trailer bytes
        *pin_size += eat;
        g_rom_ate += eat;
    }
    return st;
}
// From here on, unpack_tgz()'s tinfl_decompress(...) call hits the shim.
#define tinfl_decompress rom_tinfl_decompress

#ifndef MIK_OTA_SRC
#define MIK_OTA_SRC "../../mik_ota.cpp"
#endif
#include MIK_OTA_SRC  // brings unpack_tgz/sha256_file into this TU

static int cmd_unpack(const char* build, const char* dest, bool expect_ok) {
    const char* err = "(none)";
    OtaErr kind = OtaErr::kTransient;
    bool ok = unpack_tgz(build, dest, &err, &kind);
    printf("unpack_tgz(%s) -> %s (err=%s kind=%s)  rom_shim_ate=%zu\n", build,
           ok ? "OK" : "FAIL", err, err_kind(kind), g_rom_ate);
    if (expect_ok) return ok ? 0 : 1;
    return ok ? 1 : 0;  // expect-fail: rejection is success
}

static int count_open_fds() {
    DIR* d = opendir("/dev/fd");
    if (!d) return -1;
    int n = 0;
    while (readdir(d)) n++;
    closedir(d);
    return n;
}

// Regression: a failed unpack must not strand the open member handle. Only
// untar_finish closes Untar::cur, and it is skipped when the unpack already
// failed — so without an unconditional close, every aborted attempt leaks one
// FILE. On device that is an lfs_file_t plus its caches on a ~200 KB heap,
// pointing into a tree install_build is about to rmtree. Needs a fixture that
// fails *mid-member*: the corrupt.tgz fixture dies before any file is opened.
static int cmd_leak(const char* build, const char* dest) {
    const char* err = "(none)";
    OtaErr kind = OtaErr::kTransient;
    if (unpack_tgz(build, dest, &err, &kind)) {
        printf("fixture unpacked cleanly — it must fail mid-member to test this\n");
        return 1;
    }
    int before = count_open_fds();
    for (int i = 0; i < 5; i++) unpack_tgz(build, dest, &err, &kind);
    int after = count_open_fds();
    printf("failed mid-member unpack (err=%s); open fds before=%d after=%d\n", err, before, after);
    if (before < 0 || after < 0) {
        printf("  (cannot enumerate /dev/fd on this host — check skipped)\n");
        return 0;
    }
    return after > before ? 1 : 0;
}

static int cmd_sha256(const char* file) {
    char hex[65];
    if (!sha256_file(file, hex)) {
        fprintf(stderr, "sha256_file: cannot read %s\n", file);
        return 1;
    }
    printf("%s\n", hex);
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 4 && strcmp(argv[1], "unpack") == 0) return cmd_unpack(argv[2], argv[3], true);
    if (argc >= 4 && strcmp(argv[1], "expect-fail") == 0) return cmd_unpack(argv[2], argv[3], false);
    if (argc >= 4 && strcmp(argv[1], "leak") == 0) return cmd_leak(argv[2], argv[3]);
    if (argc >= 3 && strcmp(argv[1], "sha256") == 0) return cmd_sha256(argv[2]);
    fprintf(stderr,
            "usage:\n"
            "  %s unpack <build.tgz> <destdir>\n"
            "  %s expect-fail <build.tgz> <destdir>\n"
            "  %s leak <build.tgz> <destdir>\n"
            "  %s sha256 <file>\n",
            argv[0], argv[0], argv[0], argv[0]);
    return 2;
}

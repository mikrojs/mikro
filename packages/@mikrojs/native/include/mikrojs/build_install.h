#pragma once

/* Build install (mik_build_install.cpp): unpack a build archive (a .tgz of
 * `app/`) and swap it in as the live app through the app-store engine. Pure
 * libc plus miniz's tinfl, which the ESP32 has in ROM; the host library has no
 * miniz, so it leaves this file out. */

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Why an install failed. `corrupt` means the bytes are deterministically bad
 * (gzip/tar/SHA) so retrying identical bytes can't help; `transient` is
 * fs/mount/io; `oom` is an allocation failure. */
typedef enum MIKBuildErr {
    MIK_BUILD_ERR_CORRUPT,
    MIK_BUILD_ERR_TRANSIENT,
    MIK_BUILD_ERR_OOM,
} MIKBuildErr;

/* SHA-256 of a whole file as 64 lowercase hex chars + NUL. False on I/O error. */
bool mik__sha256_file(const char* path, char out[65]);

/* Streaming gunzip -> untar of `tgz` into `dest_dir`, verifying the gzip
 * trailer. Allocates a 32 KB inflate window plus ~16 KB while it runs. */
bool mik__unpack_tgz(const char* tgz, const char* dest_dir, const char** err, MIKBuildErr* kind);

/* Unpack `tgz` into <fs_base>/.deploy-tmp/app and promote it to <fs_base>/app.
 * An interrupted swap is rolled back by MIK_DeployRecover at the next boot. */
bool mik__install_build(const char* fs_base, const char* tgz, const char** err, MIKBuildErr* kind);

#ifdef __cplusplus
}
#endif

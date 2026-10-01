#pragma once

/* Portable app-store engine: atomic promotion of a staged app into the live
 * slot, plus crash recovery. On-disk layout relative to a base path:
 *   <base>/app          live app
 *   <base>/.deploy-tmp  staging dir (new app built at <base>/.deploy-tmp/app)
 *   <base>/.deploy-old  rollback copy of the previous live app
 * POSIX only (rename/stat/dirent); no ESP-IDF, no QuickJS. */

#include <stddef.h>

enum MIKAppCommitResult {
    MIK_APP_COMMIT_OK = 0,
    MIK_APP_COMMIT_STASH_FAILED,  // rename <base>/app -> <base>/.deploy-old failed
    MIK_APP_COMMIT_SWAP_FAILED,   // rename <base>/.deploy-tmp/app -> <base>/app failed
};

/* Promote the staged app at <base>/.deploy-tmp/app into <base>/app. When
 * `erased` is true the live app was already removed, so no rollback copy is
 * stashed. On failure the caller is expected to clean up staging. */
MIKAppCommitResult mik__app_commit(const char* base, bool erased);

/* Recover from an interrupted commit: restore the rollback copy if the live
 * app is missing, otherwise drop leftover staging/rollback dirs. */
void mik__app_recover(const char* base);

/* Remove a directory tree. Returns true when nothing is left at `path` (also
 * when nothing was there). On failure errno is that of the first entry that
 * could not be removed. Descends at most 32 levels and feeds the watchdog. */
bool mik__rmdir_recursive(const char* path);

/* Create `path` and any missing parents. Returns true when `path` is a
 * directory afterwards. On failure errno is that of the first mkdir that
 * left no directory behind, so a full filesystem reads as ENOSPC here instead
 * of as ENOENT from a later open. */
bool mik__mkdirs(const char* path);

/* Join `base` with each of `count` suffixes in one malloc'd block and point
 * `*slots[i]` at the i-th path. Returns the block, which the caller frees, or
 * NULL when out of memory. */
char* mik__join_paths(const char* base, const char* const* suffixes, size_t count,
                      const char** const* slots);

/* Size of the file at `path` in bytes, or -1 when it cannot be read. */
long mik__file_size(const char* path);

/* Capacity and free bytes of the app filesystem. False when the platform can't
 * report them; callers then skip their size check rather than block an install
 * on a missing measurement. */
bool mik__fs_space(long* total, long* free_bytes);

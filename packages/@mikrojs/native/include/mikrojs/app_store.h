#pragma once

/* Portable app-store engine: atomic promotion of a staged app into the live
 * slot, plus crash recovery. On-disk layout relative to a base path:
 *   <base>/app          live app
 *   <base>/.deploy-tmp  staging dir (new app built at <base>/.deploy-tmp/app)
 *   <base>/.deploy-old  rollback copy of the previous live app
 * POSIX only (rename/stat/dirent); no ESP-IDF, no QuickJS. */

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

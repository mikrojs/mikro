#include "mikrojs/app_store.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

bool path_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0;
}

/* An app is a directory. `stat` succeeds for a regular file too, so a build
 * archive carrying a *file* named `app` would otherwise pass the staged-app
 * guard below: commit would stash the live app, move that file into the app
 * slot, and drop the stash, leaving the device with no app and no rollback. */
static bool dir_exists(const char* path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

/* Deepest tree this will descend into. Builds are 2-3 levels; the untar path
 * caps member depth well below this. The bound exists so a tree left by an
 * older firmware (or a hostile archive that predates the cap) cannot overflow
 * the main task stack here, because this runs from boot recovery: a panic
 * would reboot straight back into the same call and never reach the install
 * budget. Past the bound the tree is left on disk, which fails the next
 * install instead of bricking the device. */
constexpr int kMaxDepth = 32;

/* `path` is a mutable buffer of `cap` bytes holding the directory to remove;
 * each level appends into it and truncates on the way out, so a frame costs a
 * few dozen bytes rather than a 512-byte path of its own. */
void rmdir_recursive_at(char* path, size_t cap, int depth) {
    DIR* dir = opendir(path);
    if (!dir) return;

    const size_t base = strlen(path);
    struct dirent* entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;

        const int n = snprintf(path + base, cap - base, "/%s", entry->d_name);
        if (n < 0 || (size_t)n >= cap - base) {
            path[base] = 0;  /* would truncate to a different path; skip it */
            continue;
        }

        struct stat st;
        if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) {
            if (depth < kMaxDepth) rmdir_recursive_at(path, cap, depth + 1);
        } else {
            unlink(path);
        }
        path[base] = 0;
    }
    closedir(dir);
    rmdir(path);
}

void rmdir_recursive(const char* path) {
    char buf[512];
    const size_t n = strlen(path);
    if (n >= sizeof(buf)) return;
    memcpy(buf, path, n + 1);
    rmdir_recursive_at(buf, sizeof(buf), 0);
}

}  // namespace

MIKAppCommitResult mik__app_commit(const char* base, bool erased) {
    char app[512];
    char tmp[512];
    char old[512];
    char staged_app[512];
    snprintf(app, sizeof(app), "%s/app", base);
    snprintf(tmp, sizeof(tmp), "%s/.deploy-tmp", base);
    snprintf(old, sizeof(old), "%s/.deploy-old", base);
    snprintf(staged_app, sizeof(staged_app), "%s/app", tmp);

    /* No-staged guard (hardening over the original): if nothing was staged,
     * leave the live app untouched and just clean up. The original logic
     * would have deleted the live app in this degenerate case. */
    if (!dir_exists(staged_app)) {
        rmdir_recursive(old);
        rmdir_recursive(tmp);
        return MIK_APP_COMMIT_OK;
    }

    /* Atomic swap: staging dir → app dir */
    if (path_exists(app) && !erased) {
        rmdir_recursive(old);
        if (rename(app, old) != 0) {
            return MIK_APP_COMMIT_STASH_FAILED;
        }
    }

    if (rename(staged_app, app) != 0) {
        if (path_exists(old)) {
            rename(old, app);
        }
        return MIK_APP_COMMIT_SWAP_FAILED;
    }

    rmdir_recursive(old);
    rmdir_recursive(tmp);
    return MIK_APP_COMMIT_OK;
}

void mik__app_recover(const char* base) {
    char app[512];
    char tmp[512];
    char old[512];
    snprintf(app, sizeof(app), "%s/app", base);
    snprintf(tmp, sizeof(tmp), "%s/.deploy-tmp", base);
    snprintf(old, sizeof(old), "%s/.deploy-old", base);

    bool has_app = path_exists(app);
    bool has_old = path_exists(old);
    bool has_tmp = path_exists(tmp);

    if (!has_app && has_old) {
        rename(old, app);
    } else if (has_old) {
        rmdir_recursive(old);
    }

    if (has_tmp) {
        rmdir_recursive(tmp);
    }
}

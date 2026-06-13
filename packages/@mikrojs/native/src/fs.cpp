#include <cerrno>
#include <dirent.h>
#include <quickjs.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "mikrojs/errors.h"
#include "mikrojs/platform.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

static JSClassID mik_file_class_id;

typedef struct {
    FILE* file;
    JSValue path;
} MIKFileHandle;

/*
 * Resolve a user-provided path against the runtime's fs_base_path.
 * If a base path is configured, user paths are joined onto it (e.g. "/" -> "/appfs").
 * If no base path is set, the path is used as-is.
 * Writes the resolved path into `out` (max `out_size` bytes including NUL).
 */
/*
 * Normalize an absolute path in-place: resolve "." and ".." components,
 * collapse repeated slashes, and clamp ".." at the root (prevent traversal
 * above "/").  The input must start with "/".
 *
 * Examples:
 *   "/a/b/../c"   → "/a/c"
 *   "/a/../../x"  → "/x"       (clamped at root)
 *   "/./a/./b"    → "/a/b"
 *   "/../app"     → "/app"     (then blocked by /app check below)
 */
static void mik__normalize_path(char* path) {
    /* Stack of component start offsets within `path` */
    int offsets[64];
    int depth = 0;

    char* dst = path;
    const char* src = path;

    *dst++ = '/'; /* always starts with / */
    src++;        /* skip leading / */

    while (*src) {
        /* Skip duplicate slashes */
        if (*src == '/') {
            src++;
            continue;
        }

        /* "." component — skip */
        if (src[0] == '.' && (src[1] == '/' || src[1] == '\0')) {
            src += (src[1] == '/') ? 2 : 1;
            continue;
        }

        /* ".." component — pop one level (clamped at root) */
        if (src[0] == '.' && src[1] == '.' && (src[2] == '/' || src[2] == '\0')) {
            if (depth > 0) {
                depth--;
                dst = path + offsets[depth];
            } else {
                dst = path + 1; /* clamp at root */
            }
            src += (src[2] == '/') ? 3 : 2;
            continue;
        }

        /* Regular component — record its start offset and copy */
        if (depth < 64) {
            offsets[depth++] = (int)(dst - path);
        }
        if (dst != path + 1) {
            *dst++ = '/';
        }
        while (*src && *src != '/') {
            *dst++ = *src++;
        }
        if (*src == '/') src++;
    }

    /* Ensure at least "/" */
    if (dst == path + 1 && path[0] == '/') {
        /* path is just "/" */
    }
    *dst = '\0';
}

int mik__resolve_fs_root(JSContext* ctx, const char* path, char* out, size_t out_size) {
    /* Normalize the path to prevent traversal attacks (../) */
    char normalized[PATH_MAX];
    if (path[0] == '/') {
        snprintf(normalized, sizeof(normalized), "%s", path);
    } else {
        snprintf(normalized, sizeof(normalized), "/%s", path);
    }
    mik__normalize_path(normalized);

    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    /* Use fs_root if set, otherwise fall back to fs_base_path */
    const char* root = mik_rt ? (mik_rt->fs_root ? mik_rt->fs_root : mik_rt->fs_base_path) : NULL;
    if (!root) {
        snprintf(out, out_size, "%s", normalized);
        return 0;
    }
    if (normalized[0] == '/' && normalized[1] == '\0') {
        snprintf(out, out_size, "%s", root);
    } else {
        snprintf(out, out_size, "%s%s", root, normalized);
    }
    return 0;
}

/* Returns true if the normalized virtual path is under /app (read-only zone) */
static bool mik__is_readonly_path(const char* path) {
    char normalized[PATH_MAX];
    if (path[0] == '/') {
        snprintf(normalized, sizeof(normalized), "%s", path);
    } else {
        snprintf(normalized, sizeof(normalized), "/%s", path);
    }
    mik__normalize_path(normalized);
    return strncmp(normalized, "/app", 4) == 0 && (normalized[4] == '/' || normalized[4] == '\0');
}

/* Create directories recursively (like mkdir -p) */
static int mik__mkdir_recursive(const char* path, mode_t mode) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s", path);
    size_t len = strlen(tmp);

    /* Strip trailing slash */
    if (len > 0 && tmp[len - 1] == '/') {
        tmp[--len] = '\0';
    }

    for (char* p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, mode) != 0 && errno != EEXIST) {
                return -1;
            }
            *p = '/';
        }
    }
    if (mkdir(tmp, mode) != 0 && errno != EEXIST) {
        return -1;
    }
    return 0;
}

/* Calculate total bytes used by regular files under a directory (recursive) */
size_t mik__fs_dir_usage(const char* dir_path) {
    DIR* dir = opendir(dir_path);
    if (!dir) return 0;
    size_t total = 0;
    struct dirent* entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        char child[PATH_MAX];
        snprintf(child, sizeof(child), "%s/%s", dir_path, entry->d_name);
        struct stat st;
        if (stat(child, &st) == 0) {
            if (S_ISREG(st.st_mode)) {
                total += st.st_size;
            } else if (S_ISDIR(st.st_mode)) {
                total += mik__fs_dir_usage(child);
            }
        }
    }
    closedir(dir);
    return total;
}

/* Check if a write of `bytes` would exceed the fs_limit. Returns 0 if OK,
 * -1 if over limit. Uses a cached usage counter maintained by
 * mik__fs_note_delta/mik__fs_invalidate_usage; walks the tree only on
 * first call (or after an invalidation). */
static int mik__fs_check_limit(JSContext* ctx, size_t bytes) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik_rt || mik_rt->fs_limit == 0) return 0;
    const char* root = mik_rt->fs_root ? mik_rt->fs_root : mik_rt->fs_base_path;
    if (!root) return 0;
    if (!mik_rt->fs_used_known) {
        mik_rt->fs_used = mik__fs_dir_usage(root);
        mik_rt->fs_used_known = true;
    }
    if (mik_rt->fs_used + bytes > mik_rt->fs_limit) return -1;
    return 0;
}

/* Apply a signed delta to the cached fs_used counter. No-op if the cache
 * isn't populated yet (the next check will walk). Clamps at zero. */
static void mik__fs_note_delta(JSContext* ctx, ssize_t delta) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (!mik_rt || !mik_rt->fs_used_known) return;
    if (delta < 0) {
        size_t dec = (size_t)(-delta);
        mik_rt->fs_used = (mik_rt->fs_used > dec) ? (mik_rt->fs_used - dec) : 0;
    } else {
        mik_rt->fs_used += (size_t)delta;
    }
}

/* Mark the cache stale — next check will re-walk. Used when we can't
 * cheaply compute the delta (FileHandle truncation, rmdir). */
static void mik__fs_invalidate_usage(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt) mik_rt->fs_used_known = false;
}

/* Return the current size of a file at `resolved_path`, or 0 if absent. */
static size_t mik__fs_file_size(const char* resolved_path) {
    struct stat st;
    if (stat(resolved_path, &st) != 0) return 0;
    if (!S_ISREG(st.st_mode)) return 0;
    return (size_t)st.st_size;
}

static void mik__file_finalizer(JSRuntime* rt, JSValue val) {
    MIKFileHandle* fh = static_cast<MIKFileHandle*>(JS_GetOpaque(val, mik_file_class_id));
    if (fh) {
        if (fh->file) {
            /* Handle was GC'd before close() — likely a leak (forgotten
             * try/finally, or an exception that bypassed close). Log at
             * debug level so it's visible when chasing fd exhaustion but
             * silent in production. Pulling the path string here is unsafe
             * (the runtime may be shutting down), so the message stays
             * generic — the fd count is what matters in practice. */
            const MIKPlatform* platform = MIK_GetPlatform();
            if (platform && platform->log) {
                platform->log(MIK_LOG_DEBUG, "mikrojs/fs",
                              "FileHandle GC'd while still open — forgot close()?");
            }
            fflush(fh->file);
            fclose(fh->file);
            fh->file = NULL;
        }
        JS_FreeValueRT(rt, fh->path);
        js_free_rt(rt, fh);
    }
}

static JSClassDef mik_file_class = {
    .class_name = "FileHandle",
    .finalizer = mik__file_finalizer,
    .gc_mark = nullptr,
    .call = nullptr,
    .exotic = nullptr,
};

static MIKFileHandle* mik__file_get(JSContext* ctx, JSValue obj) {
    return static_cast<MIKFileHandle*>(JS_GetOpaque2(ctx, obj, mik_file_class_id));
}

/* Forward declarations — defined in the public-API section below. */
static JSValue mik__fs_err_result(JSContext* ctx, int err, const char* path);
static JSValue mik__fs_stat_result(JSContext* ctx, const struct stat* st);

/* FileHandle.prototype.read(size) → Result<Uint8Array | undefined, FSError>
 * (ok(undefined) at EOF). */
static JSValue mik__file_read(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh || !fh->file) {
        return mik__fs_err_result(ctx, EBADF, nullptr);
    }

    uint32_t size;
    if (JS_ToUint32(ctx, &size, argv[0])) {
        return JS_EXCEPTION;
    }

    uint8_t* buf = static_cast<uint8_t*>(js_malloc(ctx, size));
    if (!buf) {
        return JS_EXCEPTION;
    }

    size_t n = fread(buf, 1, size, fh->file);
    if (n == 0) {
        js_free(ctx, buf);
        if (feof(fh->file)) {
            return mik__result_ok(ctx, JS_UNDEFINED);
        }
        return mik__fs_err_result(ctx, errno, nullptr);
    }

    /* Transfer ownership of buf to the Uint8Array */
    return mik__result_ok(ctx, MIK_NewUint8Array(ctx, buf, n));
}

/* FileHandle.prototype.write(data) — string or Uint8Array.
 * Returns Result<number, FSError> where value is bytes written. */
static JSValue mik__file_write(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh || !fh->file) {
        return mik__fs_err_result(ctx, EBADF, nullptr);
    }

    if (JS_GetTypedArrayType(argv[0]) == JS_TYPED_ARRAY_UINT8) {
        size_t size;
        const uint8_t* buf = JS_GetUint8Array(ctx, &size, argv[0]);
        if (!buf) {
            return JS_EXCEPTION;
        }
        if (mik__fs_check_limit(ctx, size) < 0) {
            return mik__fs_err_result(ctx, ENOSPC, nullptr);
        }
        size_t written = fwrite(buf, 1, size, fh->file);
        mik__fs_note_delta(ctx, (ssize_t)written);
        return mik__result_ok(ctx, JS_NewUint32(ctx, written));
    }

    const char* str = JS_ToCString(ctx, argv[0]);
    if (!str) {
        return JS_EXCEPTION;
    }
    size_t len = strlen(str);
    if (mik__fs_check_limit(ctx, len) < 0) {
        JS_FreeCString(ctx, str);
        return mik__fs_err_result(ctx, ENOSPC, nullptr);
    }
    size_t written = fwrite(str, 1, len, fh->file);
    JS_FreeCString(ctx, str);
    mik__fs_note_delta(ctx, (ssize_t)written);
    return mik__result_ok(ctx, JS_NewUint32(ctx, written));
}

/* FileHandle.prototype.seek(offset [, whence]) → Result<number, FSError>.
 * Value is the new absolute position. whence: 'start' (default) | 'current' | 'end'. */
static JSValue mik__file_seek(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh || !fh->file) {
        return mik__fs_err_result(ctx, EBADF, nullptr);
    }

    int64_t offset;
    if (JS_ToInt64(ctx, &offset, argv[0])) {
        return JS_EXCEPTION;
    }

    int whence = SEEK_SET;
    if (argc > 1 && JS_IsString(argv[1])) {
        const char* w = JS_ToCString(ctx, argv[1]);
        if (!w) return JS_EXCEPTION;
        if (strcmp(w, "current") == 0) whence = SEEK_CUR;
        else if (strcmp(w, "end") == 0) whence = SEEK_END;
        else if (strcmp(w, "start") != 0) {
            JS_FreeCString(ctx, w);
            return mik__fs_err_result(ctx, EINVAL, nullptr);
        }
        JS_FreeCString(ctx, w);
    }

    if (fseek(fh->file, (long)offset, whence) != 0) {
        return mik__fs_err_result(ctx, errno, nullptr);
    }
    long pos = ftell(fh->file);
    if (pos < 0) return mik__fs_err_result(ctx, errno, nullptr);
    return mik__result_ok(ctx, JS_NewInt64(ctx, pos));
}

/* FileHandle.prototype.close() → Result<void, FSError>. Idempotent. */
static JSValue mik__file_close(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh || !fh->file) {
        return mik__result_ok_void(ctx);
    }
    fflush(fh->file);
    fclose(fh->file);
    fh->file = NULL;
    return mik__result_ok_void(ctx);
}

/* FileHandle.prototype.stat() → Result<StatResult, FSError> */
static JSValue mik__file_stat(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh || !fh->file) {
        return mik__fs_err_result(ctx, EBADF, nullptr);
    }

    struct stat st;
    if (fstat(fileno(fh->file), &st) != 0) {
        return mik__fs_err_result(ctx, errno, nullptr);
    }

    return mik__result_ok(ctx, mik__fs_stat_result(ctx, &st));
}

/* FileHandle path getter */
static JSValue mik__file_path_get(JSContext* ctx, JSValue this_val) {
    MIKFileHandle* fh = mik__file_get(ctx, this_val);
    if (!fh) {
        return JS_EXCEPTION;
    }
    return JS_DupValue(ctx, fh->path);
}

static const JSCFunctionListEntry mik_file_proto_funcs[] = {
    MIK_CFUNC_DEF("read", 1, mik__file_read),
    MIK_CFUNC_DEF("write", 1, mik__file_write),
    MIK_CFUNC_DEF("seek", 2, mik__file_seek),
    MIK_CFUNC_DEF("close", 0, mik__file_close),
    MIK_CFUNC_DEF("stat", 0, mik__file_stat),
    MIK_CGETSET_DEF("path", mik__file_path_get, NULL),
};

/* ---- Module-level functions ---- */

static JSValue mik__fs_new_file(JSContext* ctx, FILE* file, const char* path) {
    JSValue obj = JS_NewObjectClass(ctx, mik_file_class_id);
    if (JS_IsException(obj)) {
        return obj;
    }

    MIKFileHandle* fh = static_cast<MIKFileHandle*>(js_mallocz(ctx, sizeof(*fh)));
    if (!fh) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }

    fh->file = file;
    fh->path = JS_NewString(ctx, path);
    JS_SetOpaque(obj, fh);
    return obj;
}

/* ── mikrojs/fs: Result-returning public API ──────────────────────── */

struct MIKFsErrInfo {
    const char* name;
    bool is_unknown;
    bool path_relevant;
};

/* Map a POSIX errno to an FSError variant descriptor. `path_relevant` is
 * false for variants like BadFileDescriptor where the filesystem path
 * doesn't meaningfully identify the error; `is_unknown` triggers the
 * errno+message debug attachment on the emitted error object. */
static MIKFsErrInfo mik__fs_errno_info(int err) {
    switch (err) {
        case ENOENT:   return {"NotFound", false, true};
        case EEXIST:   return {"AlreadyExists", false, true};
        case EACCES:
        case EROFS:    return {"AccessDenied", false, true};
        case ENOSPC:   return {"NoSpace", false, true};
        case EFBIG:    return {"TooLarge", false, true};
        case EISDIR:   return {"IsDirectory", false, true};
        case ENOTDIR:  return {"NotDirectory", false, true};
        case EBADF:    return {"BadFileDescriptor", false, false};
        default:       return {"Unknown", true, false};
    }
}

/* Build a Result-shaped error value for an fs op. Emits the final FSError
 * variant object directly — `path` is included for all path-carrying
 * variants, `errno` + `message` are attached for `Unknown` so debuggers
 * still have something actionable. The JS wrapper is a pass-through. */
static JSValue mik__fs_err_result(JSContext* ctx, int err, const char* path) {
    MIKFsErrInfo info = mik__fs_errno_info(err);
    const char* name = info.name;
    bool is_unknown = info.is_unknown;
    bool has_path = (path != nullptr && info.path_relevant);

    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, name), JS_PROP_C_W_E);
    if (has_path) {
        JS_DefinePropertyValueStr(ctx, error, "path", JS_NewString(ctx, path), JS_PROP_C_W_E);
    }
    if (is_unknown) {
        JS_DefinePropertyValueStr(ctx, error, "code", JS_NewInt32(ctx, MIK_ERR_FS_UNKNOWN),
                                  JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, error, "errno", JS_NewInt32(ctx, err), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, error, "message", JS_NewString(ctx, strerror(err)),
                                  JS_PROP_C_W_E);
    }
    return mik__result_err_obj(ctx, error);
}

/* Resolve a JS-string path argument into absolute filesystem form.
 * On success returns 0 with `resolved`/`virt` filled.
 * On failure returns -1 with `*err_out` holding the Result-shaped error
 * value the caller should return directly. The intermediate JS C-string
 * is freed before return, so callers don't track its lifetime. */
static int mik__fs_resolve(JSContext* ctx, JSValueConst arg, bool write, char* resolved,
                           size_t resolved_size, char* virt, size_t virt_size, JSValue* err_out) {
    const char* cpath = JS_ToCString(ctx, arg);
    if (!cpath) {
        *err_out = JS_EXCEPTION;
        return -1;
    }
    snprintf(virt, virt_size, "%s", cpath);
    int rc = mik__resolve_fs_root(ctx, cpath, resolved, resolved_size);
    bool readonly = write && mik__is_readonly_path(cpath);
    JS_FreeCString(ctx, cpath);
    if (rc < 0 || readonly) {
        *err_out = mik__fs_err_result(ctx, EACCES, virt);
        return -1;
    }
    return 0;
}

/* fs.readFile(path [, encoding]) → Result<Uint8Array | string, FSError> */
static JSValue mik__pub_fs_read_file(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], false, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }

    FILE* f = fopen(resolved, "r");
    if (!f) return mik__fs_err_result(ctx, errno, virt);

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size < 0) {
        int e = errno;
        fclose(f);
        return mik__fs_err_result(ctx, e, virt);
    }

    /* Cap the single-shot read so a large file can't OOM the heap.
     * Callers needing bigger reads should switch to readStream(). */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt && mik_rt->fs_read_max > 0 && (size_t)size > mik_rt->fs_read_max) {
        fclose(f);
        return mik__fs_err_result(ctx, EFBIG, virt);
    }

    bool as_string = argc >= 2 && JS_IsString(argv[1]);

    /* Empty file: skip js_malloc(0) which asserts in js_malloc_rt. */
    if (size == 0) {
        fclose(f);
        JSValue val = as_string ? JS_NewStringLen(ctx, "", 0) : MIK_NewUint8Array(ctx, nullptr, 0);
        return mik__result_ok(ctx, val);
    }

    uint8_t* buf = static_cast<uint8_t*>(js_malloc(ctx, size));
    if (!buf) {
        fclose(f);
        return JS_EXCEPTION;
    }

    size_t n = fread(buf, 1, size, f);
    fclose(f);

    if (as_string) {
        JSValue str = JS_NewStringLen(ctx, reinterpret_cast<char*>(buf), n);
        js_free(ctx, buf);
        return mik__result_ok(ctx, str);
    }

    return mik__result_ok(ctx, MIK_NewUint8Array(ctx, buf, n));
}

/* fs.writeFile(path, data [, options]) → Result<void, FSError> */
static JSValue mik__pub_fs_write_file(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], true, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }

    /* options.create (default true), options.append (default false) */
    bool create = true;
    bool append = false;
    if (argc >= 3 && JS_IsObject(argv[2])) {
        JSValue create_val = JS_GetPropertyStr(ctx, argv[2], "create");
        if (!JS_IsUndefined(create_val)) create = JS_ToBool(ctx, create_val);
        JS_FreeValue(ctx, create_val);
        JSValue append_val = JS_GetPropertyStr(ctx, argv[2], "append");
        if (!JS_IsUndefined(append_val)) append = JS_ToBool(ctx, append_val);
        JS_FreeValue(ctx, append_val);
    }

    if (!create) {
        struct stat st;
        if (stat(resolved, &st) != 0) return mik__fs_err_result(ctx, errno, virt);
    }

    /* Determine write size for limit check */
    size_t write_size = 0;
    if (JS_GetTypedArrayType(argv[1]) == JS_TYPED_ARRAY_UINT8) {
        const uint8_t* buf = JS_GetUint8Array(ctx, &write_size, argv[1]);
        if (!buf) return JS_EXCEPTION;
    } else {
        const char* str = JS_ToCStringLen(ctx, &write_size, argv[1]);
        if (!str) return JS_EXCEPTION;
        JS_FreeCString(ctx, str);
    }

    /* Quota accounting needs the existing size so the delta is accurate.
     * Append keeps old bytes (net = write_size); truncate replaces them
     * (net = max(write_size - old_size, 0)). */
    size_t old_size = mik__fs_file_size(resolved);
    size_t net = append ? write_size
                        : (write_size > old_size ? write_size - old_size : 0);
    if (mik__fs_check_limit(ctx, net) < 0) {
        return mik__fs_err_result(ctx, ENOSPC, virt);
    }

    FILE* f = fopen(resolved, append ? "a" : "w");
    if (!f) return mik__fs_err_result(ctx, errno, virt);

    /* Write string or Uint8Array */
    if (JS_GetTypedArrayType(argv[1]) == JS_TYPED_ARRAY_UINT8) {
        size_t size;
        const uint8_t* buf = JS_GetUint8Array(ctx, &size, argv[1]);
        if (!buf) {
            fclose(f);
            return JS_EXCEPTION;
        }
        fwrite(buf, 1, size, f);
    } else {
        size_t len;
        const char* str = JS_ToCStringLen(ctx, &len, argv[1]);
        if (!str) {
            fclose(f);
            return JS_EXCEPTION;
        }
        fwrite(str, 1, len, f);
        JS_FreeCString(ctx, str);
    }

    fclose(f);
    ssize_t delta = append ? (ssize_t)write_size
                           : (ssize_t)write_size - (ssize_t)old_size;
    mik__fs_note_delta(ctx, delta);
    return mik__result_ok_void(ctx);
}

/* Build a StatResult object from a stat struct. mtime is ms since epoch;
 * the property is omitted when the platform doesn't track modification
 * time (LittleFS without CONFIG_LITTLEFS_USE_MTIME reports 0). */
static JSValue mik__fs_stat_result(JSContext* ctx, const struct stat* st) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "size", JS_NewInt64(ctx, st->st_size));
    JS_SetPropertyStr(ctx, obj, "isDirectory", JS_NewBool(ctx, S_ISDIR(st->st_mode)));
    JS_SetPropertyStr(ctx, obj, "isFile", JS_NewBool(ctx, S_ISREG(st->st_mode)));
    if (st->st_mtime > 0) {
        JS_SetPropertyStr(ctx, obj, "mtime", JS_NewInt64(ctx, (int64_t)st->st_mtime * 1000));
    }
    return obj;
}

/* fs.stat(path) → Result<StatResult, FSError> */
static JSValue mik__pub_fs_stat(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], false, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }

    struct stat st;
    if (stat(resolved, &st) != 0) return mik__fs_err_result(ctx, errno, virt);

    return mik__result_ok(ctx, mik__fs_stat_result(ctx, &st));
}

/* fs.readDir(path) → Result<Array<{name,isFile,isDirectory}>, FSError>.
 * Uses dirent.d_type when available; falls back to stat on DT_UNKNOWN. */
static JSValue mik__pub_fs_read_dir(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], false, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }

    DIR* dir = opendir(resolved);
    if (!dir) return mik__fs_err_result(ctx, errno, virt);

    JSValue arr = JS_NewArray(ctx);
    uint32_t idx = 0;
    struct dirent* entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;

        bool is_dir = false, is_file = false;
#ifdef DT_DIR
        if (entry->d_type == DT_DIR) {
            is_dir = true;
        } else if (entry->d_type == DT_REG) {
            is_file = true;
        } else
#endif
        {
            /* d_type unknown or not supported — stat the child to classify. */
            char child[PATH_MAX];
            snprintf(child, sizeof(child), "%s/%s", resolved, entry->d_name);
            struct stat st;
            if (stat(child, &st) == 0) {
                is_dir = S_ISDIR(st.st_mode);
                is_file = S_ISREG(st.st_mode);
            }
        }

        JSValue e = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, e, "name", JS_NewString(ctx, entry->d_name));
        JS_SetPropertyStr(ctx, e, "isDirectory", JS_NewBool(ctx, is_dir));
        JS_SetPropertyStr(ctx, e, "isFile", JS_NewBool(ctx, is_file));
        JS_SetPropertyUint32(ctx, arr, idx++, e);
    }
    closedir(dir);
    return mik__result_ok(ctx, arr);
}

/* fs.unlink(path) → Result<void, FSError> */
static JSValue mik__pub_fs_unlink(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], true, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }
    size_t old_size = mik__fs_file_size(resolved);
    if (unlink(resolved) != 0) return mik__fs_err_result(ctx, errno, virt);
    mik__fs_note_delta(ctx, -(ssize_t)old_size);
    return mik__result_ok_void(ctx);
}

/* fs.rename(from, to) → Result<void, FSError> */
static JSValue mik__pub_fs_rename(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved_from[PATH_MAX], virt_from[PATH_MAX];
    char resolved_to[PATH_MAX], virt_to[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], true, resolved_from, sizeof(resolved_from),
                        virt_from, sizeof(virt_from), &err) < 0) {
        return err;
    }
    if (mik__fs_resolve(ctx, argv[1], true, resolved_to, sizeof(resolved_to), virt_to,
                        sizeof(virt_to), &err) < 0) {
        return err;
    }
    if (rename(resolved_from, resolved_to) != 0) {
        return mik__fs_err_result(ctx, errno, virt_from);
    }
    return mik__result_ok_void(ctx);
}

/* fs.mkdir(path) → Result<void, FSError> */
static JSValue mik__pub_fs_mkdir(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], true, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }

    bool recursive = false;
    if (argc > 1 && JS_IsObject(argv[1])) {
        JSValue r = JS_GetPropertyStr(ctx, argv[1], "recursive");
        recursive = JS_ToBool(ctx, r);
        JS_FreeValue(ctx, r);
    }

    int rc = recursive ? mik__mkdir_recursive(resolved, 0755) : mkdir(resolved, 0755);
    if (rc != 0) return mik__fs_err_result(ctx, errno, virt);
    return mik__result_ok_void(ctx);
}

/* fs.rmdir(path) → Result<void, FSError> */
static JSValue mik__pub_fs_rmdir(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], true, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        return err;
    }
    if (rmdir(resolved) != 0) return mik__fs_err_result(ctx, errno, virt);
    /* rmdir only succeeds on empty dirs. The directory entry itself is
     * tiny and LittleFS-specific; invalidate rather than tracking it. */
    mik__fs_invalidate_usage(ctx);
    return mik__result_ok_void(ctx);
}

/* fs.open(path [, mode]) → Result<FileHandle, FSError>.
 * Modes follow fopen(): 'r' | 'w' | 'a' | 'r+' | 'w+' | 'a+'. Default 'r'. */
static JSValue mik__pub_fs_open(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* mode = "r";
    bool mode_owned = argc > 1 && JS_IsString(argv[1]);
    bool write_mode = false;
    if (mode_owned) {
        mode = JS_ToCString(ctx, argv[1]);
        if (!mode) return JS_EXCEPTION;
        write_mode = mode[0] != 'r' || mode[1] == '+';
    }

    char resolved[PATH_MAX], virt[PATH_MAX];
    JSValue err;
    if (mik__fs_resolve(ctx, argv[0], write_mode, resolved, sizeof(resolved), virt,
                        sizeof(virt), &err) < 0) {
        if (mode_owned) JS_FreeCString(ctx, mode);
        return err;
    }

    /* Modes 'w' and 'w+' truncate any existing file on open — the cached
     * fs_used counter would be stale for that path, so invalidate. */
    bool truncates = mode[0] == 'w';

    FILE* f = fopen(resolved, mode);
    if (mode_owned) JS_FreeCString(ctx, mode);
    if (!f) return mik__fs_err_result(ctx, errno, virt);

    if (truncates) mik__fs_invalidate_usage(ctx);
    return mik__result_ok(ctx, mik__fs_new_file(ctx, f, virt));
}

/* fs.exists(path) → boolean; never fails.
 * Kept as a plain bool (not Result) because there is no meaningful error —
 * resolution failure just means "not reachable", which is a superset of
 * "does not exist". */
static JSValue mik__pub_fs_exists(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    const char* cpath = JS_ToCString(ctx, argv[0]);
    if (!cpath) return JS_EXCEPTION;
    char resolved[PATH_MAX];
    int rc = mik__resolve_fs_root(ctx, cpath, resolved, sizeof(resolved));
    JS_FreeCString(ctx, cpath);
    if (rc < 0) return JS_NewBool(ctx, false);
    struct stat st;
    return JS_NewBool(ctx, stat(resolved, &st) == 0);
}

/* Module exports for mikrojs/fs */
static const char* const pub_fs_exports[] = {"open",   "readFile", "writeFile", "stat",
                                             "readDir", "unlink",  "rename",    "mkdir",
                                             "rmdir",   "exists"};

static int mik__pub_fs_module_init(JSContext* ctx, JSModuleDef* m) {
    JSValue ns = JS_NewObjectProto(ctx, JS_NULL);

    JS_SetPropertyStr(ctx, ns, "open", JS_NewCFunction(ctx, mik__pub_fs_open, "open", 2));
    JS_SetPropertyStr(ctx, ns, "readFile",
                      JS_NewCFunction(ctx, mik__pub_fs_read_file, "readFile", 1));
    JS_SetPropertyStr(ctx, ns, "writeFile",
                      JS_NewCFunction(ctx, mik__pub_fs_write_file, "writeFile", 2));
    JS_SetPropertyStr(ctx, ns, "stat", JS_NewCFunction(ctx, mik__pub_fs_stat, "stat", 1));
    JS_SetPropertyStr(ctx, ns, "readDir",
                      JS_NewCFunction(ctx, mik__pub_fs_read_dir, "readDir", 1));
    JS_SetPropertyStr(ctx, ns, "unlink", JS_NewCFunction(ctx, mik__pub_fs_unlink, "unlink", 1));
    JS_SetPropertyStr(ctx, ns, "rename", JS_NewCFunction(ctx, mik__pub_fs_rename, "rename", 2));
    JS_SetPropertyStr(ctx, ns, "mkdir", JS_NewCFunction(ctx, mik__pub_fs_mkdir, "mkdir", 1));
    JS_SetPropertyStr(ctx, ns, "rmdir", JS_NewCFunction(ctx, mik__pub_fs_rmdir, "rmdir", 1));
    JS_SetPropertyStr(ctx, ns, "exists", JS_NewCFunction(ctx, mik__pub_fs_exists, "exists", 1));

    for (size_t i = 0; i < countof(pub_fs_exports); i++) {
        JS_SetModuleExport(ctx, m, pub_fs_exports[i], JS_GetPropertyStr(ctx, ns, pub_fs_exports[i]));
    }
    JS_FreeValue(ctx, ns);
    return 0;
}

void mik__pub_fs_register(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* FileHandle class (used by open()) */
    JS_NewClassID(rt, &mik_file_class_id);
    JS_NewClass(rt, mik_file_class_id, &mik_file_class);
    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, mik_file_proto_funcs, countof(mik_file_proto_funcs));
    JS_SetClassProto(ctx, mik_file_class_id, proto);

    JSModuleDef* m = JS_NewCModule(ctx, "native:mikro/fs", mik__pub_fs_module_init);
    if (m) {
        for (size_t i = 0; i < countof(pub_fs_exports); i++) {
            JS_AddModuleExport(ctx, m, pub_fs_exports[i]);
        }
    }
}

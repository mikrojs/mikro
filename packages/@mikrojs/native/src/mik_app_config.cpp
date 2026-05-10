#include "mikrojs/mikrojs.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sys/stat.h>

#include "mikrojs/platform.h"
#include "mikrojs/private.h"

static const char* TAG = "mik_app_config";

void MIK_DefaultConfig(MIKConfig* config) {
    config->restart_on_uncaught_exception = false;
    config->restart_delay_ms = 1000;
    config->stack_size = 0;
    config->mem_reserved = 64 * 1024;
    config->fs_read_max = 0; /* 0 = runtime default (65536) */
    config->entry_point[0] = '\0';
    config->wifi_country[0] = '\0';
    config->wifi_hostname[0] = '\0';
}

/* Minimal JSON parser for config file — avoids cJSON dependency.
 * Only handles the flat object with bool/number fields we need. */
static bool mik__json_get_bool(const char* json, const char* key, bool* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char* p = strstr(json, pattern);
    if (!p) return false;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (strncmp(p, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
    return false;
}

static bool mik__json_get_string(const char* json, const char* key, char* out, size_t out_size) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char* p = strstr(json, pattern);
    if (!p) return false;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p != '"') return false;
    p++;  /* skip opening quote */
    const char* end = strchr(p, '"');
    if (!end) return false;
    size_t len = end - p;
    if (len >= out_size) len = out_size - 1;
    memcpy(out, p, len);
    out[len] = '\0';
    return true;
}

static bool mik__json_get_number(const char* json, const char* key, double* out) {
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char* p = strstr(json, pattern);
    if (!p) return false;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    char* end = nullptr;
    double val = strtod(p, &end);
    if (end == p) return false;
    *out = val;
    return true;
}

/* Read a JSON file into a malloc'd buffer. Caller must free(). Returns NULL on failure. */
static char* mik__read_json_file(const char* filepath, struct stat* st) {
    if (stat(filepath, st) != 0) return nullptr;
    FILE* f = fopen(filepath, "r");
    if (!f) return nullptr;
    char* buf = static_cast<char*>(malloc(st->st_size + 1));
    if (!buf) { fclose(f); return nullptr; }
    size_t n = fread(buf, 1, st->st_size, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

/* Search for package.json: first at base_path, then in immediate subdirectories.
 * Writes the found path into out_path and returns a malloc'd buffer (caller frees),
 * or returns NULL if not found. */
static char* mik__find_package_json(const char* base_path, char* out_path, size_t out_size,
                                    struct stat* st) {
    /* Try base_path/package.json first */
    snprintf(out_path, out_size, "%s/package.json", base_path);
    char* buf = mik__read_json_file(out_path, st);
    if (buf) return buf;

    /* Scan immediate subdirectories */
    DIR* dir = opendir(base_path);
    if (!dir) return nullptr;
    struct dirent* ent;
    while ((ent = readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.') continue;
        char subdir[PATH_MAX];
        snprintf(subdir, sizeof(subdir), "%s/%s", base_path, ent->d_name);
        struct stat dir_st;
        if (stat(subdir, &dir_st) != 0 || !S_ISDIR(dir_st.st_mode)) continue;
        snprintf(out_path, out_size, "%s/%s/package.json", base_path, ent->d_name);
        buf = mik__read_json_file(out_path, st);
        if (buf) {
            closedir(dir);
            return buf;
        }
    }
    closedir(dir);
    return nullptr;
}

/* Locate the value of a top-level key within a JSON object, respecting
 * string quoting and nesting. Returns a pointer at the first non-whitespace
 * character after the `:`, or NULL if the key is not a direct child of the
 * root object. This avoids false matches where the search substring appears
 * inside a string value (e.g. a "description" field containing the word
 * "tests") or inside a nested object. Used by array/typed readers where
 * precision matters; existing flat scalar helpers above are more permissive
 * and preserve their prior behavior. */
static const char* mik__json_find_top_level_value(const char* json, const char* key) {
    size_t key_len = strlen(key);
    const char* p = json;
    while (*p && *p != '{') p++;
    if (*p != '{') return nullptr;
    p++;
    int depth = 1;
    bool at_key = true;
    while (*p && depth > 0) {
        char c = *p;
        if (c == '"') {
            bool was_at_key = (depth == 1 && at_key);
            const char* str = p + 1;
            p = str;
            while (*p && *p != '"') {
                if (*p == '\\' && p[1]) p += 2;
                else p++;
            }
            if (*p != '"') return nullptr;
            if (was_at_key && (size_t)(p - str) == key_len && memcmp(str, key, key_len) == 0) {
                p++;
                while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
                if (*p != ':') return nullptr;
                p++;
                while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
                return p;
            }
            p++;
            at_key = false;
            continue;
        }
        if (c == '{' || c == '[') { depth++; p++; at_key = false; continue; }
        if (c == '}' || c == ']') { depth--; p++; continue; }
        if (c == ',' && depth == 1) { at_key = true; p++; continue; }
        p++;
    }
    return nullptr;
}

/* Parse a "tests": ["path1", "path2", ...] array out of a JSON string.
 * Only handles a flat array of quoted strings — no nested structures,
 * no escape processing, no trailing commas. Returns 0 on success (even
 * when the key is absent or the array is empty), nonzero on malloc error.
 * Caller frees via MIK_FreeTests. */
static int mik__json_get_string_array(const char* json, const char* key, char*** out_items,
                                      size_t* out_count) {
    *out_items = nullptr;
    *out_count = 0;

    const char* p = mik__json_find_top_level_value(json, key);
    if (!p || *p != '[') return 0;
    p++;

    /* First pass: count strings. */
    size_t count = 0;
    const char* scan = p;
    while (*scan) {
        while (*scan == ' ' || *scan == '\t' || *scan == '\n' || *scan == '\r' || *scan == ',') {
            scan++;
        }
        if (*scan == ']' || *scan == '\0') break;
        if (*scan != '"') return 0; /* malformed */
        scan++;
        const char* end = strchr(scan, '"');
        if (!end) return 0;
        count++;
        scan = end + 1;
    }
    if (count == 0) return 0;

    char** items = static_cast<char**>(calloc(count, sizeof(char*)));
    if (!items) return -1;

    /* Second pass: copy strings. */
    size_t i = 0;
    while (*p && i < count) {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',') p++;
        if (*p == ']' || *p == '\0') break;
        if (*p != '"') break;
        p++;
        const char* end = strchr(p, '"');
        if (!end) break;
        size_t len = end - p;
        char* s = static_cast<char*>(malloc(len + 1));
        if (!s) {
            for (size_t j = 0; j < i; j++) free(items[j]);
            free(items);
            return -1;
        }
        memcpy(s, p, len);
        s[len] = '\0';
        items[i++] = s;
        p = end + 1;
    }

    *out_items = items;
    *out_count = i;
    return 0;
}

int MIK_LoadTests(const char* base_path, char*** out_paths, size_t* out_count) {
    *out_paths = nullptr;
    *out_count = 0;

    char path[PATH_MAX];
    struct stat st;
    char* buf = mik__find_package_json(base_path, path, sizeof(path), &st);
    if (!buf) return 0;

    /* Derive the same prefix MIK_LoadConfig uses for "main", so test paths
     * are resolved relative to the app directory rather than base_path. */
    const char* pkg_dir = path + strlen(base_path);
    char prefix[128] = "";
    const char* last_slash = strrchr(pkg_dir, '/');
    if (last_slash && last_slash != pkg_dir) {
        size_t plen = last_slash - pkg_dir;
        if (plen >= sizeof(prefix)) plen = sizeof(prefix) - 1;
        memcpy(prefix, pkg_dir, plen);
        prefix[plen] = '\0';
    }

    char** raw_items = nullptr;
    size_t raw_count = 0;
    int rc = mik__json_get_string_array(buf, "tests", &raw_items, &raw_count);
    free(buf);
    if (rc != 0 || raw_count == 0) {
        MIK_FreeTests(raw_items, raw_count);
        return rc;
    }

    /* Apply the same prefix MIK_LoadConfig uses for "main". */
    char** resolved = static_cast<char**>(calloc(raw_count, sizeof(char*)));
    if (!resolved) {
        MIK_FreeTests(raw_items, raw_count);
        return -1;
    }
    for (size_t i = 0; i < raw_count; i++) {
        const char* entry = raw_items[i];
        if (entry[0] == '.' && entry[1] == '/') entry += 2;
        size_t need = strlen(prefix) + 1 + strlen(entry) + 1;
        char* s = static_cast<char*>(malloc(need));
        if (!s) {
            for (size_t j = 0; j < i; j++) free(resolved[j]);
            free(resolved);
            MIK_FreeTests(raw_items, raw_count);
            return -1;
        }
        snprintf(s, need, "%s/%s", prefix, entry);
        resolved[i] = s;
    }
    MIK_FreeTests(raw_items, raw_count);

    *out_paths = resolved;
    *out_count = raw_count;
    return 0;
}

void MIK_FreeTests(char** paths, size_t count) {
    if (!paths) return;
    for (size_t i = 0; i < count; i++) free(paths[i]);
    free(paths);
}

int MIK_LoadConfig(const char* base_path, MIKConfig* config) {
    const MIKPlatform* platform = MIK_GetPlatform();
    MIK_DefaultConfig(config);

    char path[PATH_MAX];
    struct stat st;

    /* Find the app directory via package.json.
     * Search in base_path first, then in immediate subdirectories
     * (the build places package.json alongside the entry in the app dir). */
    char* buf = mik__find_package_json(base_path, path, sizeof(path), &st);
    if (buf) {
        /* Extract the directory where package.json was found */
        char app_dir[PATH_MAX];
        snprintf(app_dir, sizeof(app_dir), "%s", path);
        char* last_slash = strrchr(app_dir, '/');
        if (last_slash) *last_slash = '\0';

        /* Compute prefix: the subdirectory relative to base_path */
        const char* pkg_dir = path + strlen(base_path);
        char prefix[128] = "";
        last_slash = strrchr(const_cast<char*>(pkg_dir), '/');
        if (last_slash && last_slash != pkg_dir) {
            size_t plen = last_slash - pkg_dir;
            if (plen >= sizeof(prefix)) plen = sizeof(prefix) - 1;
            memcpy(prefix, pkg_dir, plen);
            prefix[plen] = '\0';
        }

        /* Load entry point from package.json "main" field */
        char main_field[128];
        if (mik__json_get_string(buf, "main", main_field, sizeof(main_field))) {
            const char* entry = main_field;
            if (entry[0] == '.' && entry[1] == '/') entry += 2;
            snprintf(config->entry_point, sizeof(config->entry_point), "%s/%s", prefix, entry);
            platform->log(MIK_LOG_INFO, TAG, "Entry point: %s", config->entry_point);
        }
        free(buf);

        /* Load mikro.config.json from the same directory */
        snprintf(path, sizeof(path), "%s/mikro.config.json", app_dir);
        buf = mik__read_json_file(path, &st);
        if (buf) {
            bool bool_val;
            double num_val;

            if (mik__json_get_bool(buf, "restartOnUncaughtException", &bool_val)) {
                config->restart_on_uncaught_exception = bool_val;
            }
            if (mik__json_get_number(buf, "restartDelay", &num_val)) {
                config->restart_delay_ms = (int)num_val;
            }
            if (mik__json_get_number(buf, "stackSize", &num_val)) {
                config->stack_size = (size_t)num_val;
            }
            if (mik__json_get_number(buf, "memReserved", &num_val)) {
                config->mem_reserved = (uint32_t)num_val;
            }
            if (mik__json_get_number(buf, "fsReadMax", &num_val)) {
                config->fs_read_max = (uint32_t)num_val;
            }
            mik__json_get_string(buf, "wifi.country", config->wifi_country,
                                 sizeof(config->wifi_country));
            mik__json_get_string(buf, "wifi.hostname", config->wifi_hostname,
                                 sizeof(config->wifi_hostname));

            platform->log(MIK_LOG_INFO, TAG,
                           "Loaded config: restart=%d delay=%dms stack=%u reserved=%lu",
                           config->restart_on_uncaught_exception, config->restart_delay_ms,
                           (unsigned)config->stack_size, (unsigned long)config->mem_reserved);
            free(buf);
        }
    }

    return 0;
}

#include <esp_log.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include <algorithm>
#include <filesystem>
#include <vector>

#include "esp_littlefs.h"
namespace fs = std::filesystem;

int WRITE_FAILED = 0;
int OPEN_FAILED = -1;
int WRITE_OK = 1;
char* FILE_READ = "r";
char* FILE_WRITE = "w";

typedef struct {
    const char* base_path;
    const char* partition_label;
    uint8_t format_on_error : 1;

} ujs_fs_conf_t;

#define MAX_SAFE_INTEGER (((uint32_t)1 << 31) - 1)

class UJSFS {
   public:
    UJSFS(ujs_fs_conf_t conf) {
        littlefs_conf = {
            .base_path = conf.base_path,
            .partition_label = conf.partition_label,
            .format_if_mount_failed = conf.format_on_error,
            .read_only = false,
            .dont_mount = false,
        };
    }

   private:
    struct FileHandle {
        uint32_t id;
        const char* mode;
        const char* path;
        FILE* file;
    };

    std::vector<FileHandle> open_handles;
    // note: start at 1 to avoid if (timerId) {...} bugs
    uint32_t id_counter = 0;
    esp_vfs_littlefs_conf_t littlefs_conf;

    std::optional<FileHandle> getByHandle(uint32_t id) {
        auto it =
            std::find_if(open_handles.begin(), open_handles.end(), [id](const FileHandle& handle) {
                return handle.id == id;
            });
        return it == open_handles.end() ? std::nullopt : std::optional(*it);
    }

    void eraseHandle(uint32_t id) {
        open_handles.erase(std::remove_if(open_handles.begin(), open_handles.end(),
                                          [id](FileHandle handle) {
                                              return handle.id == id;
                                          }),
                           open_handles.end());
    }

    const fs::path virtual_path(const char* path) const {
        fs::path dir(littlefs_conf.base_path);
        fs::path const file_path(path);
        fs::path full_path = dir += file_path;
        ESP_LOGD("microjs ", "virtual_path of %s=%s", path, full_path.c_str());

        return full_path;
    }

   public:
    esp_err_t begin() { return esp_vfs_littlefs_register(&littlefs_conf); }
    esp_err_t end() { return esp_vfs_littlefs_unregister(littlefs_conf.partition_label); }

    bool isValidHandle(uint32_t id) {
        return std::any_of(open_handles.begin(), open_handles.end(),
                           [id](const FileHandle& handle) {
                               return handle.id == id;
                           });
    }

    uint32_t open(const char* path, const char* mode = FILE_READ) {
        FILE* file = fopen(virtual_path(path).c_str(), mode);
        if (file == NULL) {
            return -1;
        }
        id_counter++;
        if (id_counter >= MAX_SAFE_INTEGER) {
            id_counter = 1;
        }

        const auto entry = FileHandle{
            .id = id_counter,
            .mode = mode,
            .path = path,
            .file = file,
        };

        open_handles.push_back(entry);
        return entry.id;
    }

    size_t write(const int32_t id, const uint8_t* buf, size_t size) {
        auto const handle = getByHandle(id);
        if (!handle.has_value()) {
            return WRITE_FAILED;
        }
        return fwrite(buf, size, 1, handle.value().file);
    }

    std::optional<uint8_t*> read(const int32_t id, size_t size) {
        auto handle = getByHandle(id);
        if (!handle.has_value()) {
            return std::nullopt;
        }
        FILE* file = handle.value().file;
        auto buffer = (uint8_t*)malloc(size * sizeof(uint8_t));
        fread(buffer, sizeof(uint8_t), size, file);
        return std::optional(buffer);
    }

    int stat(const char* path, struct stat* buf) const {
        return ::stat(virtual_path(path).c_str(), buf);
    }

    bool exists(const char* path) const {
        struct stat buffer;
        int ret = ::stat(virtual_path(path).c_str(), &buffer);
        if (ret == 0) {
            return true;
        }
        if (errno == ENOENT) {
            return false;
        }
        if (errno) {
            raise errno;
        }
        return false;
    }

    void seek(const int32_t id, long offset) {
        auto const handle = getByHandle(id);
        if (handle.has_value()) {
            // todo: should this throw?
            return;
        }
        FILE* file = handle.value().file;
        fseek(file, offset, SEEK_SET);
    }

    void close(const int32_t id) {
        auto handle = getByHandle(id);
        if (!handle.has_value()) {
            // todo: warn?
            return;
        }
        fclose(handle.value().file);
        eraseHandle(id);
    }

    size_t openHandlesCount() const { return open_handles.size(); }
};

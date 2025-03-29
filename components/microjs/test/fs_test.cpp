#include <esp_log.h>
#include <unity.h>

#include "../ujs_fs.cpp"
#include "esp_littlefs.h"
#include "quickjs.h"

ujs_fs_conf_t conf = {
    .base_path = "/littlefs",
    .partition_label = "littlefs",
    .format_on_error = true,
};

UJSFS ujs_fs = UJSFS(conf);

TEST_CASE("Check if file exists", "[fs]") {
    TEST_ASSERT_TRUE_MESSAGE(ujs_fs.exists("/dummy.txt"), "Expected dummy.txt to exist");
    TEST_ASSERT_FALSE_MESSAGE(ujs_fs.exists("/nonexistent.txt"),
                              "Expected /nonexistent.txt to not exist");
}

TEST_CASE("Create a file handle for reading existing file", "[fs]") {
    auto const handle = ujs_fs.open("/dummy.txt");

    TEST_ASSERT_EQUAL_INT(1, handle);
    TEST_ASSERT_EQUAL_INT(1, ujs_fs.openHandlesCount());
    ujs_fs.close(handle);
    TEST_ASSERT_EQUAL_INT(0, ujs_fs.openHandlesCount());
}

TEST_CASE("Create a file handle for reading nonexistent file", "[fs]") {
    uint32_t handle;
    handle = ujs_fs.open("/../dummy.txt");
    TEST_ASSERT_EQUAL_INT(handle, -1);

    handle = ujs_fs.open("./dummy.txt");
    TEST_ASSERT_EQUAL_INT(handle, -1);

    handle = ujs_fs.open("dummy.txt");
    TEST_ASSERT_EQUAL_INT(handle, -1);

    TEST_ASSERT_EQUAL_INT(0, ujs_fs.openHandlesCount());
}

TEST_CASE("Read from handle", "[fs]") {
    auto const id = ujs_fs.open("/dummy.txt", "rb");

    const uint8_t expected[] = {'H', 'e', 'l', 'l', 'o', ' ', 'W', 'o', 'r', 'l', 'd'};
    auto const ret = ujs_fs.read(id, sizeof(expected));
    TEST_ASSERT_TRUE_MESSAGE(ret.has_value(), "Failed to read from file");
    TEST_ASSERT_EQUAL_UINT8_ARRAY(expected, ret.value(), sizeof(expected));

    ujs_fs.close(id);
    TEST_ASSERT_EQUAL_INT(0, ujs_fs.openHandlesCount());
}

TEST_CASE("Create file handle for writing", "[fs]") {
    auto const id = ujs_fs.open("/new.txt", "w");
    const uint8_t contents[] = {'H', 'e', 'l', 'l', 'o', ' ', 'W', 'o', 'r', 'l', 'd'};

    ujs_fs.write(id, contents, sizeof(contents));
    ujs_fs.close(id);

    TEST_ASSERT_EQUAL_INT(0, ujs_fs.openHandlesCount());
    auto const new_id = ujs_fs.open("/dummy.txt", "rb");

    auto const ret = ujs_fs.read(new_id, sizeof(contents));
    TEST_ASSERT_TRUE_MESSAGE(ret.has_value(), "Failed to read from file");
    TEST_ASSERT_EQUAL_UINT8_ARRAY(contents, ret.value(), sizeof(contents));
    ujs_fs.close(new_id);

    TEST_ASSERT_TRUE(ujs_fs.exists("/new.txt"));
}

void tearDown() { ujs_fs.end(); }

void setUp() {
    esp_err_t ret = ujs_fs.begin();
    if (ret != ESP_OK) {
        ESP_LOGE("littlefs", "Failed to get LittleFS partition information (%s)",
                 esp_err_to_name(ret));
    }
}

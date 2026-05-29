#include <cstdio>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/mikrojs.h>

#include <doctest.h>

/* Helper: create a temporary directory and return its path */
static std::string make_temp_dir() {
    char tmpl[] = "/tmp/mik_config_test_XXXXXX";
    char* dir = mkdtemp(tmpl);
    return std::string(dir);
}

/* Helper: create a subdirectory and return its path */
static std::string make_subdir(const std::string& parent, const char* name) {
    auto path = parent + "/" + name;
    mkdir(path.c_str(), 0755);
    return path;
}

/* Helper: write a string to a file */
static void write_file(const std::string& path, const char* content) {
    FILE* f = fopen(path.c_str(), "w");
    fputs(content, f);
    fclose(f);
}

/* Helper: remove a file (ignore errors) */
static void remove_file(const std::string& path) {
    remove(path.c_str());
}

TEST_CASE("MIK_LoadConfig reads entry_point from package.json at root" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json", R"({"main": "./app/main.js"})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string("/app/main.js"), std::string(config.entry_point));

    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig finds package.json in subdirectory" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    auto app = make_subdir(dir, "app");
    write_file(app + "/package.json", R"({"main": "./main.js"})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string("/app/main.js"), std::string(config.entry_point));

    remove_file(app + "/package.json");
    rmdir(app.c_str());
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig strips leading ./ from main field" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    auto src = make_subdir(dir, "src");
    write_file(src + "/package.json", R"({"main": "./index.js"})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string("/src/index.js"), std::string(config.entry_point));

    remove_file(src + "/package.json");
    rmdir(src.c_str());
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig handles main field without leading ./" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    auto app = make_subdir(dir, "app");
    write_file(app + "/package.json", R"({"main": "main.ts"})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string("/app/main.ts"), std::string(config.entry_point));

    remove_file(app + "/package.json");
    rmdir(app.c_str());
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig leaves entry_point empty when no package.json" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string(""), std::string(config.entry_point));

    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig leaves entry_point empty when package.json has no main" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json", R"({"name": "test"})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(std::string(""), std::string(config.entry_point));

    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadTests reads tests array and applies main's path prefix" *
          doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    auto app = make_subdir(dir, "app");
    write_file(app + "/package.json",
               R"({"main":"./main.js","tests":["./test/a.test.js","test/b.test.js"]})");

    char** paths = nullptr;
    size_t count = 0;
    int rc = MIK_LoadTests(dir.c_str(), &paths, &count);

    CHECK_EQ(0, rc);
    CHECK_EQ((size_t)2, count);
    CHECK_EQ(std::string("/app/test/a.test.js"), std::string(paths[0]));
    CHECK_EQ(std::string("/app/test/b.test.js"), std::string(paths[1]));

    MIK_FreeTests(paths, count);
    remove_file(app + "/package.json");
    rmdir(app.c_str());
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadTests ignores 'tests' appearing inside a string value" *
          doctest::test_suite("config")) {
    // Guard against a naive strstr-based parser matching the substring inside
    // a description or similar field rather than a real top-level array.
    auto dir = make_temp_dir();
    write_file(dir + "/package.json",
               R"({"description":"contains \"tests\" in text","main":"./main.js"})");

    char** paths = nullptr;
    size_t count = 0;
    int rc = MIK_LoadTests(dir.c_str(), &paths, &count);

    CHECK_EQ(0, rc);
    CHECK_EQ((size_t)0, count);
    CHECK(paths == nullptr);

    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadTests ignores a 'tests' key inside a nested object" *
          doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json",
               R"({"scripts":{"tests":"vitest"},"main":"./main.js"})");

    char** paths = nullptr;
    size_t count = 0;
    int rc = MIK_LoadTests(dir.c_str(), &paths, &count);

    CHECK_EQ(0, rc);
    CHECK_EQ((size_t)0, count);

    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig reads mikro.config.json settings" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json", R"({"name": "test", "main": "./main.js"})");
    write_file(dir + "/mikro.config.json",
               R"({"onPanic.delay": 5000, "stackSize": 32768, "memReserved": 131072})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(5000, config.panic_restart_delay_ms);
    CHECK_EQ(MIK_PANIC_RESTART, config.panic_mode); /* default when mode absent */
    CHECK_EQ(32768, (int)config.stack_size);
    CHECK_EQ((uint32_t)131072, config.mem_reserved);

    remove_file(dir + "/mikro.config.json");
    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

TEST_CASE("MIK_LoadConfig reads onPanic deepSleep mode" * doctest::test_suite("config")) {
    auto dir = make_temp_dir();
    write_file(dir + "/package.json", R"({"name": "test", "main": "./main.js"})");
    write_file(dir + "/mikro.config.json",
               R"({"onPanic.mode": "deepSleep", "onPanic.delay": 0, "onPanic.duration": 600000})");

    MIKConfig config;
    MIK_LoadConfig(dir.c_str(), &config);

    CHECK_EQ(MIK_PANIC_DEEP_SLEEP, config.panic_mode);
    CHECK_EQ(0, config.panic_restart_delay_ms);
    CHECK_EQ(600000, config.panic_sleep_duration_ms);

    remove_file(dir + "/mikro.config.json");
    remove_file(dir + "/package.json");
    rmdir(dir.c_str());
}

#include <cstdio>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/app_store.h>

#include <doctest.h>

/* Helper: create a temporary directory and return its path */
static std::string make_temp_dir() {
    char tmpl[] = "/tmp/mik_app_store_test_XXXXXX";
    char* dir = mkdtemp(tmpl);
    return std::string(dir);
}

/* Helper: create a directory (and ignore if it exists) */
static void make_dir(const std::string& path) {
    mkdir(path.c_str(), 0755);
}

/* Helper: write a string to a file */
static void write_file(const std::string& path, const char* content) {
    FILE* f = fopen(path.c_str(), "w");
    fputs(content, f);
    fclose(f);
}

/* Helper: read a file into a string, or "" if it can't be opened */
static std::string read_file(const std::string& path) {
    FILE* f = fopen(path.c_str(), "r");
    if (!f) return "";
    std::string out;
    char buf[256];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        out.append(buf, n);
    }
    fclose(f);
    return out;
}

/* Helper: true if a path exists */
static bool exists(const std::string& path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0;
}

TEST_CASE("mik__app_commit promotes the staged app and removes temp/old" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/old.txt", "v1");
    make_dir(base + "/.deploy-tmp");
    make_dir(base + "/.deploy-tmp/app");
    write_file(base + "/.deploy-tmp/app/new.txt", "v2");

    CHECK_EQ(MIK_APP_COMMIT_OK, mik__app_commit(base.c_str(), false));

    CHECK_EQ(std::string("v2"), read_file(base + "/app/new.txt"));
    CHECK_FALSE(exists(base + "/app/old.txt"));
    CHECK_FALSE(exists(base + "/.deploy-tmp"));
    CHECK_FALSE(exists(base + "/.deploy-old"));
}

TEST_CASE("mik__app_recover restores after an interrupted swap" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/.deploy-old");
    write_file(base + "/.deploy-old/keep.txt", "v1");

    mik__app_recover(base.c_str());

    CHECK_EQ(std::string("v1"), read_file(base + "/app/keep.txt"));
    CHECK_FALSE(exists(base + "/.deploy-old"));
}

TEST_CASE("mik__app_recover cleans up a leftover old dir when app is present" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/keep.txt", "live");
    make_dir(base + "/.deploy-old");
    write_file(base + "/.deploy-old/stale.txt", "stale");

    mik__app_recover(base.c_str());

    CHECK_EQ(std::string("live"), read_file(base + "/app/keep.txt"));
    CHECK_FALSE(exists(base + "/.deploy-old"));
}

TEST_CASE("mik__app_commit with no staged app is a no-op" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/keep.txt", "v1");

    CHECK_EQ(MIK_APP_COMMIT_OK, mik__app_commit(base.c_str(), false));

    CHECK_EQ(std::string("v1"), read_file(base + "/app/keep.txt"));
}

/* A regular file at .deploy-old blocks the stash rename (POSIX: renaming a
 * directory onto a file fails with ENOTDIR) without needing directory
 * permissions, which a root test runner would ignore. */
TEST_CASE("mik__app_commit reports STASH_FAILED and leaves the live app" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/live.txt", "v1");
    make_dir(base + "/.deploy-tmp");
    make_dir(base + "/.deploy-tmp/app");
    write_file(base + "/.deploy-tmp/app/new.txt", "v2");
    write_file(base + "/.deploy-old", "not a directory");

    CHECK_EQ(MIK_APP_COMMIT_STASH_FAILED, mik__app_commit(base.c_str(), false));

    CHECK_EQ(std::string("v1"), read_file(base + "/app/live.txt"));
    CHECK_FALSE(exists(base + "/app/new.txt"));
    CHECK(exists(base + "/.deploy-tmp/app/new.txt"));

    unlink((base + "/.deploy-old").c_str());
}

/* With `erased` there is no stash step, so a regular file sitting at the live
 * app path makes the swap rename itself fail. */
TEST_CASE("mik__app_commit reports SWAP_FAILED when the swap rename fails" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    write_file(base + "/app", "not a directory");
    make_dir(base + "/.deploy-tmp");
    make_dir(base + "/.deploy-tmp/app");
    write_file(base + "/.deploy-tmp/app/new.txt", "v2");

    CHECK_EQ(MIK_APP_COMMIT_SWAP_FAILED, mik__app_commit(base.c_str(), true));

    CHECK_EQ(std::string("not a directory"), read_file(base + "/app"));
    CHECK(exists(base + "/.deploy-tmp/app/new.txt"));
}

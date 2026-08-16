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

/* The stash step succeeds but there is no staged app to swap in: the commit
 * must roll the stashed copy back so the device still has its app. This is
 * the power-cut-during-deploy protection in its pure form. */
TEST_CASE("mik__app_commit rolls back the stashed app when the swap fails" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/live.txt", "v1");
    make_dir(base + "/.deploy-tmp");
    make_dir(base + "/.deploy-tmp/app");
    write_file(base + "/.deploy-tmp/app/new.txt", "v2");
    /* read-only staging dir: the stash rename (writes <base>) succeeds, the
     * swap rename (must unlink from .deploy-tmp) fails */
    chmod((base + "/.deploy-tmp").c_str(), 0555);

    CHECK_EQ(MIK_APP_COMMIT_SWAP_FAILED, mik__app_commit(base.c_str(), false));

    chmod((base + "/.deploy-tmp").c_str(), 0755);
    CHECK_EQ(std::string("v1"), read_file(base + "/app/live.txt"));
    CHECK_FALSE(exists(base + "/.deploy-old"));
}

TEST_CASE("mik__app_recover covers every leftover-state combination" *
          doctest::test_suite("app_store")) {
    /* stale tmp only */
    {
        auto base = make_temp_dir();
        make_dir(base + "/app");
        write_file(base + "/app/live.txt", "v1");
        make_dir(base + "/.deploy-tmp");
        write_file(base + "/.deploy-tmp/half.txt", "partial");
        mik__app_recover(base.c_str());
        CHECK_EQ(std::string("v1"), read_file(base + "/app/live.txt"));
        CHECK_FALSE(exists(base + "/.deploy-tmp"));
    }
    /* everything present: keep app, drop old and tmp */
    {
        auto base = make_temp_dir();
        make_dir(base + "/app");
        write_file(base + "/app/live.txt", "v2");
        make_dir(base + "/.deploy-old");
        write_file(base + "/.deploy-old/live.txt", "v1");
        make_dir(base + "/.deploy-tmp");
        mik__app_recover(base.c_str());
        CHECK_EQ(std::string("v2"), read_file(base + "/app/live.txt"));
        CHECK_FALSE(exists(base + "/.deploy-old"));
        CHECK_FALSE(exists(base + "/.deploy-tmp"));
    }
    /* nothing present: recovery is a no-op */
    {
        auto base = make_temp_dir();
        mik__app_recover(base.c_str());
        CHECK_FALSE(exists(base + "/app"));
    }
}

TEST_CASE("recursive delete respects the depth cap and skips overlong names" *
          doctest::test_suite("app_store")) {
    auto base = make_temp_dir();
    make_dir(base + "/app");
    write_file(base + "/app/live.txt", "keep");

    /* .deploy-old nested deeper than kMaxDepth (32): the walk must stop at
     * the cap without recursing forever; leftovers past the cap are fine. */
    std::string deep = base + "/.deploy-old";
    make_dir(deep);
    for (int i = 0; i < 40; i++) {
        deep += "/d";
        make_dir(deep);
    }
    /* a child whose joined path would overflow the internal buffer gets
     * skipped rather than deleted under a truncated (wrong) path */
    std::string wide = base + "/.deploy-tmp";
    make_dir(wide);
    std::string long_name(200, 'x');
    for (int i = 0; i < 3; i++) {
        wide += "/" + long_name;
        make_dir(wide);
    }

    mik__app_recover(base.c_str());
    CHECK_EQ(std::string("keep"), read_file(base + "/app/live.txt"));
    /* no assertion on full removal: the guards deliberately leave the
     * unreachable tails in place instead of misbehaving */
}

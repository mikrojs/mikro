#include <fcntl.h>
#include <unistd.h>

#include <cstring>
#include <string>

#include <mikrojs/mikrojs.h>
#include <mikrojs/platform.h>

#include <doctest.h>

/* Direct tests for the default POSIX platform implementation. restart() is
 * deliberately not called: it exits the process. */

TEST_CASE("POSIX platform clocks, entropy, and memory stubs" *
          doctest::test_suite("platform")) {
    const MIKPlatform* p = MIK_DefaultPOSIXPlatform();
    REQUIRE(p != nullptr);

    int64_t boot = p->get_boot_us();
    CHECK(boot > 0);
    CHECK(p->get_rtc_us() >= boot);
    p->yield();
    CHECK(p->get_boot_us() > boot); /* yield sleeps ~1ms, the clock moves */

    /* two draws colliding is a 2^-32 event; treat as machine entropy check */
    uint32_t a = p->random();
    uint32_t b = p->random();
    CHECK((a != b || p->random() != a));

    /* desktop reports no system memory facts */
    CHECK(p->get_free_system_mem() == 0);
    CHECK(p->get_min_free_system_mem() == 0);
    CHECK(p->get_total_system_mem() == 0);
    CHECK(p->get_largest_free_system_mem() == 0);
    CHECK(p->get_free_internal_mem() == 0);
    CHECK(p->get_largest_free_internal_mem() == 0);

    /* no PSRAM: allocators refuse so callers fall back to libc */
    CHECK(p->malloc_psram(16) == nullptr);
    CHECK(p->calloc_psram(4, 4) == nullptr);
    CHECK(p->realloc_psram(nullptr, 16) == nullptr);

    size_t total = 0, used = 0;
    CHECK_FALSE(p->get_fs_info("user", &total, &used));

    CHECK(std::string(p->get_reset_reason()) == "unknown");
}

TEST_CASE("POSIX device id is stable and the name round-trips" *
          doctest::test_suite("platform")) {
    const MIKPlatform* p = MIK_DefaultPOSIXPlatform();

    const char* id1 = p->get_device_id();
    REQUIRE(id1 != nullptr);
    CHECK(strlen(id1) == 10); /* Crockford base32, 48 bits */
    CHECK(std::string(p->get_device_id()) == id1);

    /* process-local device name: set, replace, clear */
    p->set_device_name("host-name-test");
    REQUIRE(p->get_device_name() != nullptr);
    CHECK(std::string(p->get_device_name()) == "host-name-test");
    p->set_device_name("renamed");
    CHECK(std::string(p->get_device_name()) == "renamed");
    p->set_device_name(nullptr);
    CHECK(p->get_device_name() == nullptr);
}

TEST_CASE("POSIX stdio and log write without blocking" * doctest::test_suite("platform")) {
    const MIKPlatform* p = MIK_DefaultPOSIXPlatform();

    CHECK(p->stdout_write("", 0) == 0);
    CHECK(p->stderr_write("", 0) == 0);

    /* point stdin at /dev/null so the read returns EOF immediately */
    int saved = dup(fileno(stdin));
    REQUIRE(saved >= 0);
    int devnull = open("/dev/null", O_RDONLY);
    REQUIRE(devnull >= 0);
    REQUIRE(dup2(devnull, fileno(stdin)) >= 0);
    close(devnull);
    char buf[8];
    CHECK(p->stdin_read(buf, sizeof(buf)) == 0);
    dup2(saved, fileno(stdin));
    close(saved);

    /* levels outside the range are dropped, in-range ones print */
    p->log(MIK_LOG_ERROR - 1, "test", "must not print");
    p->log(MIK_LOG_VERBOSE + 1, "test", "must not print");
    p->log(MIK_LOG_DEBUG, "test", "platform log smoke %d", 7);
}

#pragma once

#include <doctest.h>
#include <unistd.h>

#include <cstdlib>
#include <string>

/* Makes a fresh directory named <name>_XXXXXX under $TMPDIR (or /tmp when it is unset) and returns
 * its path. /tmp is not writable everywhere (sandboxes, some CI), so the tests never hardcode it.
 * Fails the test when the directory can't be made. */
inline std::string mik_test_temp_dir(const char* name) {
    const char* tmp = getenv("TMPDIR");
    std::string path = tmp && *tmp ? tmp : "/tmp";
    if (path.back() != '/') {
        path += '/';
    }
    path += name;
    path += "_XXXXXX";
    REQUIRE(mkdtemp(path.data()) != nullptr);
    return path;
}

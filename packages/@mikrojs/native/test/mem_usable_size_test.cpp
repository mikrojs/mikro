#include <cstring>

#include <mikrojs/mem.h>

#include <doctest.h>

/* Hook-mode allocator coverage — the mode every ESP32 device runs in.
 * Host builds default to header mode (the posix/node platforms provide no
 * malloc_usable_size hook), so a fake hook is installed via the test-only
 * latch override and restored before the test ends. Pointers must not
 * cross a mode switch: the mode decides the allocation's offset. */

namespace {

size_t fake_usable_size(const void* ptr) {
    (void)ptr;
    return 4242;
}

}  // namespace

TEST_CASE("hook mode: allocations carry no header and usable size comes from the hook") {
    mik__usable_size_latch_override(fake_usable_size);

    void* p = mik__malloc(24);
    REQUIRE(p != nullptr);
    CHECK(mik__malloc_usable_size(p) == 4242);
    p = mik__realloc(p, 64);
    REQUIRE(p != nullptr);
    memset(p, 0xa5, 64); /* full requested size must be writable with no offset */
    CHECK(mik__malloc_usable_size(p) == 4242);
    mik__free(p);

    /* The JS-heap allocators share the latch. calloc must zero from byte 0 —
     * a stale header offset would leave the first word unzeroed. */
    void* q = mik__js_calloc(4, 8);
    REQUIRE(q != nullptr);
    static const char zeros[32] = {};
    CHECK(memcmp(q, zeros, 32) == 0);
    CHECK(mik__malloc_usable_size(q) == 4242);
    q = mik__js_realloc(q, 48);
    REQUIRE(q != nullptr);
    mik__free(q);

    mik__usable_size_latch_override(nullptr);

    /* Header mode restored: usable size is the requested size again. */
    void* h = mik__mallocz(24);
    REQUIRE(h != nullptr);
    CHECK(mik__malloc_usable_size(h) == 24);
    mik__free(h);
}

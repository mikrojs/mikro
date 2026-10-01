/* Stand-ins for what the OTA device files need and the host library lacks:
 * the build unpack (miniz) and the HTTP module's native request path. */

#include <cstdio>

#include <mikrojs/build_install.h>
#include <mikrojs/http_native.h>

#include "ota_stubs.h"

bool g_ota_stub_install_ok = true;
int g_ota_stub_installs = 0;
const char* g_ota_stub_sha = nullptr;

bool mik__sha256_file(const char*, char out[65]) {
    if (!g_ota_stub_sha) return false;
    snprintf(out, 65, "%s", g_ota_stub_sha);
    return true;
}

bool mik__install_build(const char*, const char*, const char** err, MIKBuildErr* kind) {
    g_ota_stub_installs++;
    if (g_ota_stub_install_ok) return true;
    *err = "stub install failure";
    *kind = MIK_BUILD_ERR_TRANSIENT;
    return false;
}

void mik__http_ensure_native(JSContext*) {}

uint32_t mik__http_start_native(MIKRuntime*, const MIKHttpNativeRequest*,
                                const MIKHttpNativeSink*) {
    return 0;
}

void mik__http_cancel_native(MIKRuntime*, uint32_t) {}

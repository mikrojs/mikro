#pragma once

/* Controls for the build-install stand-in in ota_stubs.cpp. */
extern bool g_ota_stub_install_ok;
extern int g_ota_stub_installs;
/* What the SHA-256 stand-in reports for any file; NULL fails the read. */
extern const char* g_ota_stub_sha;

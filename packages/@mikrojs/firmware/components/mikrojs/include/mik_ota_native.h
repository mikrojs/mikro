/* Internal wiring for the native OTA client (mikro/ota/client backed by C).
 * Not part of the public ESP API: only the OTA module and its env implementation
 * include this. */
#pragma once

#include "mikrojs/ota_env.h"

/* Fill the install-op slots with mik_ota.cpp's staging machinery — the same
 * cores the native:mikro/ota JS bindings call. */
void mik__ota_fill_install_ops(MIKOtaEnv* env);

/* The OTA environment for this runtime, fully populated (install ops, kv, HTTP,
 * identity, clock). Valid until the runtime is freed. `rt` is needed because the
 * HTTP seam borrows the http module's task and queue, which live per runtime.
 *
 * `bytecode_version` cannot be derived without a JSContext, so it is passed in
 * from the module init that has one. */
struct MIKRuntime;
const MIKOtaEnv* mik__ota_env_for(struct MIKRuntime* rt, int bytecode_version);

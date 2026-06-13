#pragma once

#include "quickjs.h"

/* Register the `native:mikro/udp` module on the given context.
 * Called explicitly from MIK_NewRuntime (see mikrojs.cpp). */
JSModuleDef* mik__udp_init(JSContext* ctx);

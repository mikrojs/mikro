/* Backward-compatible header — forwards to standalone library
 * and adds ESP32-specific declarations. */
#pragma once
#include <mikrojs/private.h>
#include "mikrojs_esp32.h"

/* Forward declarations for ESP32 module state types (needed by inline accessors
 * that appear before the full struct definitions in their respective .cpp files). */
struct MIKHttpState;
struct MIKWifiState;

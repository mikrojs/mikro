// Compile-time checks of the package-name rule for public modules and
// builtins: this file compiles only if the rule accepts these names.
#define MIK_PACKAGE_NAME "@acme/pi"
#include "mikrojs/mikrojs.h"

// The package's root export and a subpath are both its own names.
MIK__REQUIRE_BUILTIN_NS("@acme/pi");
MIK__REQUIRE_BUILTIN_NS("@acme/pi/fx");

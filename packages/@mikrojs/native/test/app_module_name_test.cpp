// Compile-time checks of the name rule for an app's own public modules: with
// no MIK_PACKAGE_NAME, this file compiles only if the rule accepts "#" names.
#include "mikrojs/mikrojs.h"

MIK__REQUIRE_PACKAGE_NS("#sensor");
MIK__REQUIRE_PACKAGE_NS("#native/sensor");

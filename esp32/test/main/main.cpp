#include <stdio.h>

#include "unity.h"

/* Defined by the mikrojs test component; weak so other test sets still link. */
__attribute__((weak)) void mik_test_print_failures();

extern "C" void app_main(void) {
    printf("\n#### Running all tests #####\n");
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
    if (mik_test_print_failures) mik_test_print_failures();
}
